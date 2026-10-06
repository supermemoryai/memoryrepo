import { useAgent } from "agents/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MemoryAgent, MemoryState, Thread } from "../server/memory-agent.ts";
import { Chat } from "./Chat.tsx";
import { DreamLog } from "./DreamLog.tsx";
import { History } from "./History.tsx";
import { NotesView } from "./NotesView.tsx";
import { ModelMenu } from "./ModelMenu.tsx";
import { SearchPalette } from "./SearchPalette.tsx";
import { VaultView } from "./VaultView.tsx";
import { ApiCard } from "./ApiCard.tsx";
import { AccountMenu, BankMenu } from "./AccountMenu.tsx";
import { BANK, DEFAULT_BANK, memoryName } from "../shared/banks.ts";
import { ago, short } from "./format.ts";

type Tab = "chat" | "notes" | "memory" | "history";
export type Memory = ReturnType<typeof useAgent<MemoryAgent, MemoryState>>;

type Session = { user: string; email: string | null; token: string };

export function App() {
  // undefined: still checking the session cookie.
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    void fetch("/auth/me")
      .then((r) => (r.ok ? (r.json() as Promise<Session>) : null))
      .catch(() => null)
      .then(setSession);
  }, []);
  if (session === undefined) return null;
  if (!session) return <SignIn onSignIn={setSession} />;
  return <Account session={session} onSignOut={() => void fetch("/auth/logout", { method: "POST" }).finally(() => setSession(null))} />;
}

/** The current bank is remembered per account in this browser. */
function Account({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
  const key = `mm:bank:${session.user}`;
  const [bank, setBank] = useState(() => {
    try {
      const saved = localStorage.getItem(key);
      if (saved && BANK.test(saved)) return saved;
    } catch {}
    return DEFAULT_BANK;
  });
  const switchBank = (next: string) => {
    try {
      localStorage.setItem(key, next);
    } catch {}
    setBank(next);
  };
  return (
    <Workspace
      key={`${session.user}.${bank}`}
      user={session.user}
      bank={bank}
      email={session.email}
      token={session.token}
      onSwitchBank={switchBank}
      onSignOut={onSignOut}
    />
  );
}

async function post<T>(path: string, body: object): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  if (!res) throw new Error("network error");
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `failed (${res.status})`);
  return data;
}

function SignIn({ onSignIn }: { onSignIn: (session: Session) => void }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const sendCode = () =>
    run(async () => {
      await post("/auth/start", { email });
      setSent(true);
      setCode("");
    });

  return (
    <div className="signin">
      <form
        className="signin-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (busy) return;
          if (!sent) void sendCode();
          else void run(async () => onSignIn(await post<Session>("/auth/verify", { email, code })));
        }}
      >
        <div className="brand">
          <span className="brand-mark" />
          markdown memory
        </div>
        <p className="muted">An agent whose long-term memory is a git repo of markdown. It writes as it learns; a dreaming agent tidies up.</p>
        {!sent ? (
          <>
            <label className="label" htmlFor="email">
              email
            </label>
            <input
              id="email"
              type="email"
              autoFocus
              autoComplete="email"
              className="input mono"
              placeholder="ada@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </>
        ) : (
          <>
            <label className="label" htmlFor="code">
              code sent to {email}
            </label>
            <input
              id="code"
              autoFocus
              inputMode="numeric"
              autoComplete="one-time-code"
              className="input mono"
              placeholder="123456"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            />
          </>
        )}
        {error && <p className="hint mono signin-error">{error}</p>}
        <button className="btn btn-primary" disabled={busy || (sent ? code.length !== 6 : !email.includes("@"))}>
          {busy ? "…" : sent ? "Sign in →" : "Email me a code →"}
        </button>
        {sent ? (
          <p className="hint mono">
            <button type="button" className="link-btn" disabled={busy} onClick={() => void sendCode()}>
              resend
            </button>{" "}
            ·{" "}
            <button type="button" className="link-btn" onClick={() => (setSent(false), setError(null))}>
              different email
            </button>
          </p>
        ) : (
          <p className="hint mono">no password · we email you a 6-digit code</p>
        )}
      </form>
    </div>
  );
}

function Workspace({
  user,
  bank,
  email,
  token,
  onSwitchBank,
  onSignOut,
}: {
  user: string;
  bank: string;
  email: string | null;
  token: string;
  onSwitchBank: (bank: string) => void;
  onSignOut: () => void;
}) {
  const [tab, setTab] = useState<Tab>(() => {
    const t = new URLSearchParams(location.search).get("tab");
    return t === "notes" || t === "memory" || t === "history" ? t : "chat";
  });
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [state, setState] = useState<MemoryState | null>(null);
  const [head, setHead] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [focusMsg, setFocusMsg] = useState<string | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [openNote, setOpenNote] = useState<string | null>(null);

  const memName = memoryName(user, bank);
  const memory = useAgent<MemoryAgent, MemoryState>({ agent: "memory-agent", name: memName, onStateUpdate: setState });

  const refreshThreads = useCallback(async () => {
    const list = await memory.stub.listThreads();
    setThreads(list);
    return list;
  }, [memory]);
  const refreshHead = useCallback(() => void memory.stub.tree().then(({ hash }) => setHead(hash)), [memory]);

  // Once per connection (StrictMode runs effects twice; don't create two first threads).
  const booted = useRef<unknown>(null);
  useEffect(() => {
    if (booted.current === memory) return;
    booted.current = memory;
    void memory.ready.then(async () => {
      const list = await refreshThreads();
      if (list.length > 0) setThreadId((current) => current ?? list[0]!.id);
      else setThreadId((await memory.stub.newThread()).id);
      refreshHead();
    });
  }, [memory, refreshThreads, refreshHead]);

  // HEAD moves when a dream commits; open the log while one runs.
  const dreaming = state?.dreaming ?? false;
  useEffect(() => {
    if (dreaming) setLogOpen(true);
    else refreshHead();
  }, [dreaming, refreshHead]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setSearchOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const newChat = async () => {
    const thread = await memory.stub.newThread();
    setThreads((list) => [thread, ...list]);
    setThreadId(thread.id);
    setTab("chat");
    setRailOpen(false);
  };
  const openMessage = (thread: string, msg?: string | null) => {
    setThreadId(thread);
    setFocusMsg(msg ?? null);
    setTab("chat");
  };
  const last = state?.lastDream;

  return (
    <div className="shell">
      <header className="topbar">
        <button className="btn btn-ghost menu-btn mono" onClick={() => setRailOpen((o) => !o)} aria-label="threads">
          ☰
        </button>
        <div className="brand">
          <span className="brand-mark" />
          markdown memory
        </div>
        <BankMenu memory={memory} bank={bank} onSwitch={onSwitchBank} />
        <nav className="tabs">
          {(["chat", "notes", "memory", "history"] as const).map((t) => (
            <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </nav>
        <div className="topbar-right">
          <button className="btn mono" onClick={() => setSearchOpen(true)} title="Full-text search (⌘K)">
            ⌕ search <span className="faint">⌘K</span>
          </button>
          {state && <ModelMenu memory={memory} state={state} />}
          <span className="meta mono" title="memory repo HEAD">
            HEAD {head ? short(head) : "∅"}
          </span>
          <button className={`btn ${dreaming ? "btn-live" : ""}`} onClick={() => setLogOpen((o) => !o)}>
            <span className={`dot ${dreaming ? "pulse" : ""}`} />
            {dreaming
              ? `dreaming · $${(state?.dreamCost ?? 0).toFixed(3)}`
              : last
                ? `dreamt ${ago(last.at)} · $${last.cost.toFixed(3)}`
                : "never dreamt"}
          </button>
          <button className="btn btn-primary" disabled={dreaming} onClick={() => void memory.stub.dreamNow()}>
            Dream now
          </button>
          <AccountMenu user={user} email={email} onSignOut={onSignOut} />
        </div>
      </header>

      <div className="strategy-bar mono">
        <span className="strategy-name">memory</span>
        <span className="muted">MEMORY.md + linked notes in git · the agent commits as it learns</span>
        <span className="faint">· dreaming tidies up every 4h if there's something new, or on Dream now</span>
      </div>

      <div className="body">
        {railOpen && <div className="scrim" onClick={() => setRailOpen(false)} />}
        <aside className={`rail ${railOpen ? "open" : ""}`}>
          <button className="btn rail-new" onClick={() => void newChat()}>
            + New chat
          </button>
          <div className="label rail-label">threads</div>
          <ul className="threads">
            {threads.map((t) => (
              <li key={t.id}>
                <button
                  className={`thread ${t.id === threadId && tab === "chat" ? "active" : ""}`}
                  onClick={() => {
                    openMessage(t.id);
                    setRailOpen(false);
                  }}
                >
                  <span className="thread-title">{t.title}</span>
                  <span className="thread-meta mono">
                    {t.id} · {ago(t.created_at)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <ApiCard user={user} bank={bank} token={token} />
        </aside>

        <main className="main">
          {tab === "chat" && threadId && (
            <Chat
              key={threadId}
              user={memName}
              threadId={threadId}
              focusMsg={focusMsg}
              onTurn={() => {
                void refreshThreads();
                refreshHead();
              }}
            />
          )}
          {tab === "notes" && <NotesView memory={memory} openNote={openNote} dreamingAt={state?.lastDream?.at ?? null} />}
          {tab === "memory" && (
            <VaultView
              memory={memory}
              head={head}
              openPath={openPath}
              onSource={(thread, msg) => {
                if (thread.startsWith("note:")) {
                  setOpenNote(thread.slice(5));
                  setTab("notes");
                } else openMessage(thread, msg);
              }}
            />
          )}
          {tab === "history" && <History memory={memory} head={head} />}
        </main>

        {logOpen && state && <DreamLog state={state} onClose={() => setLogOpen(false)} />}
      </div>
      {searchOpen && (
        <SearchPalette
          memory={memory}
          onClose={() => setSearchOpen(false)}
          onOpenMessage={openMessage}
          onOpenFile={(path) => {
            setOpenPath(path);
            setTab("memory");
          }}
          onOpenNote={(id) => {
            setOpenNote(id);
            setTab("notes");
          }}
        />
      )}
    </div>
  );
}
