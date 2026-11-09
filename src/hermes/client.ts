import { spawn } from "node:child_process";
import type { Logger } from "../logger.js";

export interface HermesRunResult {
  ok: boolean;
  /** Final answer of the agent (empty when the run failed). */
  text: string;
  error?: string;
  durationMs: number;
  model: string;
  usedFallback: boolean;
  stderr: string;
}

export interface HermesRunOptions {
  /**
   * The toolsets of the agent, separated by commas.
   *
   * The name of an MCP server is also a toolset (`mcp-<server>`), so `vault`
   * gives the agent the tools of the vault server and nothing else. The run
   * always names its toolsets: without the flag Hermes uses the whole set of
   * the platform, which includes the shell and the direct file tools.
   */
  toolsets?: string;
}

export interface HermesClientOptions {
  bin: string;
  model: string;
  fallbackModel: string;
  timeoutMs: number;
  maxTurns: number;
  /** Working directory of the agent, it contains the rules (`.hermes.md`). */
  workspace: string;
  env: NodeJS.ProcessEnv;
  logger: Logger;
  /** The toolsets of a note run. */
  toolsets?: string;
}

/**
 * The toolsets of a note run.
 *
 * The agent writes notes through the vault MCP server, which is the only thing
 * that knows how to write a note that survives Syncthing. It has no shell and
 * no direct file tools: a shell can write anywhere the process can, and the
 * direct file tools bypass the guard of the vault. The web tools are there
 * because the owner asks questions that need facts.
 */
export const NOTE_TOOLSETS = "vault,web";

/**
 * The variables the agent may see.
 *
 * Everything else is dropped, and the list is an allowlist on purpose: a new
 * secret in the environment of the bot must not reach the agent just because
 * nobody remembered to add it to a denylist. The variables below are the ones
 * Hermes needs to start, to find its home and to know the vault and the time
 * zone; none of them is a credential of the bot.
 */
const ALLOWED_ENV = new Set([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "HERMES_HOME",
  "HERMES_BIN",
  "OBSIDIAN_VAULT_PATH",
  "VAULT_EVENTS_FILE",
  "LOG_LEVEL",
  "PYTHONIOENCODING",
  "PYTHONUTF8",
  "UV_CACHE_DIR",
  "UV_PYTHON",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
]);

/**
 * The environment of the child process.
 *
 * Only the allowlisted variables are copied, and the values are copied as they
 * are: nothing is rewritten, so the agent behaves the same as before for the
 * variables it actually uses. The secrets of the bot are not in the list, so
 * the model key, the token of the Mini App, the secret of the webhook and the
 * token of the bot never reach the agent.
 */
export function agentEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!ALLOWED_ENV.has(name.toUpperCase())) continue;
    env[name] = value;
  }
  env.NO_COLOR = "1";
  env.TERM = "dumb";
  env.CI = "1";
  return env;
}

/**
 * Runs Hermes Agent as a child process.
 *
 * The agent is started in one shot mode (`hermes chat -q`), so every message
 * gets a fresh, isolated run: the vault itself is the memory of the bot. When
 * the primary model fails, the run is repeated with the fallback model.
 */
export class HermesClient {
  constructor(private readonly options: HermesClientOptions) {}

  async run(prompt: string, options: HermesRunOptions = {}): Promise<HermesRunResult> {
    const primary = await this.spawnOnce(prompt, this.options.model, options);
    if (primary.ok) {
      return { ...primary, model: this.options.model, usedFallback: false };
    }

    const fallbackModel = this.options.fallbackModel;
    if (!fallbackModel || fallbackModel === this.options.model) {
      return { ...primary, model: this.options.model, usedFallback: false };
    }

    this.options.logger.warn("primary model failed, trying the fallback model", {
      model: this.options.model,
      error: primary.error,
    });
    const fallback = await this.spawnOnce(prompt, fallbackModel, options);
    return { ...fallback, model: fallbackModel, usedFallback: true };
  }

  private spawnOnce(
    prompt: string,
    model: string,
    options: HermesRunOptions = {},
  ): Promise<Omit<HermesRunResult, "model" | "usedFallback">> {
    const startedAt = Date.now();
    // The prompt is the message of the owner. The null byte would break the
    // start of the process, and it means nothing in a text.
    const safePrompt = prompt.replace(/\0/g, "");
    // The toolsets are always named. Without the flag the agent runs with the
    // whole set of the platform, and that set has a shell.
    const toolsets = options.toolsets ?? this.options.toolsets ?? NOTE_TOOLSETS;
    // `hermes chat -q` runs one query in the working directory (the agent
    // workspace with the rules) and prints the final answer. The run is not
    // started in yolo mode: yolo turns off every approval, and the agent of a
    // note has no shell to need one.
    const args = [
      "chat",
      "-Q",
      "-q",
      safePrompt,
      "--max-turns",
      String(this.options.maxTurns),
      "--skills",
      "obsidian",
      "--toolsets",
      toolsets,
      "-m",
      model,
    ];

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;

      const child = spawn(this.options.bin, args, {
        cwd: this.options.workspace,
        env: agentEnv(this.options.env),
        stdio: ["ignore", "pipe", "pipe"],
      });

      const timer = setTimeout(() => {
        this.options.logger.warn("hermes run timed out, killing the process", {
          model,
          timeoutMs: this.options.timeoutMs,
        });
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5000).unref();
      }, this.options.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      const finish = (result: { ok: boolean; text: string; error?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          ...result,
          durationMs: Date.now() - startedAt,
          stderr: stderr.trim().slice(-4000),
        });
      };

      child.on("error", (error) => {
        finish({ ok: false, text: "", error: `could not start hermes: ${error.message}` });
      });

      child.on("close", (code) => {
        const text = cleanOutput(stdout);
        if (code === 0 && text) {
          finish({ ok: true, text });
          return;
        }
        finish({
          ok: false,
          text,
          error: `hermes exited with code ${code ?? "null"}${stderr ? `: ${stderr.trim().slice(-500)}` : ""}`,
        });
      });
    });
  }
}

/** Removes the banners and the trailing noise Hermes prints around the answer. */
function cleanOutput(raw: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape character is exactly what has to be removed
  const withoutAnsi = raw.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
  const lines = withoutAnsi
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  while (lines.length > 0 && isNoise(lines[lines.length - 1] as string)) {
    lines.pop();
  }
  return lines.join("\n").trim();
}

function isNoise(line: string): boolean {
  return /^(hermes|welcome|connecting|loading|session|session_id:|model:|provider:)/i.test(
    line.trim(),
  );
}
