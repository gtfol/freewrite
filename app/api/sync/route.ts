import { NextResponse } from "next/server";
import type { PoolClient } from "pg";

import { getAuth } from "@/lib/server/auth";
import { getPool } from "@/lib/server/db";
import type { Article, Entry, SyncCollectionResult } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_CHANGES = 200;
const PULL_LIMIT = 200;
const MAX_ENTRY_CHARS = 500_000;
const MAX_ARTICLE_CHARS = 2_000_000;

const isId = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 64;
const isStamp = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;
const isStampOrNull = (v: unknown): v is number | null =>
  v === null || v === undefined || isStamp(v);
const asText = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.length <= max ? v : null;
const asOptText = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.length <= max ? v : null;

function asEntry(v: unknown): Entry | null {
  if (typeof v !== "object" || v === null) return null;
  const e = v as Record<string, unknown>;
  const content = asText(e.content, MAX_ENTRY_CHARS);
  if (
    !isId(e.id) ||
    content === null ||
    !isStamp(e.createdAt) ||
    !isStamp(e.updatedAt) ||
    !isStampOrNull(e.deletedAt)
  ) {
    return null;
  }
  return {
    id: e.id,
    content,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    deletedAt: (e.deletedAt as number | null | undefined) ?? null,
  };
}

function asArticle(v: unknown): Article | null {
  if (typeof v !== "object" || v === null) return null;
  const a = v as Record<string, unknown>;
  const content = asText(a.content, MAX_ARTICLE_CHARS);
  const url = asText(a.url, 2048);
  const title = asText(a.title, 1024);
  if (
    !isId(a.id) ||
    content === null ||
    url === null ||
    title === null ||
    !isStamp(a.savedAt) ||
    !isStamp(a.updatedAt) ||
    !isStampOrNull(a.readAt) ||
    !isStampOrNull(a.deletedAt) ||
    typeof a.wordCount !== "number"
  ) {
    return null;
  }
  const contentOriginal = asOptText(a.contentOriginal, MAX_ARTICLE_CHARS);
  return {
    id: a.id,
    url,
    title,
    byline: asOptText(a.byline, 512),
    siteName: asOptText(a.siteName, 512),
    excerpt: asOptText(a.excerpt, 4096),
    content,
    ...(contentOriginal !== null && { contentOriginal }),
    wordCount: Math.max(0, Math.floor(a.wordCount)),
    savedAt: a.savedAt,
    readAt: (a.readAt as number | null | undefined) ?? null,
    via: a.via === "archive" || a.via === "render" ? a.via : null,
    updatedAt: a.updatedAt,
    deletedAt: (a.deletedAt as number | null | undefined) ?? null,
  };
}

function parseCollection<T>(
  v: unknown,
  parse: (item: unknown) => T | null
): { since: number; changes: T[] } {
  if (typeof v !== "object" || v === null) return { since: 0, changes: [] };
  const c = v as Record<string, unknown>;
  const since = isStamp(c.since) ? c.since : 0;
  const changes = Array.isArray(c.changes)
    ? c.changes.slice(0, MAX_CHANGES).flatMap((item) => {
        const parsed = parse(item);
        return parsed ? [parsed] : [];
      })
    : [];
  return { since, changes };
}

async function pushEntries(client: PoolClient, uid: string, changes: Entry[]) {
  for (const e of changes) {
    await client.query(
      `insert into entries (id, user_id, content, created_at, updated_at, deleted_at)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (id) do update set
         content = excluded.content,
         updated_at = excluded.updated_at,
         deleted_at = excluded.deleted_at,
         seq = nextval('sync_seq')
       where entries.user_id = excluded.user_id
         and excluded.updated_at > entries.updated_at`,
      [e.id, uid, e.content, e.createdAt, e.updatedAt, e.deletedAt]
    );
  }
}

async function pushArticles(
  client: PoolClient,
  uid: string,
  changes: Article[]
) {
  for (const a of changes) {
    await client.query(
      `insert into articles (id, user_id, url, title, byline, site_name, excerpt,
         content, content_original, word_count, saved_at, read_at, via,
         updated_at, deleted_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       on conflict (id) do update set
         url = excluded.url,
         title = excluded.title,
         byline = excluded.byline,
         site_name = excluded.site_name,
         excerpt = excluded.excerpt,
         content = excluded.content,
         content_original = excluded.content_original,
         word_count = excluded.word_count,
         read_at = excluded.read_at,
         via = excluded.via,
         updated_at = excluded.updated_at,
         deleted_at = excluded.deleted_at,
         seq = nextval('sync_seq')
       where articles.user_id = excluded.user_id
         and excluded.updated_at > articles.updated_at`,
      [
        a.id,
        uid,
        a.url,
        a.title,
        a.byline,
        a.siteName,
        a.excerpt,
        a.content,
        a.contentOriginal ?? null,
        a.wordCount,
        a.savedAt,
        a.readAt,
        a.via,
        a.updatedAt,
        a.deletedAt,
      ]
    );
  }
}

const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null ? null : Number(v));

async function pullEntries(
  client: PoolClient,
  uid: string,
  since: number
): Promise<SyncCollectionResult<Entry>> {
  const { rows } = await client.query(
    `select id, content, created_at, updated_at, deleted_at, seq
     from entries where user_id = $1 and seq > $2
     order by seq asc limit ${PULL_LIMIT + 1}`,
    [uid, since]
  );
  const hasMore = rows.length > PULL_LIMIT;
  const page = hasMore ? rows.slice(0, PULL_LIMIT) : rows;
  return {
    rows: page.map((r) => ({
      id: r.id,
      content: r.content,
      createdAt: num(r.created_at),
      updatedAt: num(r.updated_at),
      deletedAt: numOrNull(r.deleted_at),
    })),
    cursor: page.length ? num(page[page.length - 1].seq) : since,
    hasMore,
  };
}

async function pullArticles(
  client: PoolClient,
  uid: string,
  since: number
): Promise<SyncCollectionResult<Article>> {
  const { rows } = await client.query(
    `select id, url, title, byline, site_name, excerpt, content,
       content_original, word_count, saved_at, read_at, via, updated_at,
       deleted_at, seq
     from articles where user_id = $1 and seq > $2
     order by seq asc limit ${PULL_LIMIT + 1}`,
    [uid, since]
  );
  const hasMore = rows.length > PULL_LIMIT;
  const page = hasMore ? rows.slice(0, PULL_LIMIT) : rows;
  return {
    rows: page.map((r) => ({
      id: r.id,
      url: r.url,
      title: r.title,
      byline: r.byline,
      siteName: r.site_name,
      excerpt: r.excerpt,
      content: r.content,
      ...(r.content_original !== null && { contentOriginal: r.content_original }),
      wordCount: r.word_count,
      savedAt: num(r.saved_at),
      readAt: numOrNull(r.read_at),
      via: r.via,
      updatedAt: num(r.updated_at),
      deletedAt: numOrNull(r.deleted_at),
    })),
    cursor: page.length ? num(page[page.length - 1].seq) : since,
    hasMore,
  };
}

export async function POST(request: Request) {
  const auth = getAuth();
  if (!auth) {
    return NextResponse.json(
      { error: "Sync is not configured on this deployment" },
      { status: 503 }
    );
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  const uid = session.user.id;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const entries = parseCollection(body.entries, asEntry);
  const articles = parseCollection(body.articles, asArticle);

  const client = await getPool().connect();
  try {
    if (entries.changes.length || articles.changes.length) {
      await client.query("begin");
      await pushEntries(client, uid, entries.changes);
      await pushArticles(client, uid, articles.changes);
      await client.query("commit");
    }

    return NextResponse.json({
      entries: await pullEntries(client, uid, entries.since),
      articles: await pullArticles(client, uid, articles.since),
    });
  } catch (error) {
    await client.query("rollback").catch(() => {});
    console.error("sync failed", error);
    return NextResponse.json({ error: "Sync failed" }, { status: 500 });
  } finally {
    client.release();
  }
}
