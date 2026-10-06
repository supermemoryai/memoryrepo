import { useEffect, useRef, useState } from "react";
import type { MemoryState } from "../server/memory-agent.ts";
import type { ModelInfo } from "../server/models.ts";
import type { Memory } from "./App.tsx";

/** Pick the open-weight models (via OpenRouter) that chat and dream. Shows running totals too. */
export function ModelMenu({ memory, state }: { memory: Memory; state: MemoryState }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [costs, setCosts] = useState<{ total: number; chat: number; dream: number; calls: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => void memory.stub.models().then(setModels), [memory]);
  useEffect(() => {
    if (!open) return;
    void memory.stub.costs().then(setCosts);
    const onDown = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, memory]);

  const name = (id: string) => models.find((m) => m.id === id)?.name ?? id;
  const fmt = (n: number) => (n < 0.1 ? n.toFixed(3) : n < 1 ? n.toFixed(2) : n.toFixed(n % 1 ? 2 : 0));
  const select = (label: string, value: string, onChange: (id: string) => void) => (
    <label className="model-select">
      <span className="label">{label}</span>
      <select className="input mono" value={value} onChange={(e) => onChange(e.target.value)}>
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name} · ${fmt(m.inPerM)}/${fmt(m.outPerM)} per M · {Math.round(m.context / 1000)}K
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="pop" ref={box}>
      <button
        className={`btn ${open ? "btn-live" : ""}`}
        onClick={() => {
          const rect = box.current?.getBoundingClientRect();
          if (rect) setPos({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) });
          setOpen((o) => !o);
        }}
      >
        <span className="mono">⚙ {name(state.prefs.chatModel)}</span>
      </button>
      {open && (
        <div className="pop-panel wide" style={pos ? { top: pos.top, right: pos.right } : undefined}>
          <div className="menu">
            {select("chat model", state.prefs.chatModel, (id) => void memory.stub.setPrefs({ chatModel: id }))}
            {select("dreaming model", state.prefs.dreamModel, (id) => void memory.stub.setPrefs({ dreamModel: id }))}
            <p className="hint mono">Open-weight models via OpenRouter. Costs are what OpenRouter reports per call.</p>
            {costs && (
              <div className="mono costs">
                spent ${costs.total.toFixed(3)} · chat ${costs.chat.toFixed(3)} · dreaming ${costs.dream.toFixed(3)} · {costs.calls} calls
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
