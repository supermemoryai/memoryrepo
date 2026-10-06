import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { Volume, createFsFromVolume } from "memfs";

export type Files = Record<string, string>;
export type FileStatus = "added" | "modified" | "deleted";
export type Commit = { hash: string; message: string; committedAt: number; parents: string[] };
export type Change = { path: string; status: FileStatus };

const AUTHOR = { name: "dreamer", email: "dreamer@markdown-memory.local" };
const READ_CONCURRENCY = 8;

/** Run fn over items with at most `limit` in flight. */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Prefix errors with the git step that failed. */
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
const DIR = "/repo";

/** A user's vault: one Artifacts repo. Reads go through the binding, writes through git. */
export class Vault {
  constructor(
    private readonly ns: Artifacts,
    readonly repoName: string,
    private readonly remote: string,
  ) {}

  async head(): Promise<Commit | null> {
    const [latest] = await this.log(1);
    return latest ?? null;
  }

  async log(limit = 100): Promise<Commit[]> {
    using repo = await this.ns.get(this.repoName);
    try {
      const commits = await repo.log({ ref: "main", limit });
      return commits.map((c) => ({ hash: c.hash, message: c.message, committedAt: c.committedAt, parents: c.parents }));
    } catch {
      // A repo with no commits has no main ref yet.
      return [];
    }
  }

  /** Every file at a commit, path → blob hash. */
  async blobs(commitHash: string): Promise<Record<string, string>> {
    using repo = await this.ns.get(this.repoName);
    const commit = await repo.readCommit(commitHash);
    if (!commit) throw new Error(`unknown commit ${commitHash}`);
    const out: Record<string, string> = {};
    const walk = async (treeHash: string, prefix: string) => {
      const entries = (await repo.readTree(treeHash)) ?? [];
      for (const entry of entries) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.type === "tree") await walk(entry.hash, path);
        else if (entry.type === "blob" || entry.type === "exec") out[path] = entry.hash;
      }
    };
    await walk(commit.treeHash, "");
    return out;
  }

  /** Full contents of every file at a commit. */
  async files(commitHash: string): Promise<Files> {
    const blobs = await this.blobs(commitHash);
    using repo = await this.ns.get(this.repoName);
    const out: Files = {};
    // Bounded: a vault of hundreds of notes would otherwise fire hundreds of binding reads at once.
    await mapLimit(Object.entries(blobs), READ_CONCURRENCY, async ([path, hash]) => {
      const blob = await repo.readBlob(hash);
      out[path] = blob ? await blob.text() : "";
    });
    return out;
  }

  /** Estimated token count of each blob (≈4 chars/token), for repo-size history. */
  async blobTokens(hashes: string[]): Promise<Map<string, number>> {
    using repo = await this.ns.get(this.repoName);
    const out = new Map<string, number>();
    await mapLimit(hashes, READ_CONCURRENCY, async (hash) => {
      const blob = await repo.readBlob(hash);
      out.set(hash, blob ? Math.ceil((await blob.text()).length / 4) : 0);
    });
    return out;
  }

  async readFile(ref: string, path: string): Promise<string | null> {
    using repo = await this.ns.get(this.repoName);
    const blob = await repo.readFile({ ref, path });
    return blob ? blob.text() : null;
  }

  /** What a commit changed relative to its first parent. */
  async changes(commitHash: string): Promise<{ commit: Commit; parent: string | null; changes: Change[] }> {
    using repo = await this.ns.get(this.repoName);
    const meta = await repo.readCommit(commitHash);
    if (!meta) throw new Error(`unknown commit ${commitHash}`);
    const parent = meta.parents[0] ?? null;
    const [after, before] = await Promise.all([this.blobs(commitHash), parent ? this.blobs(parent) : Promise.resolve<Record<string, string>>({})]);
    const changes: Change[] = [];
    for (const [path, hash] of Object.entries(after)) {
      if (!(path in before)) changes.push({ path, status: "added" });
      else if (before[path] !== hash) changes.push({ path, status: "modified" });
    }
    for (const path of Object.keys(before)) if (!(path in after)) changes.push({ path, status: "deleted" });
    changes.sort((a, b) => a.path.localeCompare(b.path));
    const commit = { hash: meta.hash, message: meta.message, committedAt: meta.committedAt, parents: meta.parents };
    return { commit, parent, changes };
  }

  /**
   * Make one commit that turns `base` into `next` and push it.
   * `base` must be the tree at `parent` (null for an empty repo).
   */
  async commit(parent: string | null, next: Files, message: string): Promise<{ hash: string; changes: Change[]; ms: { clone: number; push: number } } | null> {
    const token = await this.cachedToken();
    const onAuth = () => ({ username: "x", password: token });

    // Reuse the working copy from our last push when HEAD is still where we left it: chat-time memory
    // makes several small commits per turn, and a fresh clone per commit dominated their latency.
    const t0 = Date.now();
    const cached = workingCopies.get(this.remote);
    let fs: MemFs;
    if (parent && cached?.head === parent) {
      fs = cached.fs;
    } else {
      fs = createFsFromVolume(new Volume());
      if (parent) {
        await step("clone", () => git.clone({ fs, http, dir: DIR, url: this.remote, ref: "main", singleBranch: true, depth: 1, onAuth }));
      } else {
        await git.init({ fs, dir: DIR, defaultBranch: "main" });
      }
    }
    const cloneMs = Date.now() - t0;

    const current = await readWorkingTree(fs);
    const changes: Change[] = [];
    for (const [path, content] of Object.entries(next)) {
      if (current[path] === content) continue;
      changes.push({ path, status: path in current ? "modified" : "added" });
      const full = `${DIR}/${path}`;
      await fs.promises.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
      await fs.promises.writeFile(full, content);
      await git.add({ fs, dir: DIR, filepath: path });
    }
    for (const path of Object.keys(current)) {
      if (path in next) continue;
      changes.push({ path, status: "deleted" });
      await fs.promises.unlink(`${DIR}/${path}`);
      await git.remove({ fs, dir: DIR, filepath: path });
    }
    if (changes.length === 0) {
      if (parent) workingCopies.set(this.remote, { fs, head: parent });
      return null;
    }

    const hash = await step("commit", () => git.commit({ fs, dir: DIR, message, author: AUTHOR }));
    const t1 = Date.now();
    try {
      await step(`push (${changes.length} changed files)`, () =>
        git.push({ fs, http, dir: DIR, url: this.remote, ref: "main", remoteRef: "main", onAuth }),
      );
    } catch (error) {
      // The working copy now holds an unpushed commit; never reuse it.
      workingCopies.delete(this.remote);
      throw error;
    }
    workingCopies.set(this.remote, { fs, head: hash });
    return { hash, changes, ms: { clone: cloneMs, push: Date.now() - t1 } };
  }

  /** Write tokens last 15 minutes; reuse one for 10. */
  private async cachedToken(): Promise<string> {
    const hit = tokens.get(this.remote);
    if (hit && hit.expires > Date.now()) return hit.token;
    const token = await step("token", () => this.token());
    tokens.set(this.remote, { token, expires: Date.now() + 10 * 60_000 });
    return token;
  }

  private async token(): Promise<string> {
    using repo = await this.ns.get(this.repoName);
    const { plaintext } = await repo.createToken("write", 900);
    return plaintext.split("?expires=")[0]!;
  }
}

type MemFs = ReturnType<typeof createFsFromVolume>;

/** Per-isolate caches, keyed by remote: the last pushed working copy, and a write token. */
const workingCopies = new Map<string, { fs: MemFs; head: string }>();
const tokens = new Map<string, { token: string; expires: number }>();

async function readWorkingTree(fs: MemFs): Promise<Files> {
  const out: Files = {};
  const walk = async (dir: string) => {
    let entries: string[];
    try {
      entries = (await fs.promises.readdir(dir)) as string[];
    } catch {
      return;
    }
    for (const name of entries) {
      if (dir === DIR && name === ".git") continue;
      const full = `${dir}/${name}`;
      const stat = await fs.promises.stat(full);
      if (stat.isDirectory()) await walk(full);
      else out[full.slice(DIR.length + 1)] = String(await fs.promises.readFile(full, "utf8"));
    }
  };
  await walk(DIR);
  return out;
}
