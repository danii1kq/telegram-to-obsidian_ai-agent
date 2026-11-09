import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/markdown";

/**
 * A12: the marks of a note become elements, not text.
 *
 * The renderer escapes the text of the note before it builds the html, which
 * is right for the text and wrong for the marks: the image branch returned a
 * raw `<img>` into the string that was escaped next, so the tag arrived at the
 * sanitizer as `&lt;img&gt;` and the note showed the markup instead of the
 * picture.
 */

describe("A12: the images of a note", () => {
  it("turns an Obsidian embed of a picture into a real img element", () => {
    const html = renderMarkdown("![[2026-11-09_photo.jpg]]");

    expect(html).toContain("<img");
    expect(html).not.toContain("&lt;img");
    expect(html).toContain('src="/api/file?path=attachments%2F2026-11-09_photo.jpg"');
    expect(html).toContain('alt="2026-11-09_photo.jpg"');
  });

  it("keeps the lazy loading of the picture", () => {
    const html = renderMarkdown("![[photo.png]]");
    expect(html).toContain('loading="lazy"');
  });

  it("does not put the token of the owner into the address of the picture", () => {
    // The token is exchanged for a session on the first load, and the session
    // is a cookie: the address of a picture must not carry the token again.
    const html = renderMarkdown("![[photo.jpg]]");
    expect(html).not.toContain("token=");
  });

  it("keeps an embed of a document as a link", () => {
    const html = renderMarkdown("![[report.pdf]]");
    expect(html).toContain('class="embed"');
    expect(html).toContain("report.pdf");
    expect(html).not.toContain("<img");
  });

  it("keeps a wiki link as a link", () => {
    const html = renderMarkdown("see [[Another note]] for the details");
    expect(html).toContain('class="wiki"');
    expect(html).toContain("Another note");
  });

  it("still escapes the text of the note", () => {
    const html = renderMarkdown("<script>alert(1)</script> and <b>bold</b>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b>");
  });

  it("does not let a picture address become a script", () => {
    const html = renderMarkdown("![[javascript:alert(1).jpg]]");
    // The name is only a name: it lands in the alt text and in the query of
    // our own endpoint, never in the scheme of the address.
    expect(html).toContain('src="/api/file?path=attachments%2F');
    expect(html).not.toContain('src="javascript:');
    expect(html).not.toContain("<script");
  });

  it("renders a picture inside a paragraph next to text", () => {
    const html = renderMarkdown("a thought ![[photo.webp]] and more text");
    expect(html).toContain("<img");
    expect(html).toContain("a thought");
    expect(html).toContain("and more text");
  });

  it("renders a picture inside a list item", () => {
    const html = renderMarkdown("- a picture ![[photo.gif]]");
    expect(html).toContain("<li>");
    expect(html).toContain("<img");
  });

  it("renders a picture inside a quote", () => {
    const html = renderMarkdown("> a picture ![[photo.jpeg]]");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<img");
  });
});
