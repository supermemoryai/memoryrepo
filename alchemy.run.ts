import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { ChatAgent, MemoryAgent } from "./src/server/index.ts";

// Every user's memory is one git repo in this Artifacts namespace. Repos are created at runtime.
export const Memories = Cloudflare.Artifacts.Namespace("Memories", { namespace: "markdown-memory-demo" });

export const App = Cloudflare.Website.Vite("App", {
  main: "./src/server/index.ts",
  // The zone must already be in this Cloudflare account; DNS and the certificate are managed for us.
  domain: { name: "memoryrepo.dev", redirects: ["www.memoryrepo.dev"] },
  compatibility: { date: "2026-09-01" },
  assets: {
    notFoundHandling: "single-page-application",
    runWorkerFirst: ["/agents/*", "/api", "/api/*", "/auth/*"],
  },
  observability: { enabled: true, logs: { enabled: true, invocationLogs: true } },
  env: {
    MemoryAgent: Cloudflare.DurableObject<MemoryAgent>("MemoryAgent"),
    ChatAgent: Cloudflare.DurableObject<ChatAgent>("ChatAgent"),
    MEMORIES: Memories,
    OPENROUTER_API_KEY: Config.Redacted("OPENROUTER_API_KEY"),
    // Signs login sessions. Any long random string (e.g. `openssl rand -hex 32`).
    AUTH_SECRET: Config.Redacted("AUTH_SECRET"),
    // Sign-in codes go out through Cloudflare Email Service. Under `alchemy dev` they land as .eml files
    // in .alchemy/local/email instead; add `.pipe(Alchemy.remote())` to send real mail from dev.
    EMAIL: Cloudflare.Email.SendEmail("Email"),
    // Sender for sign-in codes, on a domain with Email Sending enabled (`wrangler email sending enable`).
    EMAIL_FROM: Config.String("EMAIL_FROM"),
    // Optional admin key: `Authorization: Bearer <MEMORY_API_KEY>` reaches any user's /api. Unset = off.
    MEMORY_API_KEY: Config.Redacted("MEMORY_API_KEY").pipe(Config.withDefault(Redacted.make(""))),
  },
});

export default Alchemy.Stack(
  "markdown-memory-demo",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const app = yield* App;
    return { url: app.url };
  }),
);
