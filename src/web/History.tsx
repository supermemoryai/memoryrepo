import { MultiFileDiff } from "@pierre/diffs/react";
import type { GitStatusEntry } from "@pierre/trees";
import { useEffect, useMemo, useState } from "react";
import type { Change, Commit } from "../server/vault.ts";
import type { Memory } from "./App.tsx";
import { Tree } from "./Tree.tsx";
import { short, stamp } from "./format.ts";

type Detail = { commit: Commit; parent: string | null; changes: Change[]; paths: string[] };

export function History({ memory, head }: { memory: Memory; head: string | null }) {
  const [commits, setCommits] = useState<Commit[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    void memory.stub.history().then((list) => {
      setCommits(list);
      setSelected((current) => current ?? list[0]?.hash ?? null);
    });
  }, [memory, head]);

  if (commits && commits.length === 0) {
    return (
      <div className="empty center">
        <div className="empty-title">no history</div>
        <p className="muted">Every dream is one commit. None yet.</p>
      </div>
    );
  }

  return (
    <div className="history">
      <ol className="commits">
        {(commits ?? []).map((c, i) => (
          <li key={c.hash}>
            <button className={`commit ${c.hash === selected ? "active" : ""}`} onClick={() => setSelected(c.hash)}>
              <span className="commit-top mono">
                <span className="commit-hash">{short(c.hash)}</span>
                <span className="muted">{stamp(c.committedAt)}</span>
              </span>
              <span className="commit-msg">{c.message.split("\n")[0]}</span>
              {i === 0 && <span className="tag mono">HEAD</span>}
            </button>
          </li>
        ))}
      </ol>
      {selected && <CommitView key={selected} memory={memory} hash={selected} />}
    </div>
  );
}

function CommitView({ memory, hash }: { memory: Memory; hash: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [path, setPath] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([memory.stub.commitChanges(hash), memory.stub.tree(hash)]).then(([changes, tree]) => {
      const deleted = changes.changes.filter((c) => c.status === "deleted").map((c) => c.path);
      setDetail({ ...changes, paths: [...tree.paths, ...deleted].sort() });
      setPath(changes.changes[0]?.path ?? null);
    });
  }, [memory, hash]);

  const gitStatus = useMemo<GitStatusEntry[]>(
    () => detail?.changes.map((c) => ({ path: c.path, status: c.status })) ?? [],
    [detail],
  );

  if (!detail) return <div className="commit-view muted mono pad">loading…</div>;
  const counts = { added: 0, modified: 0, deleted: 0 };
  for (const c of detail.changes) counts[c.status]++;

  return (
    <div className="commit-view">
      <div className="commit-header">
        <div className="commit-meta mono">
          <span className="commit-hash">{short(detail.commit.hash)}</span>
          <span className="muted">{stamp(detail.commit.committedAt)}</span>
          <span className="add">+{counts.added}</span>
          <span className="mod">~{counts.modified}</span>
          <span className="del">−{counts.deleted}</span>
          {detail.parent && <span className="muted">parent {short(detail.parent)}</span>}
        </div>
        <p className="commit-body">{detail.commit.message}</p>
      </div>
      <div className="split">
        <div className="split-side">
          <div className="split-tree">
            <Tree paths={detail.paths} gitStatus={gitStatus} selected={path} onSelect={setPath} />
          </div>
        </div>
        <div className="split-main">
          {path && (
            <FileDiff
              key={path}
              memory={memory}
              path={path}
              hash={hash}
              parent={detail.parent}
              change={detail.changes.find((c) => c.path === path)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function FileDiff({
  memory,
  path,
  hash,
  parent,
  change,
}: {
  memory: Memory;
  path: string;
  hash: string;
  parent: string | null;
  change?: Change;
}) {
  const [files, setFiles] = useState<{ before: string | null; after: string | null } | null>(null);

  useEffect(() => {
    void Promise.all([
      parent ? memory.stub.file(parent, path) : Promise.resolve(null),
      memory.stub.file(hash, path),
    ]).then(([before, after]) => setFiles({ before, after }));
  }, [memory, path, hash, parent]);

  if (!files) return <div className="muted mono pad">loading…</div>;
  const before = files.before ?? "";
  const after = files.after ?? "";

  return (
    <div className="diff">
      <div className="pane-head mono">
        {path} <span className={`status status-${change?.status ?? "same"}`}>{change?.status ?? "unchanged in this commit"}</span>
      </div>
      <div className="diff-body">
        <MultiFileDiff
          oldFile={{ name: path, contents: before }}
          newFile={{ name: path, contents: after }}
          options={{
            theme: { dark: "github-dark-default", light: "github-light-default" },
            themeType: "system",
            diffStyle: "unified",
            overflow: "wrap",
            disableFileHeader: true,
          }}
        />
      </div>
    </div>
  );
}
