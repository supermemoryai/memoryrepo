import { useState } from "react";

/** Bottom of the sidebar: this user's HTTP API, with copyable examples and the session token. */
export function ApiCard({ user, bank, token }: { user: string; bank: string; token: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const base = `${location.origin}/api/users/${user}`;
  // Non-default banks are picked with ?bank=.
  const q = (path: string, params: Record<string, string> = {}) => {
    const search = new URLSearchParams({ ...params, ...(bank === "main" ? {} : { bank }) }).toString();
    return `${base}${path}${search ? `?${search}` : ""}`;
  };
  const header = ` \\\n  -H "authorization: Bearer $MEMORY_TOKEN"`;
  const examples = [
    {
      label: "chat",
      cmd: `curl -X POST '${q("/chat")}'${header} \\\n  -H 'content-type: application/json' \\\n  -d '{"message": "remember that I love pasta"}'`,
    },
    { label: "read memory", cmd: `curl '${q("/memory/MEMORY.md")}'${header}` },
    { label: "search", cmd: `curl '${q("/search", { q: "pasta" })}'${header}` },
  ];
  const copy = (key: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1_200);
    });
  };

  return (
    <div className="apicard">
      <button className="apicard-head mono" onClick={() => setOpen((o) => !o)}>
        <span className="apicard-dot" />
        <span>API</span>
        <span className="faint">· bearer token</span>
        <span className="grow" />
        <span className="faint">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="apicard-body">
          <button className="apicard-base mono" title="copy base URL" onClick={() => copy("base", base)}>
            {copied === "base" ? "copied ✓" : base.replace(/^https?:\/\//, "")}
          </button>
          <button className="apicard-base mono" title="copy an export line for your shell" onClick={() => copy("token", `export MEMORY_TOKEN=${token}`)}>
            {copied === "token" ? "copied ✓" : "copy MEMORY_TOKEN (30 days)"}
          </button>
          {examples.map((e) => (
            <div key={e.label} className="apicard-ex">
              <div className="apicard-ex-head">
                <span className="label">{e.label}</span>
                <button className="seg-btn" onClick={() => copy(e.label, e.cmd)}>
                  {copied === e.label ? "copied" : "copy"}
                </button>
              </div>
              <pre className="mono">{e.cmd}</pre>
            </div>
          ))}
          <a className="mono apicard-link" href="/api" target="_blank" rel="noreferrer">
            all routes → /api
          </a>
        </div>
      )}
    </div>
  );
}
