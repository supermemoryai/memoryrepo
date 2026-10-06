import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useAgent } from "agents/react";
import { useEffect, useRef, useState } from "react";
import type { ChatState } from "../server/chat-agent.ts";
import { Markdown } from "./Markdown.tsx";

type ToolPart = { type: string; state?: string; input?: { command?: string; path?: string; message?: string }; output?: unknown };

export function Chat({ user, threadId, focusMsg, onTurn }: { user: string; threadId: string; focusMsg?: string | null; onTurn: () => void }) {
  const [chatState, setChatState] = useState<ChatState | null>(null);
  const agent = useAgent<ChatState>({ agent: "chat-agent", name: `${user}.${threadId}`, onStateUpdate: setChatState });
  const { messages, sendMessage, status, stop } = useAgentChat({ agent });
  const [input, setInput] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const busy = status === "submitted" || status === "streaming";

  // Jump to a search hit / source once it's rendered; otherwise follow the bottom.
  const [flash, setFlash] = useState<string | null>(null);
  const jumped = useRef<string | null>(null);
  useEffect(() => {
    if (focusMsg && jumped.current !== focusMsg) {
      const el = document.getElementById(`msg-${focusMsg}`);
      if (el) {
        jumped.current = focusMsg;
        el.scrollIntoView({ block: "center" });
        setFlash(focusMsg);
        setTimeout(() => setFlash(null), 2_000);
        return;
      }
      if (messages.length === 0) return;
    }
    if (jumped.current && jumped.current === focusMsg) return;
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages, focusMsg]);

  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy) onTurn();
    wasBusy.current = busy;
  }, [busy, onTurn]);

  const submit = () => {
    const text = input.trim();
    if (!text || busy) return;
    // The timezone lets dreaming resolve "tomorrow" against the user's day.
    void sendMessage({ text, metadata: { createdAt: Date.now(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone } });
    setInput("");
  };

  return (
    <div className="chat-wrap">
      <div className="chat">
        <div className="chat-scroll" ref={scroller}>
          <div className="chat-inner">
            {messages.length === 0 && (
              <div className="empty">
                <div className="empty-title">thread {threadId}</div>
                <p className="muted">Tell it about yourself. It saves what matters to its memory repo as you talk; open the memory tab to watch it grow.</p>
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} id={`msg-${m.id}`} className={`msg msg-${m.role} ${flash === m.id ? "msg-flash" : ""}`}>
                <div className="msg-role mono" title={(m.metadata as { model?: string } | undefined)?.model}>
                  {m.role === "user" ? "you" : "agent"}
                </div>
                <div className="msg-body">
                  {m.parts.map((part, i) => {
                    if (part.type === "text") return <Markdown key={i} text={part.text} />;
                    if (part.type.startsWith("tool-")) return <ToolCall key={i} part={part as ToolPart} />;
                    return null;
                  })}
                </div>
              </div>
            ))}
            {chatState?.error && <div className="msg-status mono">{chatState.error}</div>}
            {status === "submitted" && <div className="msg-thinking mono">thinking…</div>}
          </div>
        </div>
        <div className="composer-wrap">
          {chatState && <TurnStats state={chatState} busy={busy} />}
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <textarea
              className="input composer-input"
              rows={1}
              placeholder="Message…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            {busy ? (
              <button type="button" className="btn" onClick={() => stop()}>
                Stop
              </button>
            ) : (
              <button className="btn btn-primary" disabled={!input.trim()}>
                Send
              </button>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}

const secs = (ms: number | null) => (ms == null ? "…" : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
const usd = (v: number) => (v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(v < 0.01 ? 4 : 3)}`);

/** Live: which model answered, where the time went, what this turn and thread cost. */
function TurnStats({ state, busy }: { state: ChatState; busy: boolean }) {
  const s = state.stats;
  if (!s) return null;
  return (
    <div className="turnstats">
      <div className="turnstats-row mono">
        <span>{s.model}</span>
        <span title="time to first token">ttft {secs(s.ttft)}</span>
        <span>{busy && s.total == null ? "running…" : `total ${secs(s.total)}`}</span>
        <span title="model steps · tool calls (summed tool time)">
          {s.steps} steps · {s.toolCalls} tools ({secs(s.toolMs)})
        </span>
        <span className="turnstats-cost" title="cost reported by OpenRouter">
          {usd(state.cost.turn)} turn · {usd(state.cost.thread)} thread
        </span>
      </div>
    </div>
  );
}

/** Shell commands show as `$ cmd`; memory writes as `› memory_edit people/priya.md — message`. */
function ToolCall({ part }: { part: ToolPart }) {
  const name = part.type.slice(5);
  const input = part.input ?? {};
  const done = part.state === "output-available" || part.state === "output-error";
  const summary = input.command ?? `${name}${input.path ? ` ${input.path}` : ""}${input.message ? ` — ${input.message}` : ""}`;
  return (
    <details className={`tool ${name.startsWith("memory_") ? "tool-write" : ""}`}>
      <summary className="mono">
        <span className="tool-prompt">{input.command ? "$" : "›"}</span> {summary}
        {!done && <span className="tool-running"> running…</span>}
      </summary>
      {done && <pre className="tool-output mono">{typeof part.output === "string" ? part.output : JSON.stringify(part.output, null, 2)}</pre>}
    </details>
  );
}
