import { useEffect, useRef, useState, type ReactNode } from "react";
import { BANK } from "../shared/banks.ts";
import type { Memory } from "./App.tsx";

/** A button with a popover panel anchored under it; closes on outside click or Escape. */
function Popover({ label, title, children }: { label: ReactNode; title?: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="pop" ref={box}>
      <button
        className={`btn mono ${open ? "btn-live" : ""}`}
        title={title}
        onClick={() => {
          const rect = box.current?.getBoundingClientRect();
          if (rect) setPos({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) });
          setOpen((o) => !o);
        }}
      >
        {label}
      </button>
      {open && (
        <div className="pop-panel" style={pos ? { top: pos.top, right: pos.right } : undefined}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/** Switch between this account's memory banks, or create one. "main" is the original memory. */
export function BankMenu({ memory, bank, onSwitch }: { memory: Memory; bank: string; onSwitch: (bank: string) => void }) {
  const [banks, setBanks] = useState<string[]>([bank]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => void memory.stub.listBanks().then(setBanks), [memory]);

  return (
    <Popover label={<>▤ {bank}</>} title="memory bank">
      {(close) => (
        <div className="menu">
          <div className="label">memory banks</div>
          {banks.map((b) => (
            <div key={b} className={`menu-row ${b === bank ? "active" : ""}`}>
              <button
                className="menu-main mono"
                onClick={() => {
                  close();
                  if (b !== bank) onSwitch(b);
                }}
              >
                <span>{b}</span>
                {b === "main" && <span className="faint">default</span>}
              </button>
            </div>
          ))}
          <form
            className="bank-new"
            onSubmit={async (e) => {
              e.preventDefault();
              setError(null);
              const result = await memory.stub.createBank(name);
              if (!result.ok) return setError(result.error);
              setBanks(result.banks);
              setName("");
              close();
              onSwitch(name.trim().toLowerCase());
            }}
          >
            <input className="input mono" placeholder="new bank, e.g. work" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} />
            <button className="btn" disabled={!BANK.test(name)}>
              + create
            </button>
          </form>
          {error && <p className="hint mono signin-error">{error}</p>}
          <p className="hint mono">Each bank is a separate memory: its own repo, chats, and notes.</p>
        </div>
      )}
    </Popover>
  );
}

/** The signed-in account: who you are, and sign out. */
export function AccountMenu({ user, email, onSignOut }: { user: string; email: string | null; onSignOut: () => void }) {
  return (
    <Popover label={<span className="account-label">{email ?? `@${user}`}</span>} title="account">
      {() => (
        <div className="menu">
          <div className="label">signed in as</div>
          <div className="mono">{email ?? user}</div>
          <div className="hint mono">user id {user}</div>
          <button className="btn" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      )}
    </Popover>
  );
}
