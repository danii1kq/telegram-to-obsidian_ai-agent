export interface NoteSummary {
  path: string;
  title: string;
  date: string;
  tags: string[];
  snippet: string;
  size: number;
  mtimeMs: number;
}

export interface SearchHit {
  path: string;
  title: string;
  line: number | null;
  snippet: string;
}

export interface NoteFile {
  path: string;
  content: string;
  bytes: number;
}

export interface SummaryEntry {
  date: string;
  summary: string;
  file: string;
}

import type { Language } from "./texts";

/** The token of the owner, when the app is opened in a browser. */
export const fileToken = new URLSearchParams(window.location.search).get("token") ?? "";

function headers(): Record<string, string> {
  const result: Record<string, string> = { "content-type": "application/json" };
  const initData = window.Telegram?.WebApp?.initData;
  if (initData) result["x-telegram-init-data"] = initData;
  if (fileToken) result["x-auth-token"] = fileToken;
  return result;
}

async function request<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: headers() });
  if (!response.ok) {
    throw new Error(`the server answered with ${response.status}`);
  }
  const payload = (await response.json()) as { ok: boolean; error?: string } & T;
  if (!payload.ok) throw new Error(payload.error ?? "the server did not answer");
  return payload;
}

/** The notes of the vault, the newest first. */
export async function fetchNotes(
  limit = 60,
  offset = 0,
): Promise<{ notes: NoteSummary[]; total: number; hasMore: boolean }> {
  const payload = await request<{ notes: NoteSummary[]; total: number; hasMore: boolean }>(
    `/api/notes?limit=${limit}&offset=${offset}`,
  );
  return {
    notes: payload.notes,
    total: payload.total ?? payload.notes.length,
    hasMore: payload.hasMore ?? false,
  };
}

/** One note with its text. */
export async function fetchNote(path: string): Promise<NoteFile> {
  const payload = await request<{ note: NoteFile }>(`/api/note?path=${encodeURIComponent(path)}`);
  return payload.note;
}

/** The notes that match a query. */
export async function searchNotes(query: string): Promise<SearchHit[]> {
  const payload = await request<{ hits: SearchHit[] }>(
    `/api/search?q=${encodeURIComponent(query)}`,
  );
  return payload.hits;
}

/** The summaries of the days, the newest first. */
export async function fetchSummaries(): Promise<SummaryEntry[]> {
  const payload = await request<{ summaries: SummaryEntry[] }>("/api/summaries");
  return payload.summaries;
}

/** The settings of the app, the name of the bot and the language. */
export async function fetchConfig(): Promise<{ botUsername: string; language: Language }> {
  const payload = await request<{ botUsername: string; language: Language }>("/api/config");
  return payload;
}

/**
 * Exchanges the token of the owner for a session.
 *
 * The token is in the address of the page, so it is given to the server once
 * and taken out of the address: from then on the session cookie carries the
 * access.
 */
export async function exchangeToken(token: string): Promise<boolean> {
  try {
    const response = await fetch("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
