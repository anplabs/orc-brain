/** HTTP + SSE client helpers for the `orc` CLI (thin client over the API, §9). */

/** Base URL of the local orchestrator API. */
export function baseUrl(): string {
  return process.env.ORC_URL ?? "http://127.0.0.1:4173";
}

/** Performs a JSON request against the API, throwing on non-2xx. */
export async function api<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(baseUrl() + path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const message = (body as { error?: string }).error ?? res.statusText;
    throw new Error(`${res.status} ${message}`);
  }
  return body as T;
}

/** A parsed Server-Sent Event. */
export interface ParsedSse {
  id?: string;
  event?: string;
  data: unknown;
}

/**
 * Opens the SSE stream and invokes `onEvent` for each event. Returns when the
 * stream closes or `signal` aborts. Uses the built-in fetch streaming body
 * (Node 22) — no EventSource dependency.
 */
export async function streamEvents(
  query: string,
  onEvent: (e: ParsedSse) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(baseUrl() + "/api/events" + query, {
    headers: { Accept: "text/event-stream" },
    signal,
  });
  if (!res.body) throw new Error("no response body for SSE stream");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      if (!frame.trim() || frame.startsWith(":")) continue;
      const parsed: ParsedSse = { data: null };
      for (const line of frame.split("\n")) {
        if (line.startsWith("id:")) parsed.id = line.slice(3).trim();
        else if (line.startsWith("event:")) parsed.event = line.slice(6).trim();
        else if (line.startsWith("data:")) {
          const raw = line.slice(5).trim();
          try {
            parsed.data = JSON.parse(raw);
          } catch {
            parsed.data = raw;
          }
        }
      }
      onEvent(parsed);
    }
  }
}
