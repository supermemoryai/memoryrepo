#!/usr/bin/env node
// Runs the Alchemy CLI under real Node.
//
// Under Bun, Alchemy's dev proxy currently drops WebSocket upgrades, and the agents talk over
// WebSockets, so the UI would load but never connect. `bun run` can also make `node` point at
// Bun's own shim (when it can't find Node on PATH), so check, and re-launch with a real Node.
import { spawnSync } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "node_modules/alchemy/bin/cli.js");
const args = process.argv.slice(2);

// `bun run` also exports package-manager variables (npm_config_user_agent=bun/…, npm_execpath, BUN_*)
// that make the dev server pick its Bun code paths even under Node, which breaks WebSocket upgrades.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(npm_|BUN_)/i.test(k)));

function realNode() {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, "node");
    try {
      accessSync(candidate, constants.X_OK);
      const real = realpathSync(candidate);
      if (/\bbun(\.exe)?$/.test(path.basename(real))) continue; // Bun's node shim
      const probe = spawnSync(candidate, ["-e", "process.stdout.write(typeof Bun)"], { encoding: "utf8" });
      if (probe.status === 0 && probe.stdout === "undefined") return candidate;
    } catch {}
  }
  return null;
}

if (typeof Bun === "undefined") {
  // Already real Node.
  const { status } = spawnSync(process.execPath, [cli, ...args], { stdio: "inherit", env });
  process.exit(status ?? 1);
}

const node = realNode();
if (!node) {
  console.error(
    "markdown-memory needs Node.js (22+) to run Alchemy: under Bun, its dev proxy drops WebSocket upgrades.\n" +
      "Install Node (https://nodejs.org or nvm) and make sure `node` is on your PATH, then run `bun run dev` again.",
  );
  process.exit(1);
}
const { status } = spawnSync(node, [cli, ...args], { stdio: "inherit", env });
process.exit(status ?? 1);
