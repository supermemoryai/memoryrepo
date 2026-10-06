import { getAgentByName } from "agents";
import type { Env } from "./env.ts";

/**
 * Simple auth: sign in with an email address and a 6-digit code sent to it (Cloudflare Email
 * Service). No passwords. The user id is derived from the email, so one inbox is one memory repo.
 * Codes, their limits, and the account's email live in that user's MemoryAgent.
 *
 * A session is a signed token `<user>.<expires>.<hmac>`, sent as an HttpOnly cookie (so the agent
 * WebSockets carry it too) or as `Authorization: Bearer <token>` for the HTTP API.
 *
 *   POST /auth/start   {email}       → emails a code
 *   POST /auth/verify  {email, code} → {user, email, token}  and sets the cookie
 *   POST /auth/logout                → clears the cookie
 *   GET  /auth/me                    → {user, email, token} or 401
 */
export const USER = /^[a-z0-9_-]{1,48}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const COOKIE = "mm_session";
const SESSION_SECONDS = 30 * 24 * 60 * 60;

const enc = new TextEncoder();
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });

export async function handleAuth(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const route = `${request.method.toUpperCase()} ${url.pathname}`;

  if (route === "POST /auth/start" || route === "POST /auth/verify") {
    const body = (await request.json().catch(() => null)) as { email?: string; code?: string } | null;
    const email = body?.email?.trim().toLowerCase() ?? "";
    if (email.length > 254 || !EMAIL.test(email)) return json({ error: "enter a valid email address" }, 400);
    const user = await userIdFor(email);
    const memory = await getAgentByName(env.MemoryAgent, user);

    if (route === "POST /auth/start") {
      const issued = await memory.issueLoginCode();
      if ("retryAfter" in issued) return json({ error: `too many codes; try again in ${wait(issued.retryAfter)}` }, 429, { "retry-after": String(issued.retryAfter) });
      try {
        await env.EMAIL.send({
          to: email,
          from: { email: env.EMAIL_FROM, name: "markdown memory" },
          subject: `${issued.code} is your markdown memory code`,
          text: `Your sign-in code is ${issued.code}\n\nIt expires in 10 minutes. If you didn't ask for it, ignore this email.`,
          html: `<p>Your sign-in code is</p><p style="font:600 28px ui-monospace,Menlo,monospace;letter-spacing:4px">${issued.code}</p><p style="color:#74747a">It expires in 10 minutes. If you didn't ask for it, ignore this email.</p>`,
        });
      } catch (error) {
        console.error("auth: send failed", error);
        return json({ error: "couldn't send the email; try again" }, 502);
      }
      return json({ sent: true });
    }

    const outcome = await memory.verifyLoginCode((body?.code ?? "").replace(/\s/g, ""), email);
    if (outcome !== "ok") {
      const error = { wrong: "wrong code", expired: "that code expired or was used up; send a new one" }[outcome];
      return json({ error }, 401);
    }
    const token = await sign(user, env.AUTH_SECRET);
    return json({ user, email, token }, 200, { "set-cookie": cookie(url, token, SESSION_SECONDS) });
  }
  if (route === "POST /auth/logout") return json({ ok: true }, 200, { "set-cookie": cookie(url, "", 0) });
  if (route === "GET /auth/me") {
    const token = readToken(request);
    const user = token ? await verify(token, env.AUTH_SECRET) : null;
    if (!user) return json({ error: "not signed in" }, 401);
    const email = await (await getAgentByName(env.MemoryAgent, user)).accountEmail();
    return json({ user, email, token });
  }
  return json({ error: "not found" }, 404);
}

/** The signed-in user for a request (cookie or bearer token), or null. */
export async function sessionUser(request: Request, env: Env): Promise<string | null> {
  const token = readToken(request);
  return token ? verify(token, env.AUTH_SECRET) : null;
}

/** A stable, URL-safe user id for an email: a readable prefix plus a hash, e.g. `ada-3f2a1c9b0e7d`. */
async function userIdFor(email: string): Promise<string> {
  const digest = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(email))));
  const local = email.split("@")[0]!.replace(/[^a-z0-9_-]/g, "").slice(0, 24) || "user";
  return `${local}-${digest.slice(0, 12)}`;
}

const wait = (seconds: number) => (seconds < 90 ? `${seconds}s` : `${Math.ceil(seconds / 60)} min`);

// ---- session tokens ------------------------------------------------------------------------

async function sign(user: string, secret: string): Promise<string> {
  const payload = `${user}.${Math.floor(Date.now() / 1000) + SESSION_SECONDS}`;
  return `${payload}.${await hmac(payload, secret)}`;
}

async function verify(token: string, secret: string): Promise<string | null> {
  const [user, expires, sig] = token.split(".");
  if (!user || !expires || !sig || !USER.test(user)) return null;
  if (Number(expires) < Date.now() / 1000) return null;
  return equal(sig, await hmac(`${user}.${expires}`, secret)) ? user : null;
}

async function hmac(payload: string, secret: string): Promise<string> {
  if (!secret) throw new Error("AUTH_SECRET is not set");
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(payload))));
}

function readToken(request: Request): string | null {
  const bearer = request.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (bearer) return bearer;
  const raw = request.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE) return decodeURIComponent(value.join("="));
  }
  return null;
}

function cookie(url: URL, value: string, maxAge: number): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Constant-time string comparison. */
export function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
