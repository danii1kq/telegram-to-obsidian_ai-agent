import { describe, expect, it } from "vitest";
import { buildPrompt } from "../src/hermes/prompt.js";
import { deriveTitle, extractKeywords } from "../src/pipeline.js";

describe("buildPrompt", () => {
  it("contains the message, the time and the existing notes", () => {
    const prompt = buildPrompt("Купить кофе", {
      now: new Date("2026-10-20T12:00:00Z"),
      timeZone: "Asia/Almaty",
      vaultPath: "/vault",
      noteTitles: ["Дневник", "Покупки"],
    });

    expect(prompt).toContain("Купить кофе");
    expect(prompt).toContain("2026-10-20 17:00");
    expect(prompt).toContain("/vault");
    expect(prompt).toContain('"Дневник"');
  });

  it("says that the vault is empty when there are no notes", () => {
    const prompt = buildPrompt("Первая мысль", {
      now: new Date("2026-10-20T12:00:00Z"),
      timeZone: "Asia/Almaty",
      vaultPath: "/vault",
      noteTitles: [],
    });

    expect(prompt).toContain("Хранилище пока пустое");
  });
});

describe("deriveTitle", () => {
  it("uses the first words of the message", () => {
    expect(deriveTitle("Идея для бизнеса: продавать кофе")).toBe(
      "Идея для бизнеса: продавать кофе",
    );
  });

  it("cuts long messages", () => {
    const title = deriveTitle("a".repeat(200));
    expect(title.length).toBeLessThanOrEqual(60);
  });

  it("has a fallback for an empty message", () => {
    expect(deriveTitle("   ")).toBe("Note");
    expect(deriveTitle("   ", "ru")).toBe("Заметка");
  });
});

describe("extractKeywords", () => {
  it("skips short and common words", () => {
    const keywords = extractKeywords("Это моя идея для нового продукта");
    expect(keywords).toContain("идея");
    expect(keywords).not.toContain("это");
  });
});
