import type { Pool } from 'pg';

export async function deleteAccount(pool: Pool, user: {id: string; email: string}) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    // The user row's cascade covers sessions, OAuth credentials, writing,
    // articles, sketches and Spotify history. Shares use browser capabilities.
    await client.query('delete from "verification" where identifier = $1 or value = $2', [user.email, user.id]);
    await client.query('delete from "user" where id = $1', [user.id]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally { client.release(); }
}

export function validDeletionRequest(request: Request, body: unknown, userId: string): boolean {
  if (request.headers.get('origin') !== new URL(request.url).origin) return false;
  if (!request.headers.get('content-type')?.startsWith('application/json')) return false;
  if (request.headers.get('sec-fetch-site') === 'cross-site') return false;
  if (!body || typeof body !== 'object') return false;
  const value = body as Record<string, unknown>;
  return value.confirmation === 'DELETE' && value.expectedUserId === userId;
}
