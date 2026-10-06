import type { ChatAgent } from "./chat-agent.ts";
import type { MemoryAgent } from "./memory-agent.ts";

/** Worker bindings, as declared in alchemy.run.ts (written out to avoid a type cycle with the agents). */
export interface Env {
  MemoryAgent: DurableObjectNamespace<MemoryAgent>;
  ChatAgent: DurableObjectNamespace<ChatAgent>;
  MEMORIES: Artifacts;
  OPENROUTER_API_KEY: string;
  /** Signs session tokens. Any long random string; changing it signs everyone out. */
  AUTH_SECRET: string;
  /** Sends sign-in codes (Cloudflare Email Service). */
  EMAIL: SendEmail;
  /** Sender address for sign-in codes, on a domain with Email Sending enabled. */
  EMAIL_FROM: string;
  /** Optional admin key: `Authorization: Bearer <MEMORY_API_KEY>` reaches any user's /api. Empty = off. */
  MEMORY_API_KEY: string;
}
