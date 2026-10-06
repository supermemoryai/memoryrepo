/** [[wiki-link]] parsing shared by the server (graph) and the client (navigation). */

/** Link targets in a note, without `|alias` or `#heading` suffixes. */
export function extractLinks(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const target = match[1]!.split("|")[0]!.split("#")[0]!.trim();
    if (target) out.push(target);
  }
  return out;
}

/** Resolve a link target to a vault path: exact path, then path suffix, then bare file name. */
export function resolveLink(target: string, paths: string[]): string | null {
  const t = target.replace(/^\/+/, "").replace(/\.md$/, "");
  const name = `${t.split("/").pop()}.md`;
  return (
    paths.find((p) => p === `${t}.md`) ??
    paths.find((p) => p.endsWith(`/${t}.md`)) ??
    paths.find((p) => p.split("/").pop() === name) ??
    null
  );
}

export type GraphNode = { id: string; label: string; group: string; degree: number; ghost: boolean };
export type GraphEdge = { source: string; target: string };
export type Graph = { hash: string | null; nodes: GraphNode[]; edges: GraphEdge[] };

/** Build the link graph of a set of markdown files. Unresolved targets become ghost nodes. */
export function buildGraph(hash: string | null, files: Record<string, string>): Graph {
  const paths = Object.keys(files).filter((p) => p.endsWith(".md"));
  const nodes = new Map<string, GraphNode>();
  const node = (id: string, ghost: boolean) => {
    let n = nodes.get(id);
    if (!n) {
      const label = id.replace(/\.md$/, "").split("/").pop()!;
      const group = ghost ? "(missing)" : id.includes("/") ? id.split("/")[0]! : "(root)";
      n = { id, label, group, degree: 0, ghost };
      nodes.set(id, n);
    }
    return n;
  };
  for (const path of paths) node(path, false);

  const seen = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const path of paths) {
    for (const target of extractLinks(files[path]!)) {
      const resolved = resolveLink(target, paths) ?? `?${target}`;
      if (resolved === path) continue;
      const key = [path, resolved].sort().join("\u0000");
      if (seen.has(key)) continue;
      seen.add(key);
      node(resolved, resolved.startsWith("?"));
      edges.push({ source: path, target: resolved });
    }
  }
  for (const e of edges) {
    nodes.get(e.source)!.degree++;
    nodes.get(e.target)!.degree++;
  }
  return { hash, nodes: [...nodes.values()], edges };
}
