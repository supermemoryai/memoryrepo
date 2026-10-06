import { Agent, callable, getAgentByName } from "agents";
import { BANK, DEFAULT_BANK, MAX_BANKS, parseMemoryName } from "../shared/banks.ts";
import { buildGraph, type Graph } from "../shared/links.ts";
import { equal } from "./auth.ts";
import type { Env } from "./env.ts";
import { dream, type CommitOutcome, type FileChange } from "./memory.ts";
import { DEFAULT_CHAT_MODEL, DEFAULT_DREAM_MODEL, MODELS, metered, resolveModel, type CallUsage, type ModelInfo } from "./models.ts";
import { buildInbox, parseSourceRef, sourceExcerpt, type TranscriptMessage } from "./transcripts.ts";
import { Vault, type Files } from "./vault.ts";

/** Dreaming runs on a Durable Object alarm this often, and only when there are new messages. */
const DREAM_EVERY_SECONDS = 4 * 60 * 60;
/** Sign-in codes: how long one lasts, guesses per code, and how often new ones can be sent. */
const CODE_TTL_MS = 10 * 60_000;
const CODE_ATTEMPTS = 5;
const CODE_RESEND_MS = 60_000;
const CODES_PER_HOUR = 5;
/** Model spend allowed per user per calendar month (UTC). Not shown to users. */
const MONTHLY_SPEND_CAP_USD = 1;

export type LogEntry = { at: number; kind: "info" | "bash" | "write" | "commit" | "error"; text: string; detail?: string };
export type LastDream = { at: number; status: "committed" | "unchanged" | "idle" | "incomplete" | "failed"; message: string; reason: string; cost: number };
export type Prefs = { chatModel: string; dreamModel: string };
export type MemoryState = {
  prefs: Prefs;
  dreaming: boolean;
  /** USD spent so far by the dream in progress (live). */
  dreamCost: number;
  log: LogEntry[];
  lastDream: LastDream | null;
};
export type Thread = { id: string; title: string; created_at: number };
export type NoteSummary = { id: string; title: string; created_at: number; updated_at: number; chars: number; dreamed: boolean };
export type Note = { id: string; title: string; body: string; created_at: number; updated_at: number };
export type SearchHit =
  | { kind: "message"; thread: string; title: string; msgId: string; role: string; at: number | null; snippet: string }
  | { kind: "wiki"; path: string; snippet: string }
  | { kind: "note"; note: string; title: string; snippet: string };
export type Costs = { total: number; chat: number; dream: number; calls: number };

const DEFAULT_PREFS: Prefs = { chatModel: DEFAULT_CHAT_MODEL, dreamModel: DEFAULT_DREAM_MODEL };

/**
 * One per user (named by user id). Owns the memory repo (a Cloudflare Artifacts git repo), the
 * thread index, chat-time commits, the dreaming alarm, full-text search, and a cost ledger.
 */
export class MemoryAgent extends Agent<Env, MemoryState> {
  initialState: MemoryState = { prefs: DEFAULT_PREFS, dreaming: false, dreamCost: 0, log: [], lastDream: null };
  /** HEAD and files as last read or written here. Every write goes through this DO, so it stays current. */
  private head: { hash: string | null; files: Files } | null = null;
  /** Files at recently seen commits, for conflict checks without re-reading the remote. */
  private recent = new Map<string, Files>();

  async onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, msg_count INTEGER)`;
    this.sql`CREATE TABLE IF NOT EXISTS cursors (thread_id TEXT PRIMARY KEY, cursor TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS usage (
      at INTEGER NOT NULL, kind TEXT NOT NULL, ref TEXT NOT NULL, model TEXT NOT NULL,
      input INTEGER NOT NULL, cached INTEGER NOT NULL, output INTEGER NOT NULL, cost REAL NOT NULL, ms INTEGER NOT NULL
    )`;
    this.sql`CREATE VIRTUAL TABLE IF NOT EXISTS msg_fts USING fts5(text, thread_id UNINDEXED, msg_id UNINDEXED, role UNINDEXED, at UNINDEXED, tokenize = 'porter unicode61')`;
    this.sql`CREATE TABLE IF NOT EXISTS msg_fts_state (thread_id TEXT PRIMARY KEY, indexed INTEGER NOT NULL)`;
    this.sql`CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(text, path UNINDEXED, tokenize = 'porter unicode61')`;
    this.sql`CREATE TABLE IF NOT EXISTS wiki_fts_state (id INTEGER PRIMARY KEY CHECK (id = 1), hash TEXT NOT NULL)`;
    // Notes: the user's own writing. Dreaming folds a note in when it changed since the last dream.
    this.sql`CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, dreamed_at INTEGER NOT NULL DEFAULT 0
    )`;
    // On an account's main agent: spend reported by its other banks, for the account-wide monthly cap.
    this.sql`CREATE TABLE IF NOT EXISTS bank_spend (at INTEGER NOT NULL, bank TEXT NOT NULL, cost REAL NOT NULL)`;
    this.sql`CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(text, note_id UNINDEXED, tokenize = 'porter unicode61')`;
    await this.scheduleEvery(DREAM_EVERY_SECONDS, "runDream", { reason: "alarm" });
    // A crash mid-dream leaves `dreaming` set; nothing can be running on a fresh start.
    this.setState({ ...this.initialState, ...this.state, prefs: { ...DEFAULT_PREFS, ...this.state?.prefs }, dreaming: false, dreamCost: 0 });
  }

  // ---- settings ------------------------------------------------------------------------

  @callable()
  models(): ModelInfo[] {
    return MODELS;
  }

  // ---- banks ----------------------------------------------------------------------------------
  // The account (sign-in, email, bank list, spend cap) lives on the main agent, named by the user id.
  // Another bank's agent forwards these calls there.

  private get isMain(): boolean {
    return parseMemoryName(this.name).bank === DEFAULT_BANK;
  }
  private async main() {
    return getAgentByName(this.env.MemoryAgent, parseMemoryName(this.name).user);
  }

  /** This account's banks, "main" first. */
  @callable()
  async listBanks(): Promise<string[]> {
    if (!this.isMain) return (await this.main()).listBanks();
    return [DEFAULT_BANK, ...(JSON.parse(this.meta("banks") ?? "[]") as string[])];
  }

  @callable()
  async createBank(name: string): Promise<{ ok: true; banks: string[] } | { ok: false; error: string }> {
    if (!this.isMain) return (await this.main()).createBank(name);
    const bank = String(name ?? "").trim().toLowerCase();
    if (!BANK.test(bank)) return { ok: false, error: "use a–z, 0–9, _ or -, up to 32 characters" };
    const banks = await this.listBanks();
    if (banks.includes(bank)) return { ok: false, error: `${bank} already exists` };
    if (banks.length >= MAX_BANKS) return { ok: false, error: `up to ${MAX_BANKS} banks` };
    const next = [...banks.slice(1), bank];
    this.setMeta("banks", JSON.stringify(next));
    return { ok: true, banks: [DEFAULT_BANK, ...next] };
  }

  /** Not @callable: the Worker checks this before routing to a bank's agents. */
  async hasBank(bank: string): Promise<boolean> {
    return (await this.listBanks()).includes(bank);
  }

  /** Not @callable: other banks report their model spend here, so the cap covers the whole account. */
  addBankSpend(at: number, bank: string, cost: number) {
    this.sql`INSERT INTO bank_spend (at, bank, cost) VALUES (${at}, ${bank}, ${cost})`;
  }

  // ---- sign-in (not @callable: only the Worker's /auth routes reach these, over DO RPC) ----------

  /** A new 6-digit sign-in code (replacing any earlier one), or how long to wait before asking again. */
  issueLoginCode(): { code: string } | { retryAfter: number } {
    const now = Date.now();
    const sent = (JSON.parse(this.meta("login_sends") ?? "[]") as number[]).filter((t) => now - t < 3_600_000);
    const last = sent.at(-1);
    if (last && now - last < CODE_RESEND_MS) return { retryAfter: Math.ceil((last + CODE_RESEND_MS - now) / 1000) };
    if (sent.length >= CODES_PER_HOUR) return { retryAfter: Math.ceil((sent[0]! + 3_600_000 - now) / 1000) };
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000).padStart(6, "0");
    this.setMeta("login_sends", JSON.stringify([...sent, now]));
    this.setMeta("login_code", JSON.stringify({ code, expires: now + CODE_TTL_MS, attempts: 0 }));
    return { code };
  }

  /** Check a sign-in code. A code works once, for 10 minutes, and dies after 5 wrong guesses. */
  verifyLoginCode(code: string, email: string): "ok" | "wrong" | "expired" {
    const pending = JSON.parse(this.meta("login_code") ?? "null") as { code: string; expires: number; attempts: number } | null;
    if (!pending || pending.expires < Date.now() || pending.attempts >= CODE_ATTEMPTS) return "expired";
    if (!equal(code, pending.code)) {
      this.setMeta("login_code", JSON.stringify({ ...pending, attempts: pending.attempts + 1 }));
      return "wrong";
    }
    this.sql`DELETE FROM meta WHERE key = 'login_code'`;
    this.setMeta("email", email);
    return "ok";
  }

  accountEmail(): string | null {
    return this.meta("email") ?? null;
  }

  private meta(key: string): string | undefined {
    return this.sql<{ value: string }>`SELECT value FROM meta WHERE key = ${key}`[0]?.value;
  }
  private setMeta(key: string, value: string) {
    this.sql`INSERT INTO meta (key, value) VALUES (${key}, ${value}) ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
  }

  @callable()
  setPrefs(patch: Partial<Prefs>) {
    const known = (id: unknown, fallback: string) => (typeof id === "string" && id ? id : fallback);
    const prefs = { ...this.state.prefs, ...patch };
    this.setState({ ...this.state, prefs: { chatModel: known(prefs.chatModel, DEFAULT_CHAT_MODEL), dreamModel: known(prefs.dreamModel, DEFAULT_DREAM_MODEL) } });
  }

  // ---- threads ----------------------------------------------------------------------------

  @callable()
  listThreads(): Thread[] {
    return this.sql<Thread>`SELECT id, title, created_at FROM threads ORDER BY created_at DESC`;
  }

  @callable()
  newThread(): Thread {
    const thread = { id: crypto.randomUUID().slice(0, 8), title: "New chat", created_at: Date.now() };
    this.sql`INSERT INTO threads (id, title, created_at) VALUES (${thread.id}, ${thread.title}, ${thread.created_at})`;
    return thread;
  }

  /** Called by a ChatAgent at the start and end of each turn. */
  touchThread(id: string, title: string, count: number) {
    this.sql`INSERT INTO threads (id, title, created_at, msg_count) VALUES (${id}, ${title}, ${Date.now()}, ${count})
      ON CONFLICT(id) DO UPDATE SET
        title = CASE WHEN threads.title = 'New chat' THEN excluded.title ELSE threads.title END,
        msg_count = excluded.msg_count`;
  }

  // ---- notes ------------------------------------------------------------------------------------

  @callable()
  listNotes(): NoteSummary[] {
    return this.sql<{ id: string; title: string; created_at: number; updated_at: number; chars: number; dreamed_at: number }>`
      SELECT id, title, created_at, updated_at, length(body) AS chars, dreamed_at FROM notes ORDER BY updated_at DESC`.map((n) => ({
      id: n.id,
      title: n.title,
      created_at: n.created_at,
      updated_at: n.updated_at,
      chars: n.chars,
      dreamed: n.dreamed_at >= n.updated_at,
    }));
  }

  @callable()
  getNote(id: string): Note | null {
    return this.sql<Note>`SELECT id, title, body, created_at, updated_at FROM notes WHERE id = ${id}`[0] ?? null;
  }

  /** Create (no id) or update a note. Body is markdown. */
  @callable()
  saveNote(input: { id?: string; title: string; body: string }): Note {
    const now = Date.now();
    const title = (input.title ?? "").trim().slice(0, 200) || "Untitled";
    const body = (input.body ?? "").slice(0, 200_000);
    const id = input.id && /^[a-z0-9]{1,16}$/.test(input.id) ? input.id : crypto.randomUUID().slice(0, 8);
    this.sql`INSERT INTO notes (id, title, body, created_at, updated_at) VALUES (${id}, ${title}, ${body}, ${now}, ${now})
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, body = excluded.body, updated_at = excluded.updated_at`;
    this.sql`DELETE FROM note_fts WHERE note_id = ${id}`;
    this.sql`INSERT INTO note_fts (text, note_id) VALUES (${`${title}\n\n${body}`}, ${id})`;
    return this.getNote(id)!;
  }

  @callable()
  deleteNote(id: string) {
    this.sql`DELETE FROM notes WHERE id = ${id}`;
    this.sql`DELETE FROM note_fts WHERE note_id = ${id}`;
  }

  // ---- reading the repo ----------------------------------------------------------------------

  /** What a chat turn needs: the repo at HEAD and the chat model. */
  async chatContext(): Promise<{ files: Files; head: string | null; chatModel: string }> {
    const { hash, files } = await this.snapshot();
    return { files, head: hash, chatModel: this.state.prefs.chatModel };
  }

  /** Files at HEAD; reuses this DO's view unless `fresh` (only an outside push could make it stale). */
  private async snapshot(fresh = false): Promise<{ hash: string | null; files: Files }> {
    if (this.head && !fresh) return this.head;
    const vault = await this.vault();
    const head = await vault.head();
    const files = head ? await vault.files(head.hash) : {};
    this.setHead(head?.hash ?? null, files);
    return this.head!;
  }

  private setHead(hash: string | null, files: Files) {
    this.head = { hash, files };
    if (!hash) return;
    this.recent.set(hash, files);
    if (this.recent.size > 16) this.recent.delete(this.recent.keys().next().value!);
  }

  @callable()
  async tree(ref?: string): Promise<{ hash: string | null; paths: string[] }> {
    if (!ref) {
      const { hash, files } = await this.snapshot();
      return { hash, paths: Object.keys(files).sort() };
    }
    return { hash: ref, paths: Object.keys(await (await this.vault()).blobs(ref)).sort() };
  }

  @callable()
  async file(ref: string, path: string): Promise<string | null> {
    if (ref === this.head?.hash) return this.head.files[path] ?? null;
    return (await this.vault()).readFile(ref, path);
  }

  @callable()
  async graph(ref?: string): Promise<Graph> {
    const head = await this.snapshot();
    if (!ref || ref === head.hash) return buildGraph(head.hash, head.files);
    return buildGraph(ref, await (await this.vault()).files(ref));
  }

  @callable()
  async history() {
    return (await this.vault()).log(200);
  }

  @callable()
  async commitChanges(hash: string) {
    return (await this.vault()).changes(hash);
  }

  /** The conversation behind a `[source: thread/<id>#<msg>]` ref. Used by dreaming to check sources. */
  async readSource(ref: string): Promise<string> {
    const parsed = parseSourceRef(ref);
    if (!parsed) return `unrecognized source ref: ${ref} (expected thread/<id>[#<message>] or note/<id>)`;
    if ("note" in parsed) {
      const note = this.getNote(parsed.note);
      return note ? `# Note: ${note.title} (note/${note.id}, updated ${new Date(note.updated_at).toISOString().slice(0, 16)})\n\n${note.body}`.slice(0, 12_000) : `no such note: ${parsed.note}`;
    }
    const title = this.sql<{ title: string }>`SELECT title FROM threads WHERE id = ${parsed.thread}`[0]?.title;
    if (!title) return `no such thread: ${parsed.thread}`;
    const chat = await getAgentByName(this.env.ChatAgent, `${this.name}.${parsed.thread}`);
    return sourceExcerpt({ id: parsed.thread, title }, await chat.transcript(), parsed.message);
  }

  // ---- writing the repo -----------------------------------------------------------------------

  /** Commits are serialized (one DO, but each commit awaits the network). */
  private lock: Promise<unknown> = Promise.resolve();
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => {});
    return run;
  }

  /**
   * Commit and push a chat agent's edit. Like a git push with a clean rebase: if HEAD moved since the
   * agent read the repo, the edit still lands unless a file it touches changed in between; then nothing
   * is written and the current versions come back so the agent can merge.
   */
  async applyEdits(expectedHead: string | null, changes: FileChange[], message: string): Promise<CommitOutcome> {
    return this.locked(async () => {
      try {
        const vault = await this.vault();
        const { hash, files } = await this.snapshot();
        if (hash !== expectedHead) {
          const before = expectedHead ? (this.recent.get(expectedHead) ?? (await vault.files(expectedHead))) : {};
          const touched = changes.filter((c) => before[c.path] !== files[c.path]);
          if (touched.length) return { ok: false, reason: "conflict", head: hash, current: touched.map((c) => ({ path: c.path, content: files[c.path] ?? null })) };
        }
        const next: Files = { ...files };
        for (const c of changes) {
          if (c.content === null) delete next[c.path];
          else next[c.path] = c.content;
        }
        const pushed = await vault.commit(hash, next, message.slice(0, 300)).catch((error) => {
          this.head = null; // maybe someone pushed from outside: re-read next time
          throw error;
        });
        if (!pushed) return { ok: true, hash: hash ?? "", head: hash ?? "" };
        this.setHead(pushed.hash, next);
        return { ok: true, hash: pushed.hash, head: pushed.hash, ms: pushed.ms };
      } catch (error) {
        return { ok: false, reason: "error", message: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  // ---- dreaming ------------------------------------------------------------------------------

  @callable()
  async dreamNow() {
    if (this.state.dreaming) return { started: false };
    await this.schedule(0, "runDream", { reason: "manual" });
    return { started: true };
  }

  async runDream(payload: { reason: string }) {
    if (this.state.dreaming) return;
    this.setState({ ...this.state, dreaming: true, dreamCost: 0, log: [] });
    const finish = (status: LastDream["status"], message: string) =>
      this.setState({ ...this.state, dreaming: false, lastDream: { at: Date.now(), status, message, reason: payload.reason, cost: this.state.dreamCost } });

    let stage = "collect inbox";
    try {
      const { inbox, cursors, notes } = await this.collectInbox();
      if (Object.keys(inbox).length === 0) {
        this.log("info", "no new messages; skipped");
        return finish("idle", "nothing new");
      }
      const { left } = await this.budget();
      if (left <= 0) {
        this.log("info", "monthly usage limit reached; skipped");
        return finish("idle", "usage limit reached for this month");
      }
      this.log("info", `${payload.reason}: ${Object.keys(inbox).length} thread(s) with new messages · ${this.state.prefs.dreamModel}`);

      stage = "read repo";
      const vault = await this.vault();
      const base = await this.snapshot(true);
      const model = metered(resolveModel(this.state.prefs.dreamModel, this.env.OPENROUTER_API_KEY), this.state.prefs.dreamModel, (u) => {
        void this.recordUsage("dream", `dream:${payload.reason}`, u);
        this.setState({ ...this.state, dreamCost: this.state.dreamCost + u.cost });
      });

      stage = "dream (model)";
      const result = await dream({
        files: base.files,
        inbox,
        model,
        today: new Date().toISOString().slice(0, 10),
        log: (kind, text, detail) => this.log(kind, text, detail),
        readSource: (ref) => this.readSource(ref),
        // Stop at the cap; the dream then ends without committing.
        stop: () => this.state.dreamCost >= left,
      });
      if (!result.ok) {
        this.log("error", `${result.reason}; nothing pushed`);
        return finish("incomplete", result.reason);
      }

      stage = "commit/push";
      const outcome = await this.locked(async () => {
        // Chat may have committed while we dreamt: rebase the dream's edits onto the new HEAD.
        const now = await this.snapshot();
        let next = result.files;
        if (now.hash !== base.hash) {
          next = {};
          const conflicts: string[] = [];
          for (const path of new Set([...Object.keys(base.files), ...Object.keys(result.files), ...Object.keys(now.files)])) {
            const [was, mine, theirs] = [base.files[path], result.files[path], now.files[path]];
            const value = mine !== was ? (theirs !== was && theirs !== mine ? (conflicts.push(path), mine) : mine) : theirs;
            if (value !== undefined) next[path] = value;
          }
          if (conflicts.length) return { conflict: conflicts };
          this.log("info", `chat committed during the dream; rebased onto ${now.hash?.slice(0, 7)}`);
        }
        const pushed = await vault.commit(now.hash, next, `dream: ${result.message}`.slice(0, 500));
        if (pushed) this.setHead(pushed.hash, next);
        return { pushed };
      });
      if ("conflict" in outcome) {
        this.log("error", `conflict with chat edits in ${outcome.conflict!.join(", ")}; nothing pushed, next dream retries`);
        return finish("incomplete", "conflict with chat edits");
      }
      this.advanceCursors(cursors, notes);
      if (!outcome.pushed) {
        this.log("commit", "no file changes", result.message);
        return finish("unchanged", result.message);
      }
      this.log("commit", `${outcome.pushed.hash.slice(0, 7)} · ${outcome.pushed.changes.length} files`, result.message);
      return finish("committed", result.message);
    } catch (error) {
      const message = `[${stage}] ${error instanceof Error ? error.message : String(error)}`;
      this.log("error", message);
      return finish("failed", message);
    }
  }

  private async collectInbox() {
    const rows = this.sql<{ id: string; title: string; cursor: string | null }>`
      SELECT t.id, t.title, c.cursor FROM threads t LEFT JOIN cursors c ON c.thread_id = t.id`;
    const threads = await Promise.all(
      rows.map(async (row) => {
        const chat = await getAgentByName(this.env.ChatAgent, `${this.name}.${row.id}`);
        return { ...row, messages: (await chat.transcript()) as TranscriptMessage[] };
      }),
    );
    const { inbox, cursors } = buildInbox(threads);
    // Notes changed since they were last dreamt, in full.
    const notes: Record<string, number> = {};
    for (const n of this.sql<Note & { dreamed_at: number }>`SELECT id, title, body, created_at, updated_at, dreamed_at FROM notes WHERE updated_at > dreamed_at`) {
      if (!n.body.trim()) continue;
      inbox[`note-${n.id}.md`] = `# Note: ${n.title}\n(note/${n.id} · ${n.dreamed_at ? "edited" : "new"} · updated ${new Date(n.updated_at).toISOString().slice(0, 16).replace("T", " ")} UTC)\n\n${n.body}\n`;
      notes[n.id] = n.updated_at;
    }
    return { inbox, cursors, notes };
  }

  private advanceCursors(cursors: Record<string, string>, notes: Record<string, number>) {
    for (const [threadId, cursor] of Object.entries(cursors)) {
      this.sql`INSERT INTO cursors (thread_id, cursor) VALUES (${threadId}, ${cursor}) ON CONFLICT(thread_id) DO UPDATE SET cursor = excluded.cursor`;
    }
    // Only the version the dream saw counts as dreamt; later edits come back next time.
    for (const [id, updatedAt] of Object.entries(notes)) this.sql`UPDATE notes SET dreamed_at = ${updatedAt} WHERE id = ${id}`;
  }

  private log(kind: LogEntry["kind"], text: string, detail?: string) {
    this.setState({ ...this.state, log: [...this.state.log, { at: Date.now(), kind, text, detail: detail?.slice(0, 4000) }] });
  }

  /** Dreaming status for the HTTP API (the UI gets this as live agent state). */
  dreamStatus(): Pick<MemoryState, "dreaming" | "dreamCost" | "lastDream" | "log"> {
    const { dreaming, dreamCost, lastDream, log } = this.state;
    return { dreaming, dreamCost, lastDream, log };
  }

  // ---- costs ------------------------------------------------------------------------------------

  /** Every model call, as billed (ChatAgent reports chat calls over RPC). */
  async recordUsage(kind: "chat" | "dream", ref: string, u: CallUsage) {
    const at = Date.now();
    this.sql`INSERT INTO usage (at, kind, ref, model, input, cached, output, cost, ms)
      VALUES (${at}, ${kind}, ${ref}, ${u.model}, ${u.input}, ${u.cached}, ${u.output}, ${u.cost}, ${u.ms})`;
    if (!this.isMain) (await this.main()).addBankSpend(at, parseMemoryName(this.name).bank, u.cost);
  }

  /** USD left under this month's account-wide cap (may be negative), and when the month resets. */
  async budget(): Promise<{ left: number; resets: number }> {
    if (!this.isMain) return (await this.main()).budget();
    const now = new Date();
    const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const own = this.sql<{ c: number | null }>`SELECT SUM(cost) AS c FROM usage WHERE at >= ${start}`[0]?.c ?? 0;
    const banks = this.sql<{ c: number | null }>`SELECT SUM(cost) AS c FROM bank_spend WHERE at >= ${start}`[0]?.c ?? 0;
    const spent = own + banks;
    return { left: MONTHLY_SPEND_CAP_USD - spent, resets: Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) };
  }

  threadCost(thread: string): number {
    return this.sql<{ c: number | null }>`SELECT SUM(cost) AS c FROM usage WHERE ref = ${thread}`[0]?.c ?? 0;
  }

  @callable()
  costs(): Costs {
    const row = (kind: string) => this.sql<{ c: number | null }>`SELECT SUM(cost) AS c FROM usage WHERE kind = ${kind}`[0]?.c ?? 0;
    const calls = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM usage`[0]?.n ?? 0;
    const chat = row("chat");
    const dreamCost = row("dream");
    return { total: chat + dreamCost, chat, dream: dreamCost, calls };
  }

  // ---- full-text search -------------------------------------------------------------------------

  /** Search raw conversations and the wiki (files at HEAD). SQLite FTS5; indexes sync lazily. */
  @callable()
  async search(q: string): Promise<{ hits: SearchHit[]; ms: number; indexed: { messages: number; files: number } }> {
    const t0 = Date.now();
    const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    const match = words.map((w, i) => `"${w}"${i === words.length - 1 ? "*" : ""}`).join(" ");
    if (match) await Promise.all([this.syncMessageIndex(), this.syncWikiIndex()]);
    const hits: SearchHit[] = !match
      ? []
      : [
          ...this.sql<{ path: string; snippet: string }>`
            SELECT path, snippet(wiki_fts, 0, '⟦', '⟧', '…', 14) AS snippet FROM wiki_fts
            WHERE wiki_fts MATCH ${match} ORDER BY bm25(wiki_fts) LIMIT 40`.map((w) => ({ kind: "wiki" as const, ...w })),
          ...this.sql<{ note_id: string; snippet: string; title: string | null }>`
            SELECT f.note_id, snippet(note_fts, 0, '⟦', '⟧', '…', 14) AS snippet, n.title
            FROM note_fts f LEFT JOIN notes n ON n.id = f.note_id
            WHERE note_fts MATCH ${match} ORDER BY bm25(note_fts) LIMIT 40`.map((n) => ({ kind: "note" as const, note: n.note_id, title: n.title ?? n.note_id, snippet: n.snippet })),
          ...this.sql<{ thread_id: string; msg_id: string; role: string; at: number | null; snippet: string; title: string | null }>`
            SELECT f.thread_id, f.msg_id, f.role, f.at, snippet(msg_fts, 0, '⟦', '⟧', '…', 14) AS snippet, t.title
            FROM msg_fts f LEFT JOIN threads t ON t.id = f.thread_id
            WHERE msg_fts MATCH ${match} ORDER BY bm25(msg_fts) LIMIT 40`.map((m) => ({
            kind: "message" as const,
            thread: m.thread_id,
            title: m.title ?? m.thread_id,
            msgId: m.msg_id,
            role: m.role,
            at: m.at == null ? null : Number(m.at),
            snippet: m.snippet,
          })),
        ];
    const count = (table: string) => this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).one().n as number;
    return { hits, ms: Date.now() - t0, indexed: { messages: count("msg_fts"), files: count("wiki_fts") } };
  }

  private async syncMessageIndex() {
    const stale = this.sql<{ id: string; indexed: number | null }>`
      SELECT t.id, s.indexed FROM threads t LEFT JOIN msg_fts_state s ON s.thread_id = t.id
      WHERE s.indexed IS NULL OR t.msg_count IS NULL OR t.msg_count != s.indexed`;
    await Promise.all(
      stale.map(async (row) => {
        const chat = await getAgentByName(this.env.ChatAgent, `${this.name}.${row.id}`);
        const messages: TranscriptMessage[] = await chat.transcript();
        let from = row.indexed ?? 0;
        if (from > messages.length) {
          this.sql`DELETE FROM msg_fts WHERE thread_id = ${row.id}`;
          from = 0;
        }
        for (const m of messages.slice(from)) {
          if (m.text.trim()) this.sql`INSERT INTO msg_fts (text, thread_id, msg_id, role, at) VALUES (${m.text}, ${row.id}, ${m.id}, ${m.role}, ${m.at ?? null})`;
        }
        this.sql`INSERT INTO msg_fts_state (thread_id, indexed) VALUES (${row.id}, ${messages.length}) ON CONFLICT(thread_id) DO UPDATE SET indexed = excluded.indexed`;
        this.sql`UPDATE threads SET msg_count = ${messages.length} WHERE id = ${row.id}`;
      }),
    );
  }

  private async syncWikiIndex() {
    const { hash, files } = await this.snapshot();
    if (!hash || this.sql<{ hash: string }>`SELECT hash FROM wiki_fts_state WHERE id = 1`[0]?.hash === hash) return;
    this.sql`DELETE FROM wiki_fts`;
    for (const [path, text] of Object.entries(files)) this.sql`INSERT INTO wiki_fts (text, path) VALUES (${text}, ${path})`;
    this.sql`INSERT INTO wiki_fts_state (id, hash) VALUES (1, ${hash}) ON CONFLICT(id) DO UPDATE SET hash = excluded.hash`;
  }

  // ---- the repo -----------------------------------------------------------------------------------

  /** This user's Artifacts repo, created on first use (concurrent first calls share one creation). */
  private vaultPromise: Promise<Vault> | null = null;
  private vault(): Promise<Vault> {
    this.vaultPromise ??= this.openVault().catch((error) => {
      this.vaultPromise = null;
      throw error;
    });
    return this.vaultPromise;
  }

  private async openVault(): Promise<Vault> {
    const repoName = `memory-${this.name}`;
    let remote = this.sql<{ value: string }>`SELECT value FROM meta WHERE key = 'remote'`[0]?.value;
    if (!remote) {
      try {
        const created = await this.env.MEMORIES.create(repoName, { description: `markdown memory for ${this.name}`, setDefaultBranch: "main" });
        remote = created.remote;
      } catch (error) {
        // The repo outlived this DO's storage (a reset local dev state, say): adopt it.
        if ((error as { code?: string }).code !== "ALREADY_EXISTS" && !/already exists/i.test(String(error))) throw error;
        using repo = await this.env.MEMORIES.get(repoName);
        remote = (await repo.info()).remote;
      }
      this.sql`INSERT INTO meta (key, value) VALUES ('remote', ${remote}) ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
    }
    return new Vault(this.env.MEMORIES, repoName, remote);
  }
}
