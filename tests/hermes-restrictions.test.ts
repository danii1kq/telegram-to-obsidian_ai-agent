import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HermesClient } from "../src/hermes/client.js";
import { createLogger } from "../src/logger.js";

const logger = createLogger("error", "test");

/**
 * A06: the agent gets the environment it needs and nothing else.
 *
 * The fake agent is a Node script that prints its own environment as JSON, so
 * the test sees exactly what a child process of the bot would see. No real
 * Hermes, no model, no network.
 */
async function makeFakeAgent(root: string): Promise<void> {
  // The client runs `node chat ...`, so the entry point is a file named `chat`.
  const script = path.join(root, "chat");
  await writeFile(
    script,
    [
      "const env = {};",
      "for (const [key, value] of Object.entries(process.env)) env[key] = value;",
      'process.stdout.write("ENV:" + JSON.stringify(env) + "\\n");',
      'process.stdout.write("the answer of the agent\\n");',
      "process.exit(0);",
    ].join("\n"),
    "utf8",
  );
}

/** Runs the client against the fake agent and gives the environment it saw. */
async function runWith(env: NodeJS.ProcessEnv): Promise<Record<string, string>> {
  const root = await mkdtemp(path.join(tmpdir(), "hermes-env-"));
  // The client runs `node chat ...`, so the entry point is a file named `chat`.
  await makeFakeAgent(root);
  const client = new HermesClient({
    bin: process.execPath,
    model: "test-model",
    fallbackModel: "",
    timeoutMs: 10_000,
    maxTurns: 1,
    workspace: root,
    env,
    logger,
  });

  const result = await client.run("a message of the owner");
  expect(result.ok).toBe(true);
  const line = result.text.split("\n").find((value) => value.startsWith("ENV:"));
  expect(line).toBeTruthy();
  return JSON.parse((line as string).slice(4)) as Record<string, string>;
}

/** The secrets the agent must never see. */
const SECRETS = {
  LLM_API_KEY: "oc_sk_averyrealsecretvalue123456",
  MINI_APP_TOKEN: "the-token-of-the-browser",
  TELEGRAM_WEBHOOK_SECRET: "the-secret-of-the-webhook",
  TELEGRAM_BOT_TOKEN: "1234567890:AAHthebottokenvalue1234567890",
};

describe("A06: the environment of the agent", () => {
  it("does not pass the secrets of the bot to the agent", async () => {
    const seen = await runWith({
      PATH: process.env.PATH ?? "",
      ...SECRETS,
    });

    for (const name of Object.keys(SECRETS)) {
      expect(seen[name]).toBeUndefined();
    }
  });

  it("passes only the variables the agent needs", async () => {
    const seen = await runWith({
      PATH: process.env.PATH ?? "",
      HOME: "C:/Users/test",
      HERMES_HOME: "C:/Users/test/.hermes",
      OBSIDIAN_VAULT_PATH: "C:/vault",
      TZ: "Asia/Almaty",
      ...SECRETS,
    });

    // The ones the agent really uses are there.
    expect(seen.PATH).toBeTruthy();
    expect(seen.HERMES_HOME).toBe("C:/Users/test/.hermes");
    expect(seen.OBSIDIAN_VAULT_PATH).toBe("C:/vault");
    expect(seen.TZ).toBe("Asia/Almaty");
    // HOME is needed: Hermes looks for its own home under it.
    expect(seen.HOME).toBe("C:/Users/test");

    // An unrelated variable of the host does not travel along.
    expect(seen.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it("does not pass a variable that only looks harmless", async () => {
    const seen = await runWith({
      PATH: process.env.PATH ?? "",
      DATABASE_URL: "postgres://user:password@host/db",
      GITHUB_TOKEN: "ghp_averyrealtokenvalue1234567890",
      NPM_TOKEN: "npm_averyrealtoken",
    });

    expect(seen.DATABASE_URL).toBeUndefined();
    expect(seen.GITHUB_TOKEN).toBeUndefined();
    expect(seen.NPM_TOKEN).toBeUndefined();
  });
});

describe("A06: the flags of the agent", () => {
  it("does not run the agent in yolo mode", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hermes-args-"));
    // The client runs `node chat ...`, so the entry point is a file named `chat`.
    const script = path.join(root, "chat");
    await writeFile(
      script,
      [
        "const args = process.argv.slice(2);",
        'process.stdout.write("ARGS:" + JSON.stringify(args) + "\\n");',
        'process.stdout.write("the answer of the agent\\n");',
        "process.exit(0);",
      ].join("\n"),
      "utf8",
    );

    const client = new HermesClient({
      bin: process.execPath,
      model: "test-model",
      fallbackModel: "",
      timeoutMs: 10_000,
      maxTurns: 1,
      workspace: root,
      env: { PATH: process.env.PATH ?? "" },
      logger,
    });

    const result = await client.run("a message");
    const line = result.text.split("\n").find((value) => value.startsWith("ARGS:"));
    const args = JSON.parse((line as string).slice(5)) as string[];

    expect(args).not.toContain("--yolo");
    expect(args).not.toContain("-y");
    // The toolsets are always named, so the run never falls back to the full
    // set of the platform.
    expect(args).toContain("--toolsets");
  });

  it("names the toolsets of a note run", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "hermes-toolsets-"));
    // The client runs `node chat ...`, so the entry point is a file named `chat`.
    const script = path.join(root, "chat");
    await writeFile(
      script,
      [
        "const args = process.argv.slice(2);",
        'process.stdout.write("ARGS:" + JSON.stringify(args) + "\\n");',
        'process.stdout.write("the answer of the agent\\n");',
        "process.exit(0);",
      ].join("\n"),
      "utf8",
    );

    const client = new HermesClient({
      bin: process.execPath,
      model: "test-model",
      fallbackModel: "",
      timeoutMs: 10_000,
      maxTurns: 1,
      workspace: root,
      env: { PATH: process.env.PATH ?? "" },
      logger,
    });

    const result = await client.run("a message");
    const line = result.text.split("\n").find((value) => value.startsWith("ARGS:"));
    const args = JSON.parse((line as string).slice(5)) as string[];
    const toolsets = args[args.indexOf("--toolsets") + 1] ?? "";

    // The note run works with the vault and the web, and it has no shell and
    // no direct file tools: the vault MCP server is the only way to a note.
    expect(toolsets).toContain("vault");
    expect(toolsets).not.toContain("terminal");
    expect(toolsets).not.toContain("file");
    expect(toolsets).not.toContain("all");
  });
});
