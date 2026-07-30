import { NextResponse } from "next/server";

import { rootDigest } from "@/lib/hash";
import { getAuth } from "@/lib/server/auth";
import { getPool } from "@/lib/server/db";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_IDS = 200;

async function requireUser(request: Request) {
  const auth = getAuth();
  if (!auth) return null;
  const session = await auth.api.getSession({ headers: request.headers });
  return session?.user.id ?? null;
}

// GET → root digests; GET ?full=1 → the {id, hash, rev} manifest per table.
export async function GET(request: Request) {
  const uid = await requireUser(request);
  if (!uid) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const full = new URL(request.url).searchParams.get("full") === "1";
  const pool = getPool();

  const [entries, articles] = await Promise.all([
    pool.query(`select id, hash, seq from entries where user_id = $1`, [uid]),
    pool.query(`select id, hash, seq from articles where user_id = $1`, [uid]),
  ]);

  if (full) {
    const toItem = (r: { id: string; hash: string; seq: unknown }) => ({
      id: r.id,
      hash: r.hash,
      rev: Number(r.seq),
    });
    return NextResponse.json({
      entries: entries.rows.map(toItem),
      articles: articles.rows.map(toItem),
    });
  }

  return NextResponse.json({
    entries: {
      digest: await rootDigest(entries.rows),
      count: entries.rowCount ?? 0,
    },
    articles: {
      digest: await rootDigest(articles.rows),
      count: articles.rowCount ?? 0,
    },
  });
}

// POST { entries?: id[], articles?: id[] } → full rows for those ids.
export async function POST(request: Request) {
  const uid = await requireUser(request);
  if (!uid) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  let body: { entries?: unknown; articles?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const ids = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string").slice(0, MAX_IDS)
      : [];

  const pool = getPool();
  const entryIds = ids(body.entries);
  const articleIds = ids(body.articles);

  const entries = entryIds.length
    ? await pool.query(
        `select id, content, sketches, created_at, updated_at, deleted_at, seq, hash
         from entries where user_id = $1 and id = any($2)`,
        [uid, entryIds]
      )
    : { rows: [] };
  const articles = articleIds.length
    ? await pool.query(
        `select id, url, title, byline, site_name, excerpt, content,
           content_original, word_count, saved_at, read_at, via, highlights,
           updated_at, deleted_at, seq, hash
         from articles where user_id = $1 and id = any($2)`,
        [uid, articleIds]
      )
    : { rows: [] };

  return NextResponse.json({
    entries: entries.rows.map((r) => ({
      record: {
        id: r.id,
        content: r.content,
        ...(r.sketches?.length && { sketches: r.sketches }),
        createdAt: Number(r.created_at),
        updatedAt: Number(r.updated_at),
        deletedAt: r.deleted_at === null ? null : Number(r.deleted_at),
      },
      rev: Number(r.seq),
      hash: r.hash,
    })),
    articles: articles.rows.map((r) => ({
      record: {
        id: r.id,
        url: r.url,
        title: r.title,
        byline: r.byline,
        siteName: r.site_name,
        excerpt: r.excerpt,
        content: r.content,
        ...(r.content_original !== null && {
          contentOriginal: r.content_original,
        }),
        ...(r.highlights?.length && { highlights: r.highlights }),
        wordCount: r.word_count,
        savedAt: Number(r.saved_at),
        readAt: r.read_at === null ? null : Number(r.read_at),
        via: r.via,
        updatedAt: Number(r.updated_at),
        deletedAt: r.deleted_at === null ? null : Number(r.deleted_at),
      },
      rev: Number(r.seq),
      hash: r.hash,
    })),
  });
}
