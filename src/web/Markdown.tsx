import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Splits YAML frontmatter off the top of a note. */
export function splitFrontmatter(text: string): { front: string | null; body: string } {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  return match ? { front: match[1]!, body: text.slice(match[0].length) } : { front: null, body: text };
}

/**
 * Renders markdown. [[wiki-links]] become clickable when onLink is given;
 * the target is resolved to a vault path by the caller.
 */
export function Markdown({
  text,
  onLink,
  onSource,
}: {
  text: string;
  onLink?: (target: string) => void;
  /** Called with (thread, message?) when a `[source: thread/…#…]` chip is clicked. */
  onSource?: (thread: string, message?: string) => void;
}) {
  const source = text
    // Entry metadata `[source: thread/ab12#msg; added: 2026-10-05]` → a compact chip linking to the conversation.
    .replace(/\[source:\s*thread\/([a-z0-9]+)(?:#([\w-]+))?\s*(?:;\s*added:\s*([0-9-]+))?[^\]]*\]/gi, (_, thread: string, msg?: string, added?: string) =>
      ` [↗${added ? ` ${added}` : ""}](src:${thread}${msg ? `/${msg}` : ""})`,
    )
    .replace(/\[source:\s*note\/([a-z0-9]+)\s*(?:;\s*added:\s*([0-9-]+))?[^\]]*\]/gi, (_, note: string, added?: string) => ` [✎${added ? ` ${added}` : ""}](src:note:${note})`)
    .replace(/\[\[([^\]]+)\]\]/g, (_, target: string) => `[${target}](wiki:${encodeURIComponent(target)})`);
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => url}
        components={{
          a: ({ href, children }) => {
            if (href?.startsWith("src:")) {
              const [thread, message] = href.slice(4).split("/");
              return (
                <a
                  className="source-chip mono"
                  href="#"
                  title={`source: thread/${thread}${message ? `#${message}` : ""}`}
                  onClick={(e) => {
                    e.preventDefault();
                    onSource?.(thread!, message);
                  }}
                >
                  {children}
                </a>
              );
            }
            if (href?.startsWith("wiki:")) {
              const target = decodeURIComponent(href.slice(5));
              return (
                <a
                  className="wikilink"
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    onLink?.(target);
                  }}
                >
                  {children}
                </a>
              );
            }
            return (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          },
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
