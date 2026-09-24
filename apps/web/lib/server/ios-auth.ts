import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { deleteAccount } from "./account-deletion.ts";

export const IOS_CALLBACK = "dev.gtfol.freewrite://auth/callback";
const opaque = (value: unknown): value is string => typeof value === "string" && value.length === 43 && /^[A-Za-z0-9_-]+$/.test(value);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
type User = { id: string; name: string; email: string };
type BrowserSession = { user: User; session: { id: string } };
const responseHeaders = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" };
const reply = (body: object, status = 200) => Response.json(body, { status, headers: responseHeaders });

class AuthError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}
const invalidCode = () => new AuthError("sign-in expired. return to freewrite and try again.");

export function iosAuthorization(value: Record<string, unknown>) {
  if (Object.keys(value).some(key => !["code_challenge", "state"].includes(key))) return null;
  const { code_challenge, state } = value;
  return opaque(code_challenge) && opaque(state)
    ? { code_challenge, state } : null;
}

async function body(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new AuthError("send a JSON request.", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError("invalid request.");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2048) { await reader.cancel(); throw new AuthError("request is too large.", 413); }
      chunks.push(value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError("invalid request.");
  } finally { reader.releaseLock(); }
}

function nativeRequest(request: Request) {
  if (request.headers.has("origin") || request.headers.get("sec-fetch-site") === "cross-site") throw new AuthError("return to the freewrite app to continue.", 403);
}

// Use the existing session table and its user-deletion cascade. Native tokens
// have a separate prefix and only their hash is stored; they are not web cookies.
export function iosTokenHash(request: Request): string {
  const match = /^Bearer (freewrite_[A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "");
  if (!match) throw new AuthError("sign in again.", 401);
  return `ios:${digest(match[1])}`;
}

export function createIOSAuth(pool: Pool, sessionFor: (request: Request) => Promise<BrowserSession | null>) {
  async function authenticated(request: Request) {
    nativeRequest(request);
    const tokenHash = iosTokenHash(request);
    const { rows } = await pool.query<User & { sessionId: string; expiresAt: Date }>(
      `select u.id,u.name,u.email,s.id as "sessionId",s."expiresAt" from "session" s join "user" u on u.id=s."userId" where s.token=$1 and s."expiresAt">now()`, [tokenHash]);
    if (rows.length !== 1) throw new AuthError("sign in again.", 401);
    return { ...rows[0], tokenHash };
  }
  const handlers = {
    async authorize(request: Request) {
      if (request.headers.get("origin") !== new URL(request.url).origin || request.headers.get("sec-fetch-site") === "cross-site") throw new AuthError("sign in from freewrite.", 403);
      const { expectedUserId, ...values } = await body(request);
      const authorization = iosAuthorization(values);
      if (!authorization || typeof expectedUserId !== "string" || expectedUserId.length > 256) throw new AuthError("invalid sign-in request.");
      const session = await sessionFor(request);
      if (!session) throw new AuthError("sign in to freewrite first.", 401);
      if (session.user.id !== expectedUserId) throw new AuthError("your account changed. reload and try again.", 409);
      const code = randomBytes(32).toString("base64url");
      await pool.query(`delete from "verification" where identifier like 'freewrite-ios:%' and "expiresAt"<=now()`);
      await pool.query(`insert into "verification" (id,identifier,value,"expiresAt","createdAt","updatedAt") values ($1,$2,$3,now()+interval '2 minutes',now(),now())`,
        [randomUUID(), `freewrite-ios:${digest(code)}`, JSON.stringify({ userId: session.user.id, sessionId: session.session.id, challenge: authorization.code_challenge })]);
      const callback = new URL(IOS_CALLBACK);
      callback.searchParams.set("code", code); callback.searchParams.set("state", authorization.state);
      return reply({ callbackURL: callback.toString() });
    },
    async exchange(request: Request) {
      nativeRequest(request);
      const values = await body(request);
      if (Object.keys(values).length !== 2 || !opaque(values.code) || typeof values.code_verifier !== "string" || (values.code_verifier.length < 43 || values.code_verifier.length > 128 || /[^A-Za-z0-9._~-]/.test(values.code_verifier))) throw invalidCode();
      const challenge = createHash("sha256").update(values.code_verifier).digest("base64url");
      const client = await pool.connect();
      try {
        await client.query("begin");
        const { rows } = await client.query<{ id: string; value: string }>(`select id,value from "verification" where identifier=$1 and "expiresAt">now() for update`, [`freewrite-ios:${digest(values.code)}`]);
        if (rows.length !== 1) throw invalidCode();
        const grant = JSON.parse(rows[0].value) as Record<string, unknown>;
        if (!opaque(grant.challenge) || typeof grant.userId !== "string" || typeof grant.sessionId !== "string" || !timingSafeEqual(Buffer.from(grant.challenge), Buffer.from(challenge))) throw invalidCode();
        const user = (await client.query<User>(`select u.id,u.name,u.email from "user" u join "session" s on s."userId"=u.id where u.id=$1 and s.id=$2 and s."expiresAt">now()`, [grant.userId, grant.sessionId])).rows[0];
        if (!user) throw invalidCode();
        const token = `freewrite_${randomBytes(32).toString("base64url")}`;
        const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
        await client.query(`insert into "session" (id,token,"userId","expiresAt","createdAt","updatedAt","userAgent") values ($1,$2,$3,$4,now(),now(),'freewrite iOS')`,
          [randomUUID(), `ios:${digest(token)}`, user.id, expiresAt]);
        await client.query(`delete from "verification" where id=$1`, [rows[0].id]);
        await client.query("commit");
        return reply({ token, user, expiresAt });
      } catch (error) { await client.query("rollback").catch(() => {}); throw error; }
      finally { client.release(); }
    },
    async session(request: Request) {
      const user = await authenticated(request);
      if (request.method === "DELETE") {
        await pool.query(`delete from "session" where id=$1 and token=$2 and "userId"=$3`, [user.sessionId, user.tokenHash, user.id]);
        return reply({ signedOut: true });
      }
      return reply({ user: { id: user.id, name: user.name, email: user.email }, expiresAt: user.expiresAt });
    },
    async account(request: Request) {
      const user = await authenticated(request);
      const values = await body(request);
      if (Object.keys(values).length !== 2 || values.confirmation !== "DELETE" || values.expectedUserId !== user.id) throw new AuthError("your account changed. sign in again before deleting it.", 409);
      await deleteAccount(pool, user);
      return reply({ deleted: true });
    },
  };
  return async (request: Request, operation: keyof typeof handlers) => {
    try { return await handlers[operation](request); }
    catch (error) { return reply({ error: error instanceof AuthError ? error.message : "couldn’t connect to freewrite. try again." }, error instanceof AuthError ? error.status : 500); }
  };
}
