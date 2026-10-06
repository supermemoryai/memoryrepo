import { convertToModelMessages, pruneMessages, type ModelMessage, type UIMessage } from "ai";

import type { Files } from "./vault.ts";

export type { Files };

/** A chat message as plain text, with when it was sent (the client stamps it with its timezone). */
export type TranscriptMessage = { id: string; role: string; text: string; at?: number; tz?: string };
type MessageMeta = { createdAt?: number; tz?: string };

export const metaOf = (m: UIMessage) => (m.metadata ?? {}) as MessageMeta;

export const textOf = (m: UIMessage) =>
  m.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");

export function transcriptOf(messages: UIMessage[]): TranscriptMessage[] {
  return messages.map((m) => {
    const { createdAt, tz } = metaOf(m);
    return { id: m.id, role: m.role, text: textOf(m), at: createdAt, tz };
  });
}

export function titleOf(messages: UIMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  const text = first ? textOf(first).replace(/\s+/g, " ").trim() : "";
  return text.length > 60 ? `${text.slice(0, 57)}…` : text || "New chat";
}

/** "2026-10-04 17:20 (America/Los_Angeles)": wall-clock time where the user was. */
export function stampOf(at: number, tz?: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(at));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}${tz ? ` (${tz})` : " UTC"}`;
  } catch {
    return `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  }
}

/**
 * UI messages → model messages, keeping reasoning only on the last one. Some providers persist an
 * encrypted reasoning blob on every assistant message; re-sending them all makes hidden reasoning,
 * not dialogue, dominate the context.
 */
export async function toModelMessages(messages: UIMessage[]): Promise<ModelMessage[]> {
  return pruneMessages({ messages: await convertToModelMessages(messages), reasoning: "before-last-message", emptyMessages: "remove" });
}

export type InboxThread = { id: string; title: string; messages: TranscriptMessage[]; cursor: string | null };

/**
 * What a dream reads: one markdown file per thread with the messages after its cursor
 * (the last message an earlier dream already saw), plus the new cursors.
 */
export function buildInbox(threads: InboxThread[]): { inbox: Files; cursors: Record<string, string> } {
  const inbox: Files = {};
  const cursors: Record<string, string> = {};
  for (const thread of threads) {
    const seen = thread.cursor ? thread.messages.findIndex((m) => m.id === thread.cursor) : -1;
    const fresh = thread.messages.slice(seen + 1).filter((m) => m.text.trim());
    if (fresh.length === 0) continue;
    inbox[`${thread.id}.md`] = [
      `# ${thread.title}`,
      "",
      ...fresh.map((m) => `## ${m.role} · ${m.id}${m.at ? ` · ${stampOf(m.at, m.tz)}` : ""}\n${m.text.trim()}\n`),
    ].join("\n");
    cursors[thread.id] = thread.messages[thread.messages.length - 1]!.id;
  }
  return { inbox, cursors };
}

/** `thread/<id>[#<messageId>]` or `note/<id>`, the formats of `[source: …]` metadata. */
export function parseSourceRef(ref: string): { thread: string; message?: string } | { note: string } | null {
  const note = ref.match(/note\/([a-z0-9]+)/i);
  if (note) return { note: note[1]! };
  const m = ref.match(/thread\/([a-z0-9]+)(?:#([\w-]+))?/i);
  return m ? { thread: m[1]!, message: m[2] } : null;
}

/** The cited message with a little context around it, for checking a source. */
export function sourceExcerpt(thread: { id: string; title: string }, messages: TranscriptMessage[], messageId?: string): string {
  const at = messageId ? messages.findIndex((x) => x.id === messageId) : -1;
  const window = at >= 0 ? messages.slice(Math.max(0, at - 3), at + 4) : messages.slice(-12);
  const body = window
    .map((x) => `## ${x.role}${x.at ? ` · ${stampOf(x.at, x.tz)}` : ""}${x.id === messageId ? " ← cited" : ""}\n${x.text.trim()}`)
    .join("\n\n");
  const note = messageId && at < 0 ? `(message ${messageId} not found; showing the end of the thread)\n\n` : "";
  return `# ${thread.title} (thread/${thread.id})\n\n${note}${body}`.slice(0, 8_000);
}
