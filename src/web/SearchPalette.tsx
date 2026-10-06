import { Fragment, useEffect, useRef, useState } from "react";
import type { SearchHit } from "../server/memory-agent.ts";
import type { Memory } from "./App.tsx";

type Result = { hits: SearchHit[]; ms: number; indexed: { messages: number; files: number } };

/** Render an FTS snippet: ⟦match⟧ markers become <mark>. Text is inserted as text, never HTML. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(⟦[^⟧]*⟧)/g);
  return (
    <span className="snippet">
      {parts.map((p, i) => (p.startsWith("⟦") ? <mark key={i}>{p.slice(1, -1)}</mark> : <Fragment key={i}>{p}</Fragment>))}
    </span>
  );
}

/**
 * ⌘K full-text search over raw conversations and the wiki (repo-backed strategies' files).
 * SQLite FTS5 in the user's MemoryAgent; indexes sync lazily on search.
 */
export function SearchPalette({
  memory,
  onClose,
  onOpenMessage,
  onOpenFile,
  onOpenNote,
}: {
  memory: Memory;
  onClose: () => void;
  onOpenMessage: (thread: string, msgId: string) => void;
  onOpenFile: (path: string) => void;
  onOpenNote: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const id = ++seq.current;
    if (!q.trim()) {
      setResult(null);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      memory.stub.search(q).then(
        (r) => {
          if (id !== seq.current) return;
          setResult(r);
          setCursor(0);
          setLoading(false);
          setError(null);
        },
        (e: unknown) => {
          if (id !== seq.current) return;
          setError(String(e));
          setLoading(false);
        },
      );
    }, 180);
    return () => clearTimeout(timer);
  }, [memory, q]);

  const hits = result?.hits ?? [];
  const open = (h: SearchHit) => {
    if (h.kind === "message") onOpenMessage(h.thread, h.msgId);
    else if (h.kind === "note") onOpenNote(h.note);
    else onOpenFile(h.path);
    onClose();
  };
  const wiki = hits.filter((h) => h.kind === "wiki");
  const notes = hits.filter((h) => h.kind === "note");
  const messages = hits.filter((h) => h.kind === "message");

  return (
    <div className="modal search-modal" onClick={onClose}>
      <div className="modal-card search-card" onClick={(e) => e.stopPropagation()}>
        <input
          className="input search-input"
          autoFocus
          placeholder="Search memory, notes and conversations…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(hits.length - 1, c + 1));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(0, c - 1));
            }
            if (e.key === "Enter" && hits[cursor]) open(hits[cursor]!);
          }}
        />
        <div className="search-meta mono">
          {loading
            ? "searching…"
            : error
              ? error
              : result
                ? `${hits.length} hits · ${result.ms}ms · index: ${result.indexed.messages.toLocaleString()} messages, ${result.indexed.files} files`
                : "full-text (SQLite FTS5, porter stemming) · every word must match, last word as prefix"}
        </div>
        <div className="search-results">
          {wiki.length > 0 && <div className="label search-group">memory · {wiki.length}</div>}
          {wiki.map((h) => {
            const i = hits.indexOf(h);
            return (
              <button key={`w-${h.path}`} className={`search-hit ${i === cursor ? "active" : ""}`} onMouseEnter={() => setCursor(i)} onClick={() => open(h)}>
                <span className="search-hit-top mono">
                  {h.path}
                </span>
                <Snippet text={h.snippet} />
              </button>
            );
          })}
          {notes.length > 0 && <div className="label search-group">notes · {notes.length}</div>}
          {notes.map((h) => {
            const i = hits.indexOf(h);
            return (
              <button key={`n-${h.note}`} className={`search-hit ${i === cursor ? "active" : ""}`} onMouseEnter={() => setCursor(i)} onClick={() => open(h)}>
                <span className="search-hit-top mono">{h.title}</span>
                <Snippet text={h.snippet} />
              </button>
            );
          })}
          {messages.length > 0 && <div className="label search-group">conversations · {messages.length}</div>}
          {messages.map((h) => {
            const i = hits.indexOf(h);
            return (
              <button key={`m-${h.msgId}`} className={`search-hit ${i === cursor ? "active" : ""}`} onMouseEnter={() => setCursor(i)} onClick={() => open(h)}>
                <span className="search-hit-top mono">
                  {h.title.slice(0, 60)} <span className="faint">· {h.role}{h.at ? ` · ${new Date(h.at).toISOString().slice(0, 10)}` : ""}</span>
                </span>
                <Snippet text={h.snippet} />
              </button>
            );
          })}
          {result && hits.length === 0 && !loading && <div className="muted pad">No matches.</div>}
        </div>
      </div>
    </div>
  );
}
