import assert from "node:assert/strict";
import { test } from "node:test";

import { makeShell } from "../src/server/shell.ts";

test("a redirect onto the read-only vault returns an error instead of throwing", async () => {
  const shell = makeShell({ "a.md": "hello" }, { writable: false });
  const out = await shell.run("echo changed > a.md");
  assert.match(out, /EROFS/);
  assert.match(out, /\[exit 1\]$/);
  assert.equal(await shell.run("cat a.md"), "hello");
});

test("an append redirect onto the read-only inbox returns an error instead of throwing", async () => {
  const shell = makeShell({}, { writable: true, inbox: { "t.md": "x" } });
  const out = await shell.run("echo more >> /inbox/t.md");
  assert.match(out, /EROFS/);
});

test("a redirect inside the writable vault still works", async () => {
  const shell = makeShell({}, { writable: true });
  assert.equal(await shell.run("echo hi > n.md"), "(no output)");
  assert.equal(await shell.run("cat n.md"), "hi\n");
});
