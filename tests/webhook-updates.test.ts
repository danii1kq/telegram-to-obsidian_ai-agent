import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The list of the updates a webhook asks Telegram for.
 *
 * A webhook that does not list `callback_query` never receives the press of a
 * button: the owner chooses a language and nothing happens. The list lives in
 * the source of the entry point, and the test reads it there, because the call
 * to Telegram happens at the start of the process and cannot be made in a unit
 * test.
 */
describe("the updates of the webhook", () => {
  it("asks for the callback queries of the language buttons", async () => {
    const source = await readFile(path.join(process.cwd(), "src", "index.ts"), "utf8");

    // Every place that registers a webhook has to ask for both kinds.
    const registrations = source.match(/allowed_updates:\s*\[[^\]]*\]/g) ?? [];
    expect(registrations.length).toBeGreaterThan(0);

    for (const registration of registrations) {
      expect(registration).toContain('"message"');
      expect(registration).toContain('"callback_query"');
    }
  });
});
