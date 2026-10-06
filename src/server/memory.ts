/**
 * Markdown memory: an agent's long-term memory as a git repo of linked markdown (an "LLM wiki").
 *
 * The technique, after Cognition's "agent memory repo":
 *   - MEMORY.md is the entry point. It is loaded into every conversation, kept short, and links out.
 *   - Everything else lives in topic files (people/, projects/, preferences/, …) linked with [[path]].
 *   - Each entry is one bullet with metadata: `- Priya moved to Pune [source: thread/ab12#m9; added: 2026-10-05]`.
 *   - The chat agent remembers as it goes: it greps and follows links to read, and every write is a
 *     commit pushed immediately. A write based on a stale view of a file is rejected; the agent reads
 *     both versions and writes one.
 *   - Dreaming runs periodically: it adds patterns across conversations, merges duplicates, removes
 *     outdated entries, and checks sources to resolve contradictions.
 *
 * This file is pure: no Durable Objects, no git. The agents in chat-agent.ts / memory-agent.ts wire it up.
 */
import { generateText, stepCountIs, tool, type LanguageModel, type ToolSet } from "ai";
import { z } from "zod";
import { collectFiles, makeShell, type Shell } from "./shell.ts";
import type { Files } from "./transcripts.ts";

export const ENTRY = "MEMORY.md";
const DREAM_MAX_STEPS = 40;

export type FileChange = { path: string; content: string | null };
export type CommitOutcome =
  | { ok: true; hash: string; head: string; ms?: { clone: number; push: number } }
  | { ok: false; reason: "conflict"; head: string | null; current: { path: string; content: string | null }[] }
  | { ok: false; reason: "error"; message: string };

/** Commit-and-push for chat-time writes. The implementation lives in MemoryAgent.applyEdits. */
export type RepoWriter = { commit(changes: FileChange[], message: string): Promise<CommitOutcome> };

export type Session = { thread: string; message: string };

// ---- prompts -------------------------------------------------------------------------

/** Who the chat agent is. Edit freely; memory instructions are appended after it. */
export const AGENT_PROMPT = `You are a helpful AI agent with a long-term memory of the user. Today is {{today}}.
Be direct and concise. Use what you remember when it's relevant, and say so if something you remember might be out of date.`;

const CONVENTIONS = (today: string) => `## Memory conventions
- MEMORY.md is the entry point, loaded at the start of every conversation. Keep it short: only what every conversation needs (who the user is, what matters right now, key people), plus [[links]] to everything else.
- Everything else lives in files by topic: people/<name>.md, projects/<name>.md, preferences/<topic>.md, places, health, work… Evolve the layout as needed.
- One entry per line, as a bullet, with metadata at the end: \`- Priya is their sister; lives in Pune [source: thread/ab12cd34#m9; added: ${today}]\`. Always include source and added.
- Link files with [[path]] from the repo root, without .md (e.g. [[people/priya]]). Keep each fact in one place and link to it elsewhere; update links when you move or rename files.
- Update or remove entries when information changes. Memory states the current truth; if history matters, say so in the entry ("moved to Berlin in Sept, was Paris").`;

export function chatInstructions(entry: string, today: string, session: Session): string {
  return `${AGENT_PROMPT.replaceAll("{{today}}", today)}

Your memory of the user is a git repo of markdown at /vault. MEMORY.md (below) is always in mind. When the user mentions a person, plan, or anything from before that it doesn't cover, look it up: grep the repo (\`rg -i\`, \`grep -ril\`) and follow [[links]] (cat the linked file).

You also keep this memory up to date yourself, as the conversation happens. When the user tells you something durable (a fact about them, a person and how they relate, a preference, a plan with a date, a decision, a change to something you knew), save it before you reply:
1. Search first: grep for the name or topic and read the file it belongs in. Never create a near-duplicate.
2. Edit with memory_edit (add or change one bullet) or memory_write (new file). Each call is committed and pushed immediately.
3. Cite this conversation as the source: [source: thread/${session.thread}#${session.message}; added: ${today}].
4. If every conversation needs it, also add a short line to MEMORY.md; otherwise link to its file from wherever it fits.
5. If a write is rejected because the file changed, read the current version, write one version that keeps what's true from both, and retry once.
Skip small talk and one-off trivia. Don't narrate that you're saving things; just answer.

${CONVENTIONS(today)}

<memory>
${entry.trim() || "(MEMORY.md is empty: you've only just met the user.)"}
</memory>`;
}

function dreamInstructions(today: string): string {
  return `You are the dreamer: a background agent that periodically maintains a user's memory repo. Today is ${today}.

The memory is a git repo of markdown at /vault. During conversations the chat agent already writes entries as it learns, so most of what happened is probably saved. New material since your last run is in /inbox (read-only):
- <thread>.md: new chat messages, with headings "## <role> · <messageId> · <time>". Cite a message as thread/<thread>#<messageId>.
- note-<id>.md: notes the user wrote or edited themselves (journals, lists, plans, drafts), shown in full. Nothing from notes is in memory yet unless an earlier dream saved it. Treat them as the user speaking in the first person; cite as note/<id>.

Your two jobs:
1. Add new memory. Spot patterns across conversations and notes and save them as new entries (habits, recurring people and themes, how things changed over time). Save anything durable from the inbox that isn't in memory yet, especially from notes, which the chat agent never saw.
2. Clean up memory. Merge duplicates, remove outdated entries, fix broken or missing [[links]], keep MEMORY.md short. When entries contradict each other, check their sources with read_source and keep what the conversation actually says (the most recent statement wins unless the source shows otherwise).

## Tools
- bash: sandboxed shell (ls, cat, rg, grep, find, sed, mv, rm, mkdir, head, wc, tree, …). /vault is writable; /inbox is read-only.
- write_file: write a whole file under /vault. Prefer it over heredocs for multi-line content.
- read_source: read the conversation or note behind a [source: …] ref.
- commit: finish. Call exactly once, at the end, saying what you added, merged, removed, or corrected.

## Process
1. Orient: \`tree /vault\`, read MEMORY.md, skim the inbox.
2. Search before writing. Edit the file a fact belongs in; never create near-duplicates.
3. Make focused edits, then commit.

${CONVENTIONS(today)}

If there is nothing worth changing, say so in the commit message and change nothing.`;
}

// ---- chat-time tools -------------------------------------------------------------------

/**
 * The chat agent's tools: a read-only shell over the repo, and three write tools. Each write is one
 * commit, pushed immediately through `repo`; the local shell view is kept in sync with what landed.
 */
export function chatTools(files: Files, repo: RepoWriter, session: Session): ToolSet {
  const shell = makeShell(files, { writable: false });
  const tag = `chat(${session.thread})`;

  const commit = async (changes: FileChange[], message: string): Promise<string> => {
    const outcome = await repo.commit(changes, `${tag}: ${message}`);
    if (outcome.ok) {
      for (const c of changes) await syncLocal(shell, c.path, c.content);
      const ms = outcome.ms ? ` · clone ${outcome.ms.clone}ms, push ${outcome.ms.push}ms` : "";
      return `committed ${outcome.hash.slice(0, 7)} · ${changes.map((c) => c.path).join(", ")}${ms}`;
    }
    if (outcome.reason === "error") return `error: ${outcome.message}`;
    // Someone else changed these files first (another conversation, or a dream). Show their version.
    for (const c of outcome.current) await syncLocal(shell, c.path, c.content);
    return [
      "rejected: these files changed since you read them, so nothing was saved.",
      "Current version(s) below. Write one version that keeps what's true from both, then retry.",
      ...outcome.current.map((c) => `--- ${c.path} (current)\n${c.content ?? "(deleted)"}`),
    ].join("\n");
  };

  return {
    bash: tool({
      description: "Run a read-only bash command over the memory repo (grep, rg, find, ls, cat). cwd is /vault.",
      inputSchema: z.object({ command: z.string() }),
      execute: async ({ command }) => shell.run(command),
    }),
    memory_write: tool({
      description: "Create or replace a whole file in the memory repo. Committed and pushed immediately.",
      inputSchema: z.object({
        path: z.string().describe("Path from the repo root, e.g. people/priya.md or MEMORY.md"),
        content: z.string(),
        message: z.string().describe("Short commit message: what you're remembering."),
      }),
      execute: async ({ path, content, message }) => {
        const rel = repoPath(path);
        if (!rel) return `refused: ${path} is outside the repo`;
        return commit([{ path: rel, content: withNewline(content) }], message);
      },
    }),
    memory_edit: tool({
      description: "Replace one exact snippet in a memory file (must match once). Committed and pushed immediately. Prefer this for adding or changing a bullet.",
      inputSchema: z.object({
        path: z.string(),
        old: z.string().describe("Exact text currently in the file, unique. To insert, use an existing line and repeat it in `new`."),
        new: z.string(),
        message: z.string(),
      }),
      execute: async ({ path, old, new: replacement, message }) => {
        const rel = repoPath(path);
        if (!rel) return `refused: ${path} is outside the repo`;
        const current = await shell.vault.readFile(`/${rel}`).catch(() => null);
        if (current === null) return `no such file: ${rel} (use memory_write to create it)`;
        const count = current.split(old).length - 1;
        if (count !== 1) return `the snippet matches ${count} times in ${rel}; include more context so it matches exactly once`;
        return commit([{ path: rel, content: current.replace(old, replacement) }], message);
      },
    }),
    memory_delete: tool({
      description: "Delete a memory file (after merging its content elsewhere). Committed and pushed immediately.",
      inputSchema: z.object({ path: z.string(), message: z.string() }),
      execute: async ({ path, message }) => {
        const rel = repoPath(path);
        if (!rel) return `refused: ${path} is outside the repo`;
        return commit([{ path: rel, content: null }], message);
      },
    }),
  };
}

// ---- dreaming ----------------------------------------------------------------------------

export type DreamLog = (kind: "bash" | "write" | "info", text: string, detail?: string) => void;
export type DreamResult = { ok: true; files: Files; message: string } | { ok: false; reason: string };

/**
 * One dream: a coding-agent loop over a writable copy of the repo plus the new transcripts.
 * Returns the repo's next state; the caller commits it as a single commit.
 */
export async function dream(input: {
  files: Files;
  inbox: Files;
  model: LanguageModel;
  today: string;
  log: DreamLog;
  readSource: (ref: string) => Promise<string>;
  /** Checked after each step; true ends the dream early (without a commit). */
  stop?: () => boolean;
}): Promise<DreamResult> {
  const { files, inbox, model, today, log, readSource, stop = () => false } = input;
  const shell = makeShell(files, { writable: true, inbox });
  let message: string | null = null;

  await generateText({
    model,
    instructions: dreamInstructions(today),
    prompt: `Inbox files: ${Object.keys(inbox).map((f) => `/inbox/${f}`).join(", ") || "(none)"}. The repo has ${Object.keys(files).length} files. Begin.`,
    stopWhen: [stepCountIs(DREAM_MAX_STEPS), () => message !== null, stop],
    tools: {
      bash: tool({
        description: "Run a bash command in the sandbox. cwd is /vault.",
        inputSchema: z.object({ command: z.string() }),
        execute: async ({ command }) => {
          const output = await shell.run(command);
          log("bash", command, output);
          return output;
        },
      }),
      write_file: tool({
        description: "Create or overwrite a file under /vault with the full content given.",
        inputSchema: z.object({ path: z.string(), content: z.string() }),
        execute: async ({ path, content }) => {
          const rel = repoPath(path);
          if (!rel) return `refused: ${path} is outside /vault`;
          await syncLocal(shell, rel, withNewline(content));
          log("write", rel, content);
          return `wrote /vault/${rel} (${content.length} chars)`;
        },
      }),
      read_source: tool({
        description: "Read what a [source: …] ref points at: thread/ab12cd34#msgId (a conversation) or note/ab12cd34 (a note).",
        inputSchema: z.object({ ref: z.string() }),
        execute: async ({ ref }) => {
          const text = await readSource(ref);
          log("bash", `read_source ${ref}`, text);
          return text;
        },
      }),
      commit: tool({
        description: "Finish the dream and commit the repo. Call exactly once, last.",
        inputSchema: z.object({ message: z.string().describe("What you added, merged, removed, or corrected.") }),
        execute: async ({ message: m }) => {
          message = m;
          return "ok";
        },
      }),
    },
  });

  if (message === null) return { ok: false, reason: stop() ? "stopped at the usage limit without calling commit" : `stopped after ${DREAM_MAX_STEPS} steps without calling commit` };
  return { ok: true, files: await collectFiles(shell.vault), message };
}

// ---- helpers ---------------------------------------------------------------------------

const withNewline = (s: string) => (s.endsWith("\n") ? s : `${s}\n`);

async function syncLocal(shell: Shell, rel: string, content: string | null) {
  if (content === null) {
    await shell.vault.rm(`/${rel}`, { force: true });
    return;
  }
  const dir = rel.includes("/") ? `/${rel.slice(0, rel.lastIndexOf("/"))}` : "/";
  await shell.vault.mkdir(dir, { recursive: true });
  await shell.vault.writeFile(`/${rel}`, withNewline(content));
}

/** Normalize a model-supplied path to a repo-relative one, or null if it escapes /vault. */
function repoPath(path: string): string | null {
  const rel = path.replace(/^\/vault\/?/, "").replace(/^\/+/, "");
  if (!rel || rel.split("/").some((part) => part === ".." || part === "")) return null;
  return rel;
}
