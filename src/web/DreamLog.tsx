import { useEffect, useRef } from "react";
import type { MemoryState } from "../server/memory-agent.ts";
import { ago } from "./format.ts";

/** Live log of the dreaming agent: every shell command, file write, source check, and the commit. */
export function DreamLog({ state, onClose }: { state: MemoryState; onClose: () => void }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [state.log.length]);
  const last = state.lastDream;

  return (
    <aside className="dreamlog">
      <div className="pane-head dreamlog-head">
        <span className="mono">
          dream log
          {state.dreaming ? ` · $${state.dreamCost.toFixed(4)} so far` : last ? ` · last run $${last.cost.toFixed(4)}` : ""}
        </span>
        <button className="btn btn-ghost" onClick={onClose}>
          ×
        </button>
      </div>
      {last && !state.dreaming && (
        <div className={`dream-result result-${last.status}`}>
          <div className="mono">
            {last.status} · {last.reason} · {ago(last.at)}
          </div>
          <div className="dream-result-msg">{last.message}</div>
        </div>
      )}
      <div className="dreamlog-body">
        {state.log.length === 0 && <div className="muted mono pad">{state.dreaming ? "starting…" : "no runs yet"}</div>}
        {state.log.map((entry, i) => (
          <details key={i} className={`log log-${entry.kind}`} open={entry.kind === "commit"}>
            <summary className="mono">
              <span className="log-kind">{entry.kind === "bash" ? "$" : entry.kind}</span> {entry.text}
            </summary>
            {entry.detail && <pre className="log-detail mono">{entry.detail}</pre>}
          </details>
        ))}
        {state.dreaming && <div className="log-live mono">▍</div>}
        <div ref={end} />
      </div>
    </aside>
  );
}
