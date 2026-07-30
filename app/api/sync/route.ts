import { NextResponse } from "next/server";
import type { PoolClient } from "pg";

import { getAuth } from "@/lib/server/auth";
import { getPool } from "@/lib/server/db";
import { parseSketch } from "@/lib/sketch";
import type {
  Article,
  Entry,
  Highlight,
  PushOutcome,
  Sketch,
  SyncChange,
  SyncCollectionResult,
  SyncRow,
} from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_CHANGES = 200;
const PULL_LIMIT = 200;
const MAX_ENTRY_CHARS = 500_000;
const MAX_ARTICLE_CHARS = 2_000_000;
const MAX_HIGHLIGHTS = 500;
const MAX_HIGHLIGHT_TEXT = 4_000;
const MAX_HIGHLIGHT_CONTEXT = 200;
const MAX_HIGHLIGHT_NOTE = 8_000;

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
const isHash = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

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

// Absent/empty → null; malformed → false. Malformed highlights must reject
// the whole change (not be dropped): the client's hash covers them, and
// storing that hash over different content would wedge reconciliation.
function asHighlights(v: unknown): Highlight[] | null | false {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.length > MAX_HIGHLIGHTS) return false;
  const out: Highlight[] = [];
  for (const item of v) {
    if (typeof item !== "object" || item === null) return false;
    const h = item as Record<string, unknown>;
    const text = asText(h.text, MAX_HIGHLIGHT_TEXT);
    const context = (c: unknown): c is string =>
      typeof c === "string" && c.length <= MAX_HIGHLIGHT_CONTEXT;
    if (
      !isId(h.id) ||
      !text ||
      !context(h.prefix) ||
      !context(h.suffix) ||
      !isStamp(h.createdAt) ||
      !isStamp(h.updatedAt)
    ) {
      return false;
    }
    const note =
      h.note === null || h.note === undefined
        ? null
        : asText(h.note, MAX_HIGHLIGHT_NOTE);
    if (h.note != null && note === null) return false;
    out.push({
      id: h.id,
      text,
      prefix: h.prefix,
      suffix: h.suffix,
      note,
      createdAt: h.createdAt,
      updatedAt: h.updatedAt,
    });
  }
  return out.length ? out : null;
}

function asArticle(v: unknown): Article | null {
  if (typeof v !== "object" || v === null) return null;
  const a = v as Record<string, unknown>;
  const content = asText(a.content, MAX_ARTICLE_CHARS);
  const url = asText(a.url, 2048);
  const title = asText(a.title, 1024);
  const highlights = asHighlights(a.highlights);
  if (highlights === false) return null;
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
    ...(highlights !== null && { highlights }),
    wordCount: Math.max(0, Math.floor(a.wordCount)),
    savedAt: a.savedAt,
    readAt: (a.readAt as number | null | undefined) ?? null,
    via:
      a.via === "archive" ||
      a.via === "render" ||
      a.via === "paste" ||
      a.via === "freedium"
        ? a.via
        : null,
    updatedAt: a.updatedAt,
    deletedAt: (a.deletedAt as number | null | undefined) ?? null,
  };
}

interface SketchRowShape {
  id: string;
  w: number;
  h: number;
  bg: string;
  strokes: Sketch["strokes"];
  updated_at: unknown;
  deleted_at: unknown;
  seq: unknown;
  hash: string;
}

function parseChanges<T>(
  v: unknown,
  parse: (item: unknown) => T | null
): { since: number; changes: SyncChange<T>[] } {
  if (typeof v !== "object" || v === null) return { since: 0, changes: [] };
  const c = v as Record<string, unknown>;
  const since = isStamp(c.since) ? c.since : 0;
  const changes: SyncChange<T>[] = [];
  if (Array.isArray(c.changes)) {
    for (const item of c.changes.slice(0, MAX_CHANGES)) {
      if (typeof item !== "object" || item === null) continue;
      const change = item as Record<string, unknown>;
      const record = parse(change.record);
      if (!record || !isHash(change.hash)) continue;
      changes.push({
        record,
        baseRev: isStamp(change.baseRev) ? change.baseRev : 0,
        hash: change.hash,
      });
    }
  }
  return { since, changes };
}

const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v === null ? null : Number(v));

interface EntryRowShape {
  id: string;
  content: string;
  created_at: unknown;
  updated_at: unknown;
  deleted_at: unknown;
  seq: unknown;
  hash: string;
}

function entryRow(r: EntryRowShape): SyncRow<Entry> {
  return {
    record: {
      id: r.id,
      content: r.content,
      createdAt: num(r.created_at),
      updatedAt: num(r.updated_at),
      deletedAt: numOrNull(r.deleted_at),
    },
    rev: num(r.seq),
    hash: r.hash,
  };
}

interface ArticleRowShape {
  id: string;
  url: string;
  title: string;
  byline: string | null;
  site_name: string | null;
  excerpt: string | null;
  content: string;
  content_original: string | null;
  word_count: number;
  saved_at: unknown;
  read_at: unknown;
  via: Article["via"];
  highlights: Highlight[] | null;
  updated_at: unknown;
  deleted_at: unknown;
  seq: unknown;
  hash: string;
}

function articleRow(r: ArticleRowShape): SyncRow<Article> {
  return {
    record: {
      id: r.id,
      url: r.url,
      title: r.title,
      byline: r.byline,
      siteName: r.site_name,
      excerpt: r.excerpt,
      content: r.content,
      ...(r.content_original !== null && { contentOriginal: r.content_original }),
      ...(r.highlights?.length && { highlights: r.highlights }),
      wordCount: r.word_count,
      savedAt: num(r.saved_at),
      readAt: numOrNull(r.read_at),
      via: r.via,
      updatedAt: num(r.updated_at),
      deletedAt: numOrNull(r.deleted_at),
    },
    rev: num(r.seq),
    hash: r.hash,
  };
}

function sketchRow(r: SketchRowShape): SyncRow<Sketch> {
  return {
    record: {
      id: r.id,
      w: r.w,
      h: r.h,
      bg: r.bg,
      strokes: r.strokes ?? [],
      updatedAt: num(r.updated_at),
      deletedAt: numOrNull(r.deleted_at),
    },
    rev: num(r.seq),
    hash: r.hash,
  };
}

// jsonb params must be stringified: node-pg serializes a bare JS array as a
// postgres array literal, not json.
const highlightsParam = (a: Article): string | null =>
  a.highlights?.length ? JSON.stringify(a.highlights) : null;

const strokesParam = (s: Sketch): string => JSON.stringify(s.strokes);

const ENTRY_COLS = "id, content, created_at, updated_at, deleted_at, seq, hash";
const SKETCH_COLS =
  "id, w, h, bg, strokes, updated_at, deleted_at, seq, hash";
const ARTICLE_COLS =
  "id, url, title, byline, site_name, excerpt, content, content_original, word_count, saved_at, read_at, via, highlights, updated_at, deleted_at, seq, hash";

// Compare-and-swap write. The update predicate carries the expected seq, so a
// concurrent write from another device turns this into a clean conflict
// instead of a silent overwrite. Legacy rows (hash = '') accept any writer
// once — they predate hashing, so there is no base to compare against.
async function pushEntry(
  client: PoolClient,
  uid: string,
  change: SyncChange<Entry>
): Promise<PushOutcome<Entry>> {
  const e = change.record;

  const inserted = await client.query(
    `insert into entries (id, user_id, content, created_at, updated_at, deleted_at, hash)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (id) do nothing
     returning seq`,
    [e.id, uid, e.content, e.createdAt, e.updatedAt, e.deletedAt, change.hash]
  );
  if (inserted.rowCount) {
    return { id: e.id, status: "ok", rev: num(inserted.rows[0].seq), hash: change.hash };
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const { rows } = await client.query(
      `select ${ENTRY_COLS} from entries where id = $1 and user_id = $2`,
      [e.id, uid]
    );
    if (!rows.length) {
      // Same id under another account — cryptographically negligible; report
      // the client's own state so it stops retrying, write nothing.
      return { id: e.id, status: "ok", rev: change.baseRev, hash: change.hash };
    }
    const current = rows[0] as EntryRowShape;
    if (current.hash === change.hash) {
      return { id: e.id, status: "ok", rev: num(current.seq), hash: current.hash };
    }
    if (num(current.seq) === change.baseRev || current.hash === "") {
      const updated = await client.query(
        `update entries set content = $3, updated_at = $4, deleted_at = $5,
           hash = $6, seq = nextval('sync_seq')
         where id = $1 and user_id = $2 and seq = $7
         returning seq`,
        [e.id, uid, e.content, e.updatedAt, e.deletedAt, change.hash, current.seq]
      );
      if (updated.rowCount) {
        return { id: e.id, status: "ok", rev: num(updated.rows[0].seq), hash: change.hash };
      }
      continue; // raced with another device — re-read and re-decide once
    }
    return { id: e.id, status: "conflict", server: entryRow(current) };
  }

  const { rows } = await client.query(
    `select ${ENTRY_COLS} from entries where id = $1 and user_id = $2`,
    [e.id, uid]
  );
  return { id: e.id, status: "conflict", server: entryRow(rows[0] as EntryRowShape) };
}

async function pushArticle(
  client: PoolClient,
  uid: string,
  change: SyncChange<Article>
): Promise<PushOutcome<Article>> {
  const a = change.record;

  const inserted = await client.query(
    `insert into articles (id, user_id, url, title, byline, site_name, excerpt,
       content, content_original, word_count, saved_at, read_at, via,
       highlights, updated_at, deleted_at, hash)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     on conflict (id) do nothing
     returning seq`,
    [
      a.id, uid, a.url, a.title, a.byline, a.siteName, a.excerpt,
      a.content, a.contentOriginal ?? null, a.wordCount, a.savedAt, a.readAt,
      a.via, highlightsParam(a), a.updatedAt, a.deletedAt, change.hash,
    ]
  );
  if (inserted.rowCount) {
    return { id: a.id, status: "ok", rev: num(inserted.rows[0].seq), hash: change.hash };
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const { rows } = await client.query(
      `select ${ARTICLE_COLS} from articles where id = $1 and user_id = $2`,
      [a.id, uid]
    );
    if (!rows.length) {
      return { id: a.id, status: "ok", rev: change.baseRev, hash: change.hash };
    }
    const current = rows[0] as ArticleRowShape;
    if (current.hash === change.hash) {
      return { id: a.id, status: "ok", rev: num(current.seq), hash: current.hash };
    }
    if (num(current.seq) === change.baseRev || current.hash === "") {
      const updated = await client.query(
        `update articles set url = $3, title = $4, byline = $5, site_name = $6,
           excerpt = $7, content = $8, content_original = $9, word_count = $10,
           read_at = $11, via = $12, highlights = $13, updated_at = $14,
           deleted_at = $15, hash = $16, seq = nextval('sync_seq')
         where id = $1 and user_id = $2 and seq = $17
         returning seq`,
        [
          a.id, uid, a.url, a.title, a.byline, a.siteName, a.excerpt,
          a.content, a.contentOriginal ?? null, a.wordCount, a.readAt, a.via,
          highlightsParam(a), a.updatedAt, a.deletedAt, change.hash, current.seq,
        ]
      );
      if (updated.rowCount) {
        return { id: a.id, status: "ok", rev: num(updated.rows[0].seq), hash: change.hash };
      }
      continue;
    }
    return { id: a.id, status: "conflict", server: articleRow(current) };
  }

  const { rows } = await client.query(
    `select ${ARTICLE_COLS} from articles where id = $1 and user_id = $2`,
    [a.id, uid]
  );
  return { id: a.id, status: "conflict", server: articleRow(rows[0] as ArticleRowShape) };
}

async function pushSketch(
  client: PoolClient,
  uid: string,
  change: SyncChange<Sketch>
): Promise<PushOutcome<Sketch>> {
  const s = change.record;

  const inserted = await client.query(
    `insert into sketches (id, user_id, w, h, bg, strokes, updated_at, deleted_at, hash)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (id) do nothing
     returning seq`,
    [s.id, uid, s.w, s.h, s.bg, strokesParam(s), s.updatedAt, s.deletedAt, change.hash]
  );
  if (inserted.rowCount) {
    return { id: s.id, status: "ok", rev: num(inserted.rows[0].seq), hash: change.hash };
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const { rows } = await client.query(
      `select ${SKETCH_COLS} from sketches where id = $1 and user_id = $2`,
      [s.id, uid]
    );
    if (!rows.length) {
      // A drawing id is six characters, so unlike an entry's uuid this can
      // realistically collide with another account's. Report the client's own
      // state so it stops retrying, and write nothing.
      return { id: s.id, status: "ok", rev: change.baseRev, hash: change.hash };
    }
    const current = rows[0] as SketchRowShape;
    if (current.hash === change.hash) {
      return { id: s.id, status: "ok", rev: num(current.seq), hash: current.hash };
    }
    if (num(current.seq) === change.baseRev || current.hash === "") {
      const updated = await client.query(
        `update sketches set w = $3, h = $4, bg = $5, strokes = $6,
           updated_at = $7, deleted_at = $8, hash = $9, seq = nextval('sync_seq')
         where id = $1 and user_id = $2 and seq = $10
         returning seq`,
        [
          s.id, uid, s.w, s.h, s.bg, strokesParam(s), s.updatedAt, s.deletedAt,
          change.hash, current.seq,
        ]
      );
      if (updated.rowCount) {
        return { id: s.id, status: "ok", rev: num(updated.rows[0].seq), hash: change.hash };
      }
      continue; // raced with another device — re-read and re-decide once
    }
    return { id: s.id, status: "conflict", server: sketchRow(current) };
  }

  const { rows } = await client.query(
    `select ${SKETCH_COLS} from sketches where id = $1 and user_id = $2`,
    [s.id, uid]
  );
  return { id: s.id, status: "conflict", server: sketchRow(rows[0] as SketchRowShape) };
}

async function pull<T>(
  client: PoolClient,
  table: "entries" | "articles" | "sketches",
  cols: string,
  toRow: (r: never) => SyncRow<T>,
  uid: string,
  since: number
): Promise<{ rows: SyncRow<T>[]; cursor: number; hasMore: boolean }> {
  const { rows } = await client.query(
    `select ${cols} from ${table} where user_id = $1 and seq > $2
     order by seq asc limit ${PULL_LIMIT + 1}`,
    [uid, since]
  );
  const hasMore = rows.length > PULL_LIMIT;
  const page = hasMore ? rows.slice(0, PULL_LIMIT) : rows;
  return {
    rows: page.map((r) => toRow(r as never)),
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

  const entries = parseChanges(body.entries, asEntry);
  const articles = parseChanges(body.articles, asArticle);
  const sketches = parseChanges(body.sketches, parseSketch);

  const client = await getPool().connect();
  try {
    const entryResults: PushOutcome<Entry>[] = [];
    const articleResults: PushOutcome<Article>[] = [];
    const sketchResults: PushOutcome<Sketch>[] = [];

    if (entries.changes.length || articles.changes.length || sketches.changes.length) {
      await client.query("begin");
      for (const change of entries.changes) {
        entryResults.push(await pushEntry(client, uid, change));
      }
      for (const change of articles.changes) {
        articleResults.push(await pushArticle(client, uid, change));
      }
      for (const change of sketches.changes) {
        sketchResults.push(await pushSketch(client, uid, change));
      }
      await client.query("commit");
    }

    const entryPull = await pull<Entry>(
      client, "entries", ENTRY_COLS, entryRow as never, uid, entries.since
    );
    const articlePull = await pull<Article>(
      client, "articles", ARTICLE_COLS, articleRow as never, uid, articles.since
    );
    const sketchPull = await pull<Sketch>(
      client, "sketches", SKETCH_COLS, sketchRow as never, uid, sketches.since
    );

    const response: {
      entries: SyncCollectionResult<Entry>;
      articles: SyncCollectionResult<Article>;
      sketches: SyncCollectionResult<Sketch>;
    } = {
      entries: { results: entryResults, ...entryPull },
      articles: { results: articleResults, ...articlePull },
      sketches: { results: sketchResults, ...sketchPull },
    };
    return NextResponse.json(response);
  } catch (error) {
    await client.query("rollback").catch(() => {});
    console.error("sync failed", error);
    return NextResponse.json({ error: "Sync failed" }, { status: 500 });
  } finally {
    client.release();
  }
}
