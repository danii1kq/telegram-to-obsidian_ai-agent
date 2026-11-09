/**
 * A small markdown renderer for the notes.
 *
 * The text of a note is never trusted, so everything is escaped before the
 * html is built. Only the marks of the notes are understood: the headings,
 * the lists, the quotes, the code, the links, the wiki links and the embeds
 * of the files. The result is cleaned once more, so a mark that is not
 * understood can never become a script.
 */
import DOMPurify from "dompurify";

const ALLOWED_TAGS = [
  "p",
  "br",
  "strong",
  "em",
  "code",
  "pre",
  "ul",
  "ol",
  "li",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "hr",
  "a",
  "img",
  "span",
];

const ALLOWED_ATTR = ["href", "src", "alt", "class", "title", "loading"];

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic"];

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The inline marks of a line of text. */
function renderInline(text: string): string {
  const placeholders: string[] = [];
  const masked = text.replace(
    /!\[\[([^\]]+)\]\]|\[\[([^\]]+)\]\]|`([^`]+)`/g,
    (_match, embed: string | undefined, wiki: string | undefined, code: string | undefined) => {
      if (embed !== undefined) {
        const name = embed.trim();
        const isImage = IMAGE_EXTENSIONS.some((extension) =>
          name.toLowerCase().endsWith(extension),
        );
        if (isImage) {
          // The picture goes through a placeholder like every other inline
          // mark. Returning the tag itself put it into the text that is
          // escaped next, so the tag arrived at the sanitizer as `&lt;img&gt;`
          // and the note showed the markup instead of the picture.
          //
          // The name is only a name: the address is built here, so a name that
          // looks like a scheme is a file name and nothing else.
          const url = `/api/file?path=${encodeURIComponent(`attachments/${name}`)}`;
          const html = `<img src="${url}" alt="${escapeHtml(name)}" loading="lazy" />`;
          placeholders.push(html);
          return `\u0000${placeholders.length - 1}\u0000`;
        }
        const link = `<a href="#" class="embed">${escapeHtml(name)}</a>`;
        placeholders.push(link);
        return `\u0000${placeholders.length - 1}\u0000`;
      }
      if (wiki !== undefined) {
        const link = `<a href="#" class="wiki">${escapeHtml(wiki.trim())}</a>`;
        placeholders.push(link);
        return `\u0000${placeholders.length - 1}\u0000`;
      }
      const html = `<code>${escapeHtml(code ?? "")}</code>`;
      placeholders.push(html);
      return `\u0000${placeholders.length - 1}\u0000`;
    },
  );

  let html = escapeHtml(masked);
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');

  // biome-ignore lint/suspicious/noControlCharactersInRegex: the placeholder is exactly what has to be found
  return html.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => {
    return placeholders[Number(index)] ?? "";
  });
}

/** Turns the text of a note into html. */
export function renderMarkdown(source: string): string {
  const html = buildHtml(source);
  // The last line of defence: only the marks of a note survive.
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "style", "formaction"],
  });
}

function buildHtml(source: string): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let ordered = false;
  let quote: string[] = [];
  let code: string[] = [];
  let inCode = false;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push(`<p>${paragraph.map((line) => renderInline(line)).join("<br />")}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (list.length === 0) return;
    const tag = ordered ? "ol" : "ul";
    const items = list.map((item) => `<li>${renderInline(item)}</li>`).join("");
    blocks.push(`<${tag}>${items}</${tag}>`);
    list = [];
  };

  const flushQuote = () => {
    if (quote.length === 0) return;
    blocks.push(
      `<blockquote>${quote.map((line) => renderInline(line)).join("<br />")}</blockquote>`,
    );
    quote = [];
  };

  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (inCode) {
        blocks.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        code = [];
      } else {
        flushAll();
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }

    if (line.trim() === "") {
      flushAll();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      const level = Math.min(3, (heading[1] ?? "#").length);
      blocks.push(`<h${level}>${renderInline(heading[2] ?? "")}</h${level}>`);
      continue;
    }

    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      flushAll();
      blocks.push("<hr />");
      continue;
    }

    const quoteLine = /^>\s?(.*)$/.exec(line);
    if (quoteLine) {
      flushParagraph();
      flushList();
      quote.push(quoteLine[1] ?? "");
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      flushQuote();
      const nextOrdered = Boolean(numbered);
      if (list.length > 0 && ordered !== nextOrdered) flushList();
      ordered = nextOrdered;
      list.push(bullet?.[1] ?? numbered?.[1] ?? "");
      continue;
    }

    flushList();
    flushQuote();
    paragraph.push(line);
  }

  if (inCode && code.length > 0) {
    blocks.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
  }
  flushAll();

  return blocks.join("\n");
}
