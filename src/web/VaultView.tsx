import { useEffect, useState } from "react";
import { resolveLink, type Graph } from "../shared/links.ts";
import type { Memory } from "./App.tsx";
import { Markdown, splitFrontmatter } from "./Markdown.tsx";
import { GlobalGraph, LocalGraph } from "./QuartzGraph.tsx";
import { Tree } from "./Tree.tsx";
import { short } from "./format.ts";
import { addToVisited } from "./quartzGraph.ts";

export function VaultView({
  memory,
  head,
  openPath,
  onSource,
}: {
  memory: Memory;
  head: string | null;
  openPath?: string | null;
  onSource?: (thread: string, message?: string) => void;
}) {
  const [paths, setPaths] = useState<string[]>([]);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [globalOpen, setGlobalOpen] = useState(false);

  useEffect(() => {
    if (!head) {
      setPaths([]);
      setGraph(null);
      return;
    }
    void memory.stub.tree(head).then(({ paths }) => {
      setPaths(paths);
      setSelected((current) =>
        openPath && paths.includes(openPath) ? openPath : current && paths.includes(current) ? current : paths.includes("MEMORY.md") ? "MEMORY.md" : paths.includes("PROFILE.md") ? "PROFILE.md" : (paths[0] ?? null),
      );
    });
    void memory.stub.graph(head).then(setGraph);
  }, [memory, head, openPath]);

  // Quartz binds ⌘/Ctrl+G to the global graph.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "g" && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
        e.preventDefault();
        setGlobalOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (selected) addToVisited(selected);
  }, [selected]);

  if (!head) {
    return (
      <div className="empty center">
        <div className="empty-title">empty vault</div>
        <p className="muted">Nothing has been dreamt yet. Chat for a bit, then hit Dream now.</p>
      </div>
    );
  }

  const open = (path: string) => {
    setSelected(path);
    setGlobalOpen(false);
  };
  const backlinks = graph && selected ? graph.edges.filter((e) => e.target === selected).map((e) => e.source) : [];
  const unresolved = graph && selected ? graph.edges.filter((e) => e.source === selected && e.target.startsWith("?")).map((e) => e.target.slice(1)) : [];

  return (
    <div className="split">
      <div className="split-side">
        <div className="pane-head mono">
          vault @ {short(head)} · {paths.length} files
          <button className="seg-btn graph-open" onClick={() => setGlobalOpen(true)} title="Global graph (⌘G)">
            graph ⌘G
          </button>
        </div>
        <div className="split-tree">
          <Tree paths={paths} selected={selected} onSelect={open} />
        </div>
      </div>
      <div className="split-main note-layout">
        {selected && (
          <FileView
            key={`${head}:${selected}`}
            memory={memory}
            refHash={head}
            path={selected}
            onLink={(target) => {
              const path = resolveLink(target, paths);
              if (path) open(path);
            }}
            onSource={onSource}
          />
        )}
        <aside className="note-side">
          {graph ? (
            <LocalGraph graph={graph} current={selected} onNavigate={open} onOpenGlobal={() => setGlobalOpen(true)} />
          ) : (
            <div className="muted mono">building graph…</div>
          )}
          <div className="links-box">
            <h3 className="label">backlinks · {backlinks.length}</h3>
            {backlinks.length === 0 ? (
              <div className="muted mono">no backlinks found</div>
            ) : (
              <ul>
                {backlinks.map((p) => (
                  <li key={p}>
                    <button className="mono link-btn" onClick={() => open(p)}>
                      {p.replace(/\.md$/, "")}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {unresolved.length > 0 && (
              <>
                <h3 className="label">unresolved · {unresolved.length}</h3>
                <ul>
                  {unresolved.map((t) => (
                    <li key={t} className="mono muted">
                      [[{t}]]
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </aside>
      </div>
      {globalOpen && graph && <GlobalGraph graph={graph} current={selected} onNavigate={open} onClose={() => setGlobalOpen(false)} />}
    </div>
  );
}

function FileView({
  memory,
  refHash,
  path,
  onLink,
  onSource,
}: {
  memory: Memory;
  refHash: string;
  path: string;
  onLink: (target: string) => void;
  onSource?: (thread: string, message?: string) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);

  useEffect(() => {
    void memory.stub.file(refHash, path).then((t) => setText(t ?? ""));
  }, [memory, refHash, path]);

  const { front, body } = splitFrontmatter(text ?? "");
  return (
    <div className="file">
      <div className="pane-head file-head">
        <span className="mono">{path}</span>
        <div className="seg">
          <button className={`seg-btn ${!raw ? "active" : ""}`} onClick={() => setRaw(false)}>
            rendered
          </button>
          <button className={`seg-btn ${raw ? "active" : ""}`} onClick={() => setRaw(true)}>
            raw
          </button>
        </div>
      </div>
      <div className="file-body">
        {text === null ? (
          <div className="muted mono">loading…</div>
        ) : raw ? (
          <pre className="raw mono">{text}</pre>
        ) : (
          <>
            {front && <pre className="frontmatter mono">{front}</pre>}
            <Markdown text={body} onLink={onLink} onSource={onSource} />
          </>
        )}
      </div>
    </div>
  );
}
