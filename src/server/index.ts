import { getAgentByName, routeAgentRequest } from "agents";
import { DEFAULT_BANK } from "../shared/banks.ts";
import { handleApi } from "./api.ts";
import { handleAuth, sessionUser } from "./auth.ts";
import type { Env } from "./env.ts";

export { ChatAgent } from "./chat-agent.ts";
export { MemoryAgent } from "./memory-agent.ts";

/**
 * Agent names: a memory agent is "<user>" (bank "main") or "<user>.<bank>"; a chat agent is that plus
 * ".<thread>". Captures: memory user, memory bank, chat user, chat bank.
 */
const AGENT =
  /^\/agents\/(?:memory-agent\/([a-z0-9_-]{1,48})(?:\.([a-z0-9_-]{1,32}))?|chat-agent\/([a-z0-9_-]{1,48})(?:\.([a-z0-9_-]{1,32}))?\.[a-z0-9]{1,16})(?:\/|$)/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/auth/")) return handleAuth(request, env);
    if (pathname === "/api" || pathname.startsWith("/api/")) return handleApi(request, env);
    if (!pathname.startsWith("/agents/")) return new Response("not found", { status: 404 });
    const m = pathname.match(AGENT);
    if (!m) return new Response("bad agent name", { status: 400 });
    // Only the signed-in user may reach their own agents, and only in banks they created.
    const user = m[1] ?? m[3]!;
    const bank = m[2] ?? m[4] ?? DEFAULT_BANK;
    if ((m[2] ?? m[4]) === DEFAULT_BANK) return new Response("bad agent name", { status: 400 }); // main is "<user>"
    if ((await sessionUser(request, env)) !== user) return new Response("unauthorized", { status: 401 });
    if (bank !== DEFAULT_BANK && !(await (await getAgentByName(env.MemoryAgent, user)).hasBank(bank))) {
      return new Response("no such bank", { status: 404 });
    }
    return (await routeAgentRequest(request, env)) ?? new Response("not found", { status: 404 });
  },
};
