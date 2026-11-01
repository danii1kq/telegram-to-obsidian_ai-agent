import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  exchangeToken,
  fetchConfig,
  fetchNote,
  fetchNotes,
  fetchSummaries,
  fileToken,
  type NoteSummary,
  type SearchHit,
  type SummaryEntry,
  searchNotes,
} from "./api";
import {
  AlertIcon,
  BackIcon,
  ChevronIcon,
  CloseIcon,
  InboxIcon,
  NoteIcon,
  ReportIcon,
  RetryIcon,
  SearchIcon,
} from "./icons";
import { renderMarkdown } from "./markdown";
import { type Language, type Texts, texts } from "./texts";

type View = { name: "list" } | { name: "note"; path: string; title: string };

const telegram = window.Telegram?.WebApp;

function haptic(kind: "light" | "medium" | "success" = "light"): void {
  try {
    if (kind === "success") telegram?.HapticFeedback.notificationOccurred("success");
    else telegram?.HapticFeedback.impactOccurred(kind);
  } catch {
    // The haptics are not everywhere.
  }
}

export default function App() {
  const [view, setView] = useState<View>({ name: "list" });
  const [query, setQuery] = useState("");
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [summaries, setSummaries] = useState<SummaryEntry[]>([]);
  const [botUsername, setBotUsername] = useState("");
  const [language, setLanguage] = useState<Language>("en");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const t = texts(language);

  const loadNotes = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setNotes(await fetchNotes(80));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "the notes could not be loaded");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    telegram?.ready();
    telegram?.expand();
    // The header of Telegram takes the colour of the app, so there is no seam.
    try {
      if (telegram?.themeParams?.bg_color) {
        telegram.setHeaderColor?.(telegram.themeParams.bg_color);
      }
    } catch {
      // The colour of the header is not important enough to fail for.
    }
    void loadNotes();
    fetchSummaries()
      .then(setSummaries)
      .catch(() => setSummaries([]));
    fetchConfig()
      .then((config) => {
        setBotUsername(config.botUsername);
        setLanguage(config.language);
      })
      .catch(() => setBotUsername(""));
  }, [loadNotes]);

  // The token of the owner is exchanged for a session and taken out of the
  // address, so it does not stay in the history of the browser.
  useEffect(() => {
    const token = fileToken;
    if (!token) return;
    void exchangeToken(token).then((ok) => {
      if (!ok) return;
      const url = new URL(window.location.href);
      url.searchParams.delete("token");
      window.history.replaceState({}, "", url.toString());
    });
  }, []);

  // The search waits for a pause in the typing. A slow answer for an older
  // query must not overwrite the hits of the query the owner sees now, so the
  // effect cleans up after itself and only the last query lands.
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      searchNotes(trimmed)
        .then((result) => {
          if (!cancelled) setHits(result);
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  // The back button of Telegram leads back to the list.
  useEffect(() => {
    if (view.name !== "note") return;
    telegram?.BackButton.show();
    const handler = () => setView({ name: "list" });
    telegram?.BackButton.onClick(handler);
    return () => {
      telegram?.BackButton.offClick(handler);
      telegram?.BackButton.hide();
    };
  }, [view.name]);

  const openNote = (path: string, title: string) => {
    haptic();
    setView({ name: "note", path, title });
  };

  const searching = query.trim().length > 0;

  return (
    <div className="app">
      {view.name === "list" ? (
        <>
          <header className="header">
            <h1 className="title">{t.title}</h1>
            <p className="subtitle">{loading ? t.loading : t.notesCount(notes.length)}</p>
            <div className="search">
              <SearchIcon size={18} />
              <input
                type="search"
                inputMode="search"
                placeholder={t.search}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label={t.search}
              />
              {query ? (
                <button
                  className="clear"
                  type="button"
                  onClick={() => {
                    setQuery("");
                    haptic();
                  }}
                  aria-label={t.clearSearch}
                >
                  <CloseIcon size={16} />
                </button>
              ) : null}
            </div>
          </header>

          {error ? (
            <State
              t={t}
              icon={<AlertIcon size={26} />}
              danger
              title={t.errorTitle}
              hint={error}
              action={
                <button className="action" type="button" onClick={() => void loadNotes()}>
                  <RetryIcon size={18} />
                  {t.retry}
                </button>
              }
            />
          ) : loading ? (
            <div className="list">
              <div className="skeleton" />
              <div className="skeleton" />
              <div className="skeleton" />
            </div>
          ) : searching ? (
            <HitList t={t} hits={hits} onOpen={openNote} />
          ) : notes.length === 0 ? (
            <State
              t={t}
              icon={<InboxIcon size={26} />}
              title={t.emptyTitle}
              hint={t.emptyHint}
              action={
                botUsername ? (
                  <button className="action" type="button" onClick={() => openBotChat(botUsername)}>
                    {t.writeToBot}
                  </button>
                ) : undefined
              }
            />
          ) : (
            <>
              <SummaryCard t={t} language={language} summaries={summaries} onOpen={openNote} />
              <NoteList t={t} language={language} notes={notes} onOpen={openNote} />
            </>
          )}
        </>
      ) : (
        <NoteView
          t={t}
          path={view.path}
          title={view.title}
          onBack={() => setView({ name: "list" })}
        />
      )}
    </div>
  );
}

/** Opens the chat with the bot, from the Mini App or from the browser. */
function openBotChat(username: string): void {
  const url = `https://t.me/${username}`;
  if (telegram?.openTelegramLink) {
    telegram.openTelegramLink(url);
    return;
  }
  window.open(url, "_blank", "noopener");
}

function SummaryCard({
  t,
  language,
  summaries,
  onOpen,
}: {
  t: Texts;
  language: Language;
  summaries: SummaryEntry[];
  onOpen: (path: string, title: string) => void;
}) {
  const latest = summaries[0];
  if (!latest) return null;

  return (
    <ul className="list">
      <li>
        <button
          className="card card-summary"
          type="button"
          onClick={() => onOpen(latest.file, t.summaryOfDay)}
          aria-label={`${t.summaryOfDay}, ${formatDate(latest.date, language)}`}
        >
          <span className="card-icon">
            <ReportIcon size={20} />
          </span>
          <span className="card-body">
            <span className="card-title">{t.summaryOfDay}</span>
            <span className="card-meta">
              <span>{formatDate(latest.date, language)}</span>
              {summaries.length > 1 ? <span>{t.days(summaries.length)}</span> : null}
            </span>
            <span className="card-snippet">{latest.summary}</span>
          </span>
          <span className="card-chevron">
            <ChevronIcon size={18} />
          </span>
        </button>
      </li>
    </ul>
  );
}

function NoteList({
  t,
  language,
  notes,
  onOpen,
}: {
  t: Texts;
  language: Language;
  notes: NoteSummary[];
  onOpen: (path: string, title: string) => void;
}) {
  return (
    <ul className="list">
      {notes.map((note) => (
        <li key={note.path}>
          <button
            className="card"
            type="button"
            onClick={() => onOpen(note.path, note.title)}
            aria-label={t.openNote(note.title)}
          >
            <span className="card-icon">
              <NoteIcon size={20} />
            </span>
            <span className="card-body">
              <span className="card-title">{note.title}</span>
              <span className="card-meta">
                {note.date ? <span>{formatDate(note.date, language)}</span> : null}
                {note.tags.slice(0, 3).map((tag) => (
                  <span className="chip" key={tag}>
                    #{tag}
                  </span>
                ))}
              </span>
              {note.snippet ? <span className="card-snippet">{note.snippet}</span> : null}
            </span>
            <span className="card-chevron">
              <ChevronIcon size={18} />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function HitList({
  t,
  hits,
  onOpen,
}: {
  t: Texts;
  hits: SearchHit[];
  onOpen: (path: string, title: string) => void;
}) {
  if (hits.length === 0) {
    return (
      <State t={t} icon={<SearchIcon size={26} />} title={t.notFoundTitle} hint={t.notFoundHint} />
    );
  }

  return (
    <ul className="list">
      {hits.map((hit) => (
        <li key={hit.path}>
          <button
            className="card"
            type="button"
            onClick={() => onOpen(hit.path, hit.title)}
            aria-label={t.openNote(hit.title)}
          >
            <span className="card-icon">
              <NoteIcon size={20} />
            </span>
            <span className="card-body">
              <span className="card-title">{hit.title}</span>
              <span className="card-meta">
                <span>{hit.path}</span>
                {hit.line ? <span>{hit.line}</span> : null}
              </span>
              {hit.snippet ? <span className="card-snippet">{hit.snippet}</span> : null}
            </span>
            <span className="card-chevron">
              <ChevronIcon size={18} />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function State({
  icon,
  title,
  hint,
  action,
  danger = false,
}: {
  t: Texts;
  icon: React.ReactNode;
  title: string;
  hint: string;
  action?: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <div className="state">
      <span className={danger ? "state-icon state-icon-danger" : "state-icon"}>{icon}</span>
      <span className="state-title">{title}</span>
      <span className="state-hint">{hint}</span>
      {action}
    </div>
  );
}

function NoteView({
  t,
  path,
  title,
  onBack,
}: {
  t: Texts;
  path: string;
  title: string;
  onBack: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    fetchNote(path)
      .then((note) => {
        if (mounted.current) setContent(note.content);
      })
      .catch((cause: unknown) => {
        if (mounted.current) {
          setError(cause instanceof Error ? cause.message : "the note could not be opened");
        }
      });
    return () => {
      mounted.current = false;
    };
  }, [path]);

  const html = useMemo(() => {
    if (!content) return "";
    // The frontmatter of the note is not shown to the reader.
    const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
    return renderMarkdown(body, fileToken);
  }, [content]);

  return (
    <div className="note">
      <button
        className="back"
        type="button"
        onClick={() => {
          haptic();
          onBack();
        }}
      >
        <BackIcon size={18} />
        {t.back}
      </button>
      <h1 className="note-title">{title}</h1>
      {error ? (
        <State t={t} icon={<AlertIcon size={26} />} danger title={t.openErrorTitle} hint={error} />
      ) : content === null ? (
        <div className="list">
          <div className="skeleton" />
          <div className="skeleton" />
        </div>
      ) : (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: the renderer escapes the text of the note, only the marks of the note become html
        <div className="note-body" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
}

/** The date of a note in the language of the app. */
function formatDate(value: string, language: Language): string {
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(language === "ru" ? "ru-RU" : "en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}
