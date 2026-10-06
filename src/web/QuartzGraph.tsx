import { useEffect, useMemo, useRef } from "react";
import type { Graph } from "../shared/links.ts";
import { GLOBAL_GRAPH, PERSPECTIVE_GRAPH, renderGraph, type GraphConfig, type GraphData, type GraphHandle } from "./quartzGraph.ts";

/** Full-screen view keeps Quartz's global settings but still highlights the open note. */
const GLOBAL_PERSPECTIVE: GraphConfig = { ...GLOBAL_GRAPH, focusCurrent: true, scale: 1 };

/** Real notes only; Quartz drops links to pages that don't exist. */
function toData(graph: Graph): GraphData {
  const data: GraphData = new Map();
  for (const n of graph.nodes) if (!n.ghost) data.set(n.id, { title: n.label, links: [] });
  for (const e of graph.edges) data.get(e.source)?.links.push(e.target);
  return data;
}

function GraphCanvas({
  graph,
  current,
  config,
  onNavigate,
  className,
}: {
  graph: Graph;
  current: string | null;
  config: GraphConfig;
  onNavigate: (id: string) => void;
  className: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const navigate = useRef(onNavigate);
  navigate.current = onNavigate;
  const data = useMemo(() => toData(graph), [graph]);
  const handle = useRef<GraphHandle | null>(null);
  const currentRef = useRef(current);
  currentRef.current = current;

  // Rebuild only when the data or config changes; focus changes go through setCurrent
  // when the config follows the current note, so the layout doesn't jump.
  const rebuildKey = config.focusCurrent ? null : current;
  useEffect(() => {
    const container = el.current;
    if (!container) return;
    let cancelled = false;
    void renderGraph(container, data, currentRef.current, config, (id) => navigate.current(id)).then((h) => {
      if (cancelled) h.destroy();
      else handle.current = h;
    });
    return () => {
      cancelled = true;
      handle.current?.destroy();
      handle.current = null;
    };
  }, [data, config, rebuildKey]);

  useEffect(() => {
    handle.current?.setCurrent(current);
  }, [current]);

  return <div ref={el} className={className} />;
}

const GLOBAL_ICON = (
  <svg viewBox="0 0 55 55" fill="currentColor" aria-hidden>
    <path d="M49,0c-3.309,0-6,2.691-6,6c0,1.035,0.263,2.009,0.726,2.86l-9.829,9.829C32.542,17.634,30.846,17,29,17s-3.542,0.634-4.898,1.688l-7.669-7.669C16.785,10.424,17,9.74,17,9c0-2.206-1.794-4-4-4S9,6.794,9,9s1.794,4,4,4c0.74,0,1.424-0.215,2.019-0.567l7.669,7.669C21.634,21.458,21,23.154,21,25s0.634,3.542,1.688,4.897L10.024,42.562C8.958,41.595,7.549,41,6,41c-3.309,0-6,2.691-6,6s2.691,6,6,6s6-2.691,6-6c0-1.035-0.263-2.009-0.726-2.86l12.829-12.829c1.106,0.86,2.44,1.436,3.898,1.619v10.16c-2.833,0.478-5,2.942-5,5.91c0,3.309,2.691,6,6,6s6-2.691,6-6c0-2.967-2.167-5.431-5-5.91v-10.16c1.458-0.183,2.792-0.759,3.898-1.619l7.669,7.669C41.215,39.576,41,40.26,41,41c0,2.206,1.794,4,4,4s4-1.794,4-4s-1.794-4-4-4c-0.74,0-1.424,0.215-2.019,0.567l-7.669-7.669C36.366,28.542,37,26.846,37,25s-0.634-3.542-1.688-4.897l9.665-9.665C46.042,11.405,47.451,12,49,12c3.309,0,6-2.691,6-6S52.309,0,49,0z M11,9c0-1.103,0.897-2,2-2s2,0.897,2,2s-0.897,2-2,2S11,10.103,11,9z M6,51c-2.206,0-4-1.794-4-4s1.794-4,4-4s4,1.794,4,4S8.206,51,6,51z M33,49c0,2.206-1.794,4-4,4s-4-1.794-4-4s1.794-4,4-4S33,46.794,33,49z M29,31c-3.309,0-6-2.691-6-6s2.691-6,6-6s6,2.691,6,6S32.309,31,29,31z M47,41c0,1.103-0.897,2-2,2s-2-0.897-2-2s0.897-2,2-2S47,39.897,47,41z M49,10c-2.206,0-4-1.794-4-4s1.794-4,4-4s4,1.794,4,4S51.206,10,49,10z" />
  </svg>
);

/** Sidebar graph: the whole vault from the current note's perspective. */
export function LocalGraph({
  graph,
  current,
  onNavigate,
  onOpenGlobal,
}: {
  graph: Graph;
  current: string | null;
  onNavigate: (id: string) => void;
  onOpenGlobal: () => void;
}) {
  return (
    <div className="qgraph">
      <h3 className="label">graph view</h3>
      <div className="qgraph-outer">
        <GraphCanvas className="qgraph-container" graph={graph} current={current} config={PERSPECTIVE_GRAPH} onNavigate={onNavigate} />
        <button className="qgraph-icon" aria-label="Global graph (⌘G)" title="Global graph (⌘G)" onClick={onOpenGlobal}>
          {GLOBAL_ICON}
        </button>
      </div>
    </div>
  );
}

/** Quartz's global graph: every note, radial layout, focus on hover. Esc or click outside to close. */
export function GlobalGraph({
  graph,
  current,
  onNavigate,
  onClose,
}: {
  graph: Graph;
  current: string | null;
  onNavigate: (id: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="qgraph-global" onClick={onClose}>
      <div className="qgraph-global-container" onClick={(e) => e.stopPropagation()}>
        <GraphCanvas className="qgraph-container" graph={graph} current={current} config={GLOBAL_PERSPECTIVE} onNavigate={onNavigate} />
        <div className="qgraph-hint mono">scroll to zoom · drag nodes · click to open · esc to close</div>
      </div>
    </div>
  );
}
