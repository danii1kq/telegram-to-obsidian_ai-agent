import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/db/index.js";
import type { HermesClient } from "../src/hermes/client.js";
import { createLogger } from "../src/logger.js";
import { processMessage } from "../src/pipeline.js";
import { VaultGuard } from "../src/vault/guard.js";
import { VaultOperations } from "../src/vault/operations.js";

const logger = createLogger("error", "test");

/**
 * The whole chain of one message: the text goes to the agent, the agent writes
 * a note, the bot sees the write and the note lands in the vault with its
 * frontmatter and its tags.
 */
describe("the chain of a message", () => {
  it("writes the note of the agent with the tags", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "e2e-"));
    const vaultPath = path.join(root, "vault");
    const eventsFile = path.join(root, "events.json");

    const guard = new VaultGuard({ vaultRoot: vaultPath, settleDelayMs: 1, verifyDelayMs: 1 });
    const vault = new VaultOperations({
      guard,
      eventsFile,
      timeZone: "Asia/Almaty",
      logger,
    });
    const { client } = await createDatabase(path.join(root, "app.db"));

    // The agent: it looks for a note and writes one.
    const hermes = {
      run: async (prompt: string) => {
        expect(prompt).toContain("идея для бизнеса");
        await vault.writeNote("Идеи для бизнеса.md", "Продавать кофе на районе.");
        return {
          ok: true,
          text: "Создал заметку «Идеи для бизнеса»",
          durationMs: 10,
          model: "test",
          usedFallback: false,
          stderr: "",
        };
      },
    } as unknown as HermesClient;

    const config = {
      vault: { path: vaultPath, timeZone: "Asia/Almaty", eventsFile },
      hermes: { model: "test" },
    } as unknown as Parameters<typeof processMessage>[2]["config"];

    const result = await processMessage("идея для бизнеса #coffee", 1, {
      config,
      hermes,
      vault,
      logger,
    });

    expect(result.action).toBe("create");
    expect(result.title).toBe("Идеи для бизнеса");
    expect(result.usedFallback).toBe(false);

    const content = await readFile(path.join(vaultPath, "Идеи для бизнеса.md"), "utf8");
    expect(content).toContain("Продавать кофе на районе");
    expect(content).toContain("tags: [inbox, telegram, coffee]");
    expect(content).not.toMatch(/[—–‒―]/);

    client.close();
  });

  it("keeps the message when the agent fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "e2e-"));
    const vaultPath = path.join(root, "vault");

    const guard = new VaultGuard({ vaultRoot: vaultPath, settleDelayMs: 1, verifyDelayMs: 1 });
    const vault = new VaultOperations({
      guard,
      eventsFile: path.join(root, "events.json"),
      timeZone: "Asia/Almaty",
      logger,
    });
    const { client } = await createDatabase(path.join(root, "app.db"));

    const hermes = {
      run: async () => ({
        ok: false,
        text: "",
        error: "the model is not available",
        durationMs: 10,
        model: "test",
        usedFallback: false,
        stderr: "",
      }),
    } as unknown as HermesClient;

    const config = {
      vault: {
        path: vaultPath,
        timeZone: "Asia/Almaty",
        eventsFile: path.join(root, "events.json"),
      },
      hermes: { model: "test" },
    } as unknown as Parameters<typeof processMessage>[2]["config"];

    const result = await processMessage("мысль, которую нельзя потерять", 1, {
      config,
      hermes,
      vault,
      logger,
    });

    expect(result.usedFallback).toBe(true);
    expect(result.action).toBe("create");

    const content = await readFile(
      path.join(vaultPath, "мысль, которую нельзя потерять.md"),
      "utf8",
    );
    expect(content).toContain("мысль, которую нельзя потерять");

    client.close();
  });

  it("appends to the note of the topic, not to the first note that shares a word", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "e2e-"));
    const vaultPath = path.join(root, "vault");

    const guard = new VaultGuard({ vaultRoot: vaultPath, settleDelayMs: 1, verifyDelayMs: 1 });
    const vault = new VaultOperations({
      guard,
      eventsFile: path.join(root, "events.json"),
      timeZone: "Asia/Almaty",
      logger,
    });
    const { client } = await createDatabase(path.join(root, "app.db"));

    // "Workout plan" holds the word "work" as a part of a longer word, so a
    // search for "work" finds it as well as "Work meeting".
    await vault.createNoteFromTitle("Workout plan", "gym twice a week", "agent");
    await vault.createNoteFromTitle("Work meeting", "the team meets on monday", "agent");

    const hermes = {
      run: async () => ({
        ok: false,
        text: "",
        error: "the model is not available",
        durationMs: 10,
        model: "test",
        usedFallback: false,
        stderr: "",
      }),
    } as unknown as HermesClient;

    const config = {
      vault: {
        path: vaultPath,
        timeZone: "Asia/Almaty",
        eventsFile: path.join(root, "events.json"),
      },
      hermes: { model: "test" },
    } as unknown as Parameters<typeof processMessage>[2]["config"];

    const result = await processMessage("work meeting about the plan", 1, {
      config,
      hermes,
      vault,
      logger,
    });

    expect(result.usedFallback).toBe(true);
    expect(result.path).toBe("Work meeting.md");

    const workout = await readFile(path.join(vaultPath, "Workout plan.md"), "utf8");
    expect(workout).not.toContain("work meeting about the plan");

    client.close();
  });
});
