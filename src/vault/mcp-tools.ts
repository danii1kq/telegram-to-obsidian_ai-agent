import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createLogger } from "../logger.js";
import { VaultGuard } from "./guard.js";
import { VaultOperations } from "./operations.js";
import { VaultWatcher } from "./watcher.js";

/**
 * The MCP server of the Obsidian vault.
 *
 * The tools are the same ones the Obsidian skill describes (search_files,
 * read_file, write_file) plus an append tool, but every write goes through
 * the vault guard: atomic rename, retry on a locked file and verification
 * after the write. This is what makes the notes safe to sync with Syncthing.
 */

const TOOLS = [
  {
    name: "search_files",
    description:
      "Search the Obsidian vault. Use target 'files' to find notes by name, target 'content' to search inside notes. The pattern is a plain substring. Returns the matching note paths.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", enum: ["files", "content"], description: "files or content" },
        pattern: { type: "string", description: "glob or plain substring" },
        path: { type: "string", description: "absolute or vault relative folder to search in" },
        file_glob: {
          type: "string",
          description: "only match files with this glob, for example *.md",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "read_file",
    description: "Read a note from the Obsidian vault. Returns its full content.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "absolute or vault relative path of the note" },
      },
      required: ["path"],
    },
  },
  {
    name: "list_notes",
    description: "List all markdown notes of the Obsidian vault, most recently changed first.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "optional folder to list" },
      },
    },
  },
  {
    name: "write_file",
    description:
      "Create a new note in the Obsidian vault. Use this for a note that does not exist yet. An existing note is never overwritten: to add to it, use the append tool. New notes get the frontmatter automatically when it is missing.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "absolute or vault relative path of the note" },
        content: { type: "string", description: "full markdown content of the note" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "append",
    description:
      "Append a block of text to the end of a note without touching the existing content. Use this to add a new entry to an existing note.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "absolute or vault relative path of the note" },
        content: { type: "string", description: "text to append" },
      },
      required: ["path", "content"],
    },
  },
] as const;

/**
 * Starts the MCP server on the standard input and output.
 *
 * The stdout of an MCP server is the protocol channel, the logs go to stderr.
 */
export async function runMcpServer(): Promise<void> {
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
  if (!vaultPath) {
    process.stderr.write("OBSIDIAN_VAULT_PATH is not set\n");
    process.exit(1);
  }

  const logger = createLogger((process.env.LOG_LEVEL as "info") ?? "info", "mcp:vault", "stderr");
  const watcher = new VaultWatcher(vaultPath);
  watcher.start();

  const guard = new VaultGuard({
    vaultRoot: vaultPath,
    retryDelayMs: Number(process.env.VAULT_RETRY_DELAY_MS ?? 500),
    maxAttempts: Number(process.env.VAULT_MAX_ATTEMPTS ?? 5),
    settleDelayMs: Number(process.env.VAULT_SETTLE_DELAY_MS ?? 1000),
    watcher,
  });

  const operations = new VaultOperations({
    guard,
    eventsFile: process.env.VAULT_EVENTS_FILE ?? "/app/data/vault-events.json",
    timeZone: process.env.TIMEZONE ?? "Asia/Almaty",
    logger,
  });

  const server = new Server(
    { name: "obsidian-vault", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    const text = (value: string) => ({
      content: [{ type: "text" as const, text: value }],
    });

    try {
      switch (name) {
        case "search_files": {
          const hits = await operations.searchFiles({
            target: args.target === "content" ? "content" : "files",
            pattern: String(args.pattern ?? ""),
            path: args.path ? String(args.path) : undefined,
            file_glob: args.file_glob ? String(args.file_glob) : undefined,
          });
          return text(
            hits.length === 0
              ? "No matches."
              : hits
                  .map((hit) =>
                    hit.line
                      ? `${hit.relativePath}:${hit.line} ${hit.snippet ?? ""}`.trim()
                      : hit.relativePath,
                  )
                  .join("\n"),
          );
        }
        case "read_file": {
          const file = await operations.readFile(String(args.path ?? ""));
          return text(file.content);
        }
        case "list_notes": {
          const notes = await operations.listNotes(args.path ? String(args.path) : undefined);
          return text(
            notes.length === 0
              ? "The vault is empty."
              : notes.map((note) => note.relativePath).join("\n"),
          );
        }
        case "write_file": {
          // A note that already exists is never overwritten by the agent. The
          // prompt asks for an append, and this is the code that makes the
          // ask true: an overwrite of a note the owner may be editing in
          // Obsidian is exactly the loss the guard cannot undo.
          const target = String(args.path ?? "");
          const existing = await operations.readFile(target).catch(() => null);
          if (existing) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `The note ${existing.relativePath} exists already. Use the append tool to add to it: an existing note is never overwritten.`,
                },
              ],
              isError: true,
            };
          }
          const result = await operations.writeNote(target, String(args.content ?? ""));
          return text(
            `Saved ${result.relativePath} (${result.action}, ${result.bytes} bytes, verified: ${result.verified}).`,
          );
        }
        case "append": {
          const result = await operations.appendNote(
            String(args.path ?? ""),
            String(args.content ?? ""),
          );
          return text(
            `Appended to ${result.relativePath} (${result.bytes} bytes, verified: ${result.verified}).`,
          );
        }
        default:
          return {
            content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("tool call failed", { tool: name, error: message });
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  await server.connect(new StdioServerTransport());
  logger.info("vault MCP server ready", { vault: vaultPath });
}
