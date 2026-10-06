import { getAgentByName } from "agents";
import { BANK, DEFAULT_BANK, memoryName } from "../shared/banks.ts";
import { sessionUser, USER } from "./auth.ts";
import type { AskResult } from "./chat-agent.ts";
import type { Env } from "./env.ts";

/**
 * HTTP API over the same agents the UI uses. Every route is scoped to a user id:
 *
 *   POST /api/users/:user/chat                {message, thread?, tz?} → run a turn (reads + writes memory)
 *   GET  /api/users/:user/notes               → notes (markdown); POST {title, body} to create
 *   GET|PUT|DELETE /api/users/:user/notes/:id → read / update {title?, body?} / delete a note
 *   GET  /api/users/:user/threads             → threads
 *   GET  /api/users/:user/threads/:thread     → transcript
 *   GET  /api/users/:user/memory              → {head, paths}  (?ref=<commit>)
 *   GET  /api/users/:user/memory/<path>       → file content as text/markdown (?ref=<commit>)
 *   GET  /api/users/:user/search?q=           → full-text hits in conversations and memory
 *   GET  /api/users/:user/history             → commits (chat edits and dreams)
 *   GET  /api/users/:user/history/:commit     → files changed by a commit
 *   POST /api/users/:user/dream               → start a dream now
 *   GET  /api/users/:user/dream               → dreaming status, last result, live log
 *   GET  /api/users/:user/costs               → spend so far (chat, dreaming)
 *
 * Add `?bank=<name>` to work in another memory bank (default: main).
 *
 * Requests need `Authorization: Bearer <token>` with the user's session token (from POST /auth/verify,
 * or the UI's API card), or the session cookie. If MEMORY_API_KEY is set, it reaches every user.
 */
const THREAD = /^[a-z0-9]{1,16}$/;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const fail = (status: number, error: string) => json({ error }, status);

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/api" || url.pathname === "/api/") return json(INDEX);

  const m = url.pathname.match(/^\/api\/users\/([^/]+)(?:\/(.*))?$/);
  if (!m) return fail(404, "not found; see GET /api");
  const [, user, rest = ""] = m;
  if (!USER.test(user!)) return fail(400, "user id must match [a-z0-9_-]{1,48}");
  const admin = !!env.MEMORY_API_KEY && request.headers.get("authorization") === `Bearer ${env.MEMORY_API_KEY}`;
  if (!admin && (await sessionUser(request, env)) !== user) return fail(401, "sign in as this user: Authorization: Bearer <token> (POST /auth/start, then /auth/verify)");
  const bank = url.searchParams.get("bank") ?? DEFAULT_BANK;
  if (!BANK.test(bank)) return fail(400, "bank must match [a-z0-9_-]{1,32}");
  if (bank !== DEFAULT_BANK && !(await (await getAgentByName(env.MemoryAgent, user!)).hasBank(bank))) return fail(404, `no such bank: ${bank}`);
  const mem = memoryName(user!, bank);
  const memory = await getAgentByName(env.MemoryAgent, mem);
  const [resource, ...tail] = rest.split("/");
  const method = request.method.toUpperCase();
  const ref = url.searchParams.get("ref") ?? undefined;

  try {
    switch (`${method} ${resource}`) {
      case "POST chat": {
        const body = (await request.json().catch(() => null)) as { message?: string; thread?: string; tz?: string } | null;
        if (!body?.message?.trim()) return fail(400, 'body must be JSON: {"message": "...", "thread"?: "...", "tz"?: "Europe/Berlin"}');
        if (body.thread && !THREAD.test(body.thread)) return fail(400, "bad thread id");
        const thread = body.thread ?? (await memory.newThread()).id;
        const chat = await getAgentByName(env.ChatAgent, `${mem}.${thread}`);
        const result = (await chat.ask(body.message, body.tz)) as AskResult;
        return json({ thread, ...result });
      }
      case "GET notes":
        if (!tail[0]) return json(await memory.listNotes());
        return (await memory.getNote(tail[0])) ? json(await memory.getNote(tail[0])) : fail(404, "no such note");
      case "POST notes": {
        const body = (await request.json().catch(() => null)) as { title?: string; body?: string } | null;
        if (typeof body?.body !== "string") return fail(400, 'body must be JSON: {"title"?: "...", "body": "markdown"}');
        return json(await memory.saveNote({ title: body.title ?? "Untitled", body: body.body }), 201);
      }
      case "PUT notes": {
        if (!tail[0]) return fail(400, "PUT /notes/:id");
        const existing = (await memory.getNote(tail[0])) as { title: string; body: string } | null;
        if (!existing) return fail(404, "no such note");
        const body = (await request.json().catch(() => null)) as { title?: string; body?: string } | null;
        return json(await memory.saveNote({ id: tail[0], title: body?.title ?? existing.title, body: body?.body ?? existing.body }));
      }
      case "DELETE notes":
        if (!tail[0]) return fail(400, "DELETE /notes/:id");
        await memory.deleteNote(tail[0]);
        return json({ deleted: tail[0] });
      case "GET threads": {
        if (!tail[0]) return json(await memory.listThreads());
        if (!THREAD.test(tail[0])) return fail(400, "bad thread id");
        const chat = await getAgentByName(env.ChatAgent, `${mem}.${tail[0]}`);
        return json(await chat.transcript());
      }
      case "GET memory": {
        const path = tail.join("/");
        if (!path) return json(await memory.tree(ref));
        const head = ref ?? (await memory.tree()).hash;
        if (!head) return fail(404, "memory is empty");
        const text = await memory.file(head, path);
        return text === null
          ? fail(404, `no such file: ${path}`)
          : new Response(text, { headers: { "content-type": "text/markdown; charset=utf-8", "x-memory-commit": head } });
      }
      case "GET search": {
        const q = url.searchParams.get("q");
        return q ? json(await memory.search(q)) : fail(400, "missing ?q=");
      }
      case "GET history":
        return json(tail[0] ? await memory.commitChanges(tail[0]) : await memory.history());
      case "POST dream":
        return json(await memory.dreamNow(), 202);
      case "GET dream":
        return json(await memory.dreamStatus());
      case "GET costs":
        return json(await memory.costs());
      default:
        return fail(404, "not found; see GET /api");
    }
  } catch (error) {
    return fail(500, error instanceof Error ? error.message : String(error));
  }
}

const INDEX = {
  name: "markdown-memory",
  banks: "add ?bank=<name> to any route (default: main); banks are created in the UI",
  auth: "Authorization: Bearer <token>; get one with POST /auth/start {email}, then POST /auth/verify {email, code}",
  routes: [
    "POST /api/users/:user/chat  {message, thread?, tz?}",
    "GET  /api/users/:user/notes",
    "POST /api/users/:user/notes  {title?, body}",
    "GET|PUT|DELETE /api/users/:user/notes/:id",
    "GET  /api/users/:user/threads",
    "GET  /api/users/:user/threads/:thread",
    "GET  /api/users/:user/memory  ?ref=",
    "GET  /api/users/:user/memory/<path>  ?ref=",
    "GET  /api/users/:user/search?q=",
    "GET  /api/users/:user/history",
    "GET  /api/users/:user/history/:commit",
    "POST /api/users/:user/dream",
    "GET  /api/users/:user/dream",
    "GET  /api/users/:user/costs",
  ],
};
