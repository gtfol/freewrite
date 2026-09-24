import { getAuth } from '@/lib/server/auth';
import { getPool } from '@/lib/server/db';
import { deleteAccount, validDeletionRequest } from '@/lib/server/account-deletion';

export const runtime = 'nodejs';
export async function DELETE(request: Request) {
  const reply = (body: object, status = 200) => Response.json(body, {status, headers: {'Cache-Control': 'no-store'}});
  try {
    const auth = getAuth();
    if (!auth) return reply({error: 'Sync is unavailable.'}, 503);
    const session = await auth.api.getSession({headers: request.headers, query: {disableCookieCache: true}});
    if (!session) return reply({error: 'Sign in again before deleting your account.'}, 401);
    if (Number(request.headers.get('content-length') ?? 0) > 1024) return reply({error: 'Invalid request.'}, 400);
    const raw = await request.text();
    if (raw.length > 1024) return reply({error: 'Invalid request.'}, 400);
    let body: unknown;
    try { body = JSON.parse(raw); } catch { return reply({error: 'Invalid request.'}, 400); }
    if (!validDeletionRequest(request, body, session.user.id)) return reply({error: 'Your session changed. Reload and try again.'}, 403);
    await deleteAccount(getPool(), session.user);
    return reply({deleted: true});
  } catch { return reply({error: 'Could not delete your account. Try again.'}, 500); }
}
