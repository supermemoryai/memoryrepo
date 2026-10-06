import { Bash, InMemoryFs, MountableFs, type IFileSystem } from "just-bash";
import type { Files } from "./vault.ts";

const OUTPUT_LIMIT = 16_000;

const WRITE_METHODS = new Set([
  "writeFile",
  "appendFile",
  "mkdir",
  "createExclusive",
  "rm",
  "cp",
  "mv",
  "chmod",
  "symlink",
  "link",
  "utimes",
]);

/** Wraps a filesystem so every mutation fails with EROFS. */
function readOnly(fs: IFileSystem): IFileSystem {
  return new Proxy(fs, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && WRITE_METHODS.has(prop)) {
        return async () => {
          throw Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" });
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function seed(files: Files): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([path, content]) => [`/${path}`, content]));
}

export type Shell = {
  run(command: string): Promise<string>;
  vault: InMemoryFs;
};

/**
 * A just-bash shell with the vault at /vault.
 * Chat gets it read-only; the dreamer gets it writable plus an /inbox of new transcripts.
 */
export function makeShell(files: Files, opts: { writable: boolean; inbox?: Files }): Shell {
  const vault = new InMemoryFs(seed(files));
  const mounts = [{ mountPoint: "/vault", filesystem: opts.writable ? vault : readOnly(vault) }];
  if (opts.inbox) mounts.push({ mountPoint: "/inbox", filesystem: readOnly(new InMemoryFs(seed(opts.inbox))) });
  const bash = new Bash({ fs: new MountableFs({ base: new InMemoryFs(), mounts }), cwd: "/vault" });
  return {
    vault,
    async run(command) {
      const result = await bash.exec(command, { signal: AbortSignal.timeout(20_000) });
      let out = result.stdout;
      if (result.stderr) out += (out ? "\n" : "") + result.stderr;
      if (result.exitCode !== 0) out += `\n[exit ${result.exitCode}]`;
      if (out.length > OUTPUT_LIMIT) out = `${out.slice(0, OUTPUT_LIMIT)}\n… [truncated ${out.length - OUTPUT_LIMIT} chars]`;
      return out || "(no output)";
    },
  };
}

/** Every regular file in a mounted vault fs, keyed by vault-relative path. */
export async function collectFiles(fs: InMemoryFs): Promise<Files> {
  const out: Files = {};
  for (const path of fs.getAllPaths()) {
    const stat = await fs.stat(path).catch(() => null);
    if (!stat?.isFile) continue;
    out[path.replace(/^\/+/, "")] = await fs.readFile(path);
  }
  return out;
}
