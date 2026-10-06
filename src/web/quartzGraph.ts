/**
 * Graph renderer ported from Quartz's graph view
 * (https://github.com/quartz-community/graph, src/components/scripts/graph.inline.ts, MIT © jackyzha0).
 * Same forces, PixiJS rendering, hover focus, zoom-faded labels, and visited colouring;
 * adapted to take data and a navigate callback instead of reading the page.
 */
import * as d3 from "d3";
import { Application, Container, Graphics, Text } from "pixi.js";

export type GraphConfig = {
  drag: boolean;
  zoom: boolean;
  /** -1 for the whole graph, otherwise neighbourhood depth around `current`. */
  depth: number;
  scale: number;
  repelForce: number;
  centerForce: number;
  linkDistance: number;
  fontSize: number;
  opacityScale: number;
  focusOnHover: boolean;
  enableRadial: boolean;
  /**
   * Show the whole graph from the current note's perspective: the note and its
   * neighbours stay lit and labelled, everything else fades, and the camera
   * centres on the note (and glides to the next one when it changes).
   */
  focusCurrent: boolean;
};

export const LOCAL_GRAPH: GraphConfig = {
  drag: true,
  zoom: true,
  depth: 1,
  scale: 1.1,
  repelForce: 0.5,
  centerForce: 0.3,
  linkDistance: 30,
  fontSize: 0.6,
  opacityScale: 1,
  focusOnHover: false,
  enableRadial: false,
  focusCurrent: false,
};

export const GLOBAL_GRAPH: GraphConfig = {
  drag: true,
  zoom: true,
  depth: -1,
  scale: 0.9,
  repelForce: 0.5,
  centerForce: 0.2,
  linkDistance: 30,
  fontSize: 0.6,
  opacityScale: 1,
  focusOnHover: true,
  enableRadial: true,
  focusCurrent: false,
};

/** The whole vault, seen from the open note. */
export const PERSPECTIVE_GRAPH: GraphConfig = { ...GLOBAL_GRAPH, scale: 1.4, focusCurrent: true };

export type GraphHandle = { destroy: () => void; setCurrent: (id: string | null) => void };

/** id → { title, outgoing link ids }. */
export type GraphData = Map<string, { title: string; links: string[] }>;

type NodeData = d3.SimulationNodeDatum & { id: string; text: string };
type LinkData = d3.SimulationLinkDatum<NodeData> & { source: NodeData; target: NodeData };
type NodeRender = { simulationData: NodeData; gfx: Graphics; label: Text; active: boolean };
type LinkRender = { simulationData: LinkData; gfx: Graphics; color: string; alpha: number; active: boolean };

const VISITED_KEY = "mm:graph-visited";

export function getVisited(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(VISITED_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

export function addToVisited(id: string) {
  try {
    const visited = getVisited();
    visited.add(id);
    localStorage.setItem(VISITED_KEY, JSON.stringify([...visited]));
  } catch {}
}

/** Resolves CSS color values (var(), calc()) through the browser so PixiJS can parse them. */
function resolveColor(value: string, fallback: string): string {
  if (!value) return fallback;
  const el = document.createElement("div");
  el.style.color = value;
  el.style.position = "absolute";
  el.style.visibility = "hidden";
  document.body.appendChild(el);
  const resolved = getComputedStyle(el).color;
  el.remove();
  return resolved || fallback;
}

/** Renders into `graph`. The handle can move the focus without rebuilding the simulation. */
export async function renderGraph(
  graph: HTMLElement,
  data: GraphData,
  initialCurrent: string | null,
  config: GraphConfig,
  onNavigate: (id: string) => void,
): Promise<GraphHandle> {
  const {
    drag: enableDrag,
    zoom: enableZoom,
    depth,
    scale,
    repelForce,
    centerForce,
    linkDistance,
    fontSize,
    opacityScale,
    focusOnHover,
    enableRadial,
    focusCurrent,
  } = config;
  let current = initialCurrent;
  const visited = getVisited();
  graph.replaceChildren();

  const width = graph.offsetWidth;
  const height = Math.max(graph.offsetHeight, 250);

  const links: { source: string; target: string }[] = [];
  const validLinks = new Set(data.keys());
  data.forEach((details, source) => {
    for (const dest of details.links) {
      if (validLinks.has(dest)) links.push({ source, target: dest });
    }
  });

  const neighbourhood = new Set<string>();
  if (depth >= 0 && current) {
    let queue = [current];
    const seen = new Set([current]);
    for (let d = 0; d <= depth && queue.length > 0; d++) {
      const nextQueue: string[] = [];
      for (const cur of queue) {
        neighbourhood.add(cur);
        for (const link of links) {
          if (link.source === cur && !seen.has(link.target)) {
            seen.add(link.target);
            nextQueue.push(link.target);
          }
          if (link.target === cur && !seen.has(link.source)) {
            seen.add(link.source);
            nextQueue.push(link.source);
          }
        }
      }
      queue = nextQueue;
    }
  } else {
    validLinks.forEach((id) => neighbourhood.add(id));
  }

  const nodes: NodeData[] = [];
  const nodeMap = new Map<string, NodeData>();
  neighbourhood.forEach((url) => {
    const node: NodeData = {
      id: url,
      text: data.get(url)?.title || url,
      x: Math.random() * width - width / 2,
      y: Math.random() * height - height / 2,
      vx: 0,
      vy: 0,
    };
    nodes.push(node);
    nodeMap.set(url, node);
  });

  const graphLinks: LinkData[] = [];
  for (const link of links) {
    if (neighbourhood.has(link.source) && neighbourhood.has(link.target)) {
      const sourceNode = nodeMap.get(link.source);
      const targetNode = nodeMap.get(link.target);
      if (sourceNode && targetNode) graphLinks.push({ source: sourceNode, target: targetNode });
    }
  }

  const styles = getComputedStyle(document.documentElement);
  const secondary = resolveColor(styles.getPropertyValue("--g-secondary").trim(), "#284b63");
  const tertiary = resolveColor(styles.getPropertyValue("--g-tertiary").trim(), "#84a59d");
  const gray = resolveColor(styles.getPropertyValue("--g-gray").trim(), "#b8b8b8");
  const lightgray = resolveColor(styles.getPropertyValue("--g-lightgray").trim(), "#e5e5e5");
  const dark = resolveColor(styles.getPropertyValue("--g-dark").trim(), "#2b2b2b");
  const bodyFont = styles.getPropertyValue("--sans").trim() || "inherit";

  const app = new Application();
  await app.init({
    width,
    height,
    antialias: true,
    backgroundAlpha: 0,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
    eventMode: "static",
  });
  graph.appendChild(app.canvas);

  const stage = new Container();
  app.stage.addChild(stage);

  const degree = new Map<string, number>();
  for (const l of graphLinks) {
    degree.set(l.source.id, (degree.get(l.source.id) ?? 0) + 1);
    degree.set(l.target.id, (degree.get(l.target.id) ?? 0) + 1);
  }
  const nodeRadius = (d: NodeData) => 2 + Math.sqrt(degree.get(d.id) ?? 0);

  const simulation = d3
    .forceSimulation<NodeData>(nodes)
    .force("charge", d3.forceManyBody().strength(-100 * repelForce))
    .force("center", d3.forceCenter().strength(centerForce))
    .force("link", d3.forceLink<NodeData, LinkData>(graphLinks).distance(linkDistance))
    .force("collide", d3.forceCollide<NodeData>().radius(nodeRadius).iterations(3));

  if (enableRadial) {
    const radius = (Math.min(width, height) / 2) * 0.8;
    simulation.force("radial", d3.forceRadial(radius).strength(0.2));
  }

  const linkContainer = new Container();
  const nodesContainer = new Container();
  const labelsContainer = new Container();
  stage.addChild(linkContainer, nodesContainer, labelsContainer);

  const nodeRenderData: NodeRender[] = [];
  const linkRenderData: LinkRender[] = [];
  let hoveredNodeId: string | null = null;
  let dragStartTime = 0;
  let dragging = false;
  let currentTransform = d3.zoomIdentity;

  const nodeColor = (d: NodeData) => (d.id === current ? secondary : visited.has(d.id) ? tertiary : gray);

  /** Current note + direct neighbours, when viewing from the note's perspective. */
  let focusSet = new Set<string>();
  const computeFocus = () => {
    focusSet = new Set();
    if (!focusCurrent || !current || !nodeMap.has(current)) return;
    focusSet.add(current);
    for (const l of graphLinks) {
      if (l.source.id === current) focusSet.add(l.target.id);
      if (l.target.id === current) focusSet.add(l.source.id);
    }
  };
  computeFocus();
  const focused = () => focusSet.size > 0;
  const FADED = 0.25;
  let zoomOpacity = 0;

  function updateHoverInfo(newHoveredId: string | null) {
    hoveredNodeId = newHoveredId;
    if (newHoveredId === null) {
      for (const n of nodeRenderData) n.active = false;
      for (const l of linkRenderData) l.active = false;
      return;
    }
    const hoveredNeighbours = new Set<string>();
    for (const l of linkRenderData) {
      const d = l.simulationData;
      if (d.source.id === newHoveredId || d.target.id === newHoveredId) {
        hoveredNeighbours.add(d.source.id);
        hoveredNeighbours.add(d.target.id);
        l.active = true;
      } else {
        l.active = false;
      }
    }
    hoveredNeighbours.add(newHoveredId);
    for (const n of nodeRenderData) n.active = hoveredNeighbours.has(n.simulationData.id);
  }

  function renderLinks() {
    for (const l of linkRenderData) {
      const inFocus = focusSet.has(l.simulationData.source.id) && focusSet.has(l.simulationData.target.id) &&
        (l.simulationData.source.id === current || l.simulationData.target.id === current);
      if (hoveredNodeId !== null) {
        l.alpha = l.active ? 1 : 0.2;
        l.color = l.active ? gray : lightgray;
      } else if (focused()) {
        l.alpha = inFocus ? 1 : FADED;
        l.color = inFocus ? gray : lightgray;
      } else {
        l.alpha = 1;
        l.color = lightgray;
      }
    }
  }

  function renderLabels() {
    const defaultScale = 1 / scale;
    const activeScale = defaultScale * 1.1;
    for (const n of nodeRenderData) {
      const id = n.simulationData.id;
      if (hoveredNodeId === id) {
        n.label.alpha = 1;
        n.label.scale.set(activeScale);
      } else {
        n.label.scale.set(id === current && focused() ? activeScale : defaultScale);
        if (focused()) n.label.alpha = focusSet.has(id) ? 1 : zoomOpacity;
      }
    }
  }

  function renderNodes() {
    for (const n of nodeRenderData) {
      if (hoveredNodeId !== null && focusOnHover) n.gfx.alpha = n.active ? 1 : 0.2;
      else if (focused()) n.gfx.alpha = focusSet.has(n.simulationData.id) ? 1 : FADED + 0.15;
      else n.gfx.alpha = 1;
    }
  }

  function paintNode(n: NodeRender) {
    n.gfx.clear();
    n.gfx.circle(0, 0, nodeRadius(n.simulationData));
    n.gfx.fill({ color: nodeColor(n.simulationData) });
    if (n.simulationData.id === current && focused()) {
      n.gfx.circle(0, 0, nodeRadius(n.simulationData) + 2.5);
      n.gfx.stroke({ width: 1, color: secondary });
    }
  }

  function renderPixiFromD3() {
    renderNodes();
    renderLinks();
    renderLabels();
  }

  for (const node of nodes) {
    const label = new Text({
      text: node.text,
      style: { fontSize: fontSize * 15, fill: dark, fontFamily: bodyFont },
      resolution: window.devicePixelRatio * 4,
    });
    label.anchor.set(0.5, 1.2);
    label.alpha = 0;
    label.scale.set(1 / scale);
    labelsContainer.addChild(label);

    const gfx = new Graphics();
    gfx.eventMode = "static";
    gfx.cursor = "pointer";
    gfx.label = node.id;

    let oldLabelOpacity = 0;
    gfx.on("pointerover", () => {
      updateHoverInfo(node.id);
      oldLabelOpacity = label.alpha;
      if (!dragging) renderPixiFromD3();
    });
    gfx.on("pointerleave", () => {
      updateHoverInfo(null);
      label.alpha = oldLabelOpacity;
      if (!dragging) renderPixiFromD3();
    });

    nodesContainer.addChild(gfx);
    const render: NodeRender = { simulationData: node, gfx, label, active: false };
    paintNode(render);
    nodeRenderData.push(render);
  }

  for (const link of graphLinks) {
    const gfx = new Graphics();
    gfx.eventMode = "none";
    linkContainer.addChild(gfx);
    linkRenderData.push({ simulationData: link, gfx, color: lightgray, alpha: 1, active: false });
  }

  if (enableDrag) {
    type DragNode = NodeData & { __dragOffset?: { x: number; y: number } };
    const dragSubject = (event: d3.D3DragEvent<HTMLCanvasElement, unknown, DragNode>) => {
      const mouseX = (event.x - currentTransform.x) / currentTransform.k;
      const mouseY = (event.y - currentTransform.y) / currentTransform.k;
      for (const n of nodes) {
        const dx = mouseX - n.x! - width / 2;
        const dy = mouseY - n.y! - height / 2;
        if (Math.sqrt(dx * dx + dy * dy) < nodeRadius(n) + 5) return n;
      }
      return null;
    };

    const drag = d3
      .drag<HTMLCanvasElement, unknown, DragNode>()
      .container(app.canvas)
      .subject(dragSubject as never)
      .on("start", (event) => {
        if (!event.active) simulation.alphaTarget(1).restart();
        event.subject.fx = event.subject.x;
        event.subject.fy = event.subject.y;
        const mouseSimX = (event.x - currentTransform.x) / currentTransform.k - width / 2;
        const mouseSimY = (event.y - currentTransform.y) / currentTransform.k - height / 2;
        event.subject.__dragOffset = { x: mouseSimX - event.subject.x!, y: mouseSimY - event.subject.y! };
        dragStartTime = Date.now();
        dragging = true;
        hoveredNodeId = event.subject.id;
      })
      .on("drag", (event) => {
        const mouseSimX = (event.x - currentTransform.x) / currentTransform.k - width / 2;
        const mouseSimY = (event.y - currentTransform.y) / currentTransform.k - height / 2;
        event.subject.fx = mouseSimX - event.subject.__dragOffset!.x;
        event.subject.fy = mouseSimY - event.subject.__dragOffset!.y;
      })
      .on("end", (event) => {
        if (!event.active) simulation.alphaTarget(0);
        event.subject.fx = null;
        event.subject.fy = null;
        dragging = false;
        updateHoverInfo(null);
        renderPixiFromD3();
        if (Date.now() - dragStartTime < 500) onNavigate(event.subject.id);
      });

    d3.select(app.canvas).call(drag);
  } else {
    for (const n of nodeRenderData) n.gfx.on("click", () => onNavigate(n.simulationData.id));
  }

  let zoomBehavior: d3.ZoomBehavior<HTMLCanvasElement, unknown> | null = null;
  if (enableZoom) {
    const zoom = (zoomBehavior = d3
      .zoom<HTMLCanvasElement, unknown>()
      .extent([
        [0, 0],
        [width, height],
      ])
      .scaleExtent([0.25, 4])
      .on("zoom", (event: d3.D3ZoomEvent<HTMLCanvasElement, unknown>) => {
        currentTransform = event.transform;
        stage.scale.set(currentTransform.k, currentTransform.k);
        stage.position.set(currentTransform.x, currentTransform.y);

        const scaleOpacity = Math.max((currentTransform.k * opacityScale - 1) / 3.75, 0);
        zoomOpacity = scaleOpacity;
        const activeLabels = new Set(nodeRenderData.filter((n) => n.active || focusSet.has(n.simulationData.id)).map((n) => n.label));
        for (const label of labelsContainer.children) {
          if (!activeLabels.has(label as Text)) label.alpha = scaleOpacity;
        }
      }));
    d3.select(app.canvas).call(zoom);
  }

  /** Glide the camera so the current note sits in the middle at the configured scale. */
  function centreOnCurrent(duration: number) {
    if (!focusCurrent || !zoomBehavior || !current) return;
    const node = nodeMap.get(current);
    if (!node || node.x == null || node.y == null) return;
    const k = Math.max(currentTransform.k, scale);
    const target = d3.zoomIdentity.translate(width / 2 - k * (node.x + width / 2), height / 2 - k * (node.y + height / 2)).scale(k);
    d3.select(app.canvas).transition().duration(duration).ease(d3.easeCubicOut).call(zoomBehavior.transform, target);
  }

  let stopAnimation = false;
  function animate() {
    if (stopAnimation) return;
    for (const n of nodeRenderData) {
      const { x, y } = n.simulationData;
      if (x != null && y != null) {
        n.gfx.position.set(x + width / 2, y + height / 2);
        n.label.position.set(x + width / 2, y + height / 2);
      }
    }
    for (const l of linkRenderData) {
      const { source, target } = l.simulationData;
      if (source.x != null && source.y != null && target.x != null && target.y != null) {
        l.gfx.clear();
        l.gfx.moveTo(source.x + width / 2, source.y + height / 2);
        l.gfx.lineTo(target.x + width / 2, target.y + height / 2);
        l.gfx.stroke({ alpha: l.alpha, width: 1, color: l.color });
      }
    }
    requestAnimationFrame(animate);
  }

  simulation.restart();
  renderPixiFromD3();
  animate();

  // Let the layout settle a little before the first glide.
  const settle = setTimeout(() => centreOnCurrent(900), 700);

  return {
    setCurrent(id) {
      if (id === current) return;
      current = id;
      if (id) visited.add(id);
      computeFocus();
      for (const n of nodeRenderData) paintNode(n);
      renderPixiFromD3();
      centreOnCurrent(600);
    },
    destroy() {
      clearTimeout(settle);
      stopAnimation = true;
      simulation.stop();
      try {
        app.destroy(true);
      } catch {
        // PixiJS may throw if the WebGL context was already lost.
      }
    },
  };
}
