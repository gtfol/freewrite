import assert from "node:assert/strict";
import { test } from "node:test";

import { asArticle } from "./article-validation.ts";
import type { Article, Highlight } from "./types.ts";

function article(overrides: Partial<Article> = {}): Article {
  return {
    id: "42cbef7c-9d8e-449f-8ed1-7026115b22b5",
    url: "https://example.com/article",
    title: "A saved article",
    byline: "An author",
    siteName: "Example",
    excerpt: "Text from the article.",
    content: "<p>Text from the article.</p>",
    wordCount: 4,
    savedAt: 1_700_000_000_000,
    readAt: null,
    via: null,
    updatedAt: 1_700_000_000_000,
    deletedAt: null,
    ...overrides,
  };
}

function highlight(overrides: Partial<Highlight> = {}): Highlight {
  return {
    id: "highlight-1",
    text: "Text from the article.",
    prefix: "",
    suffix: "",
    note: "A note",
    createdAt: 1_700_000_000_100,
    updatedAt: 1_700_000_000_100,
    ...overrides,
  };
}

test("a PDF without a public URL retains every field through sync validation and JSON serialization", () => {
  const pdf = article({
    url: "",
    title: "Imported document",
    byline: null,
    siteName: null,
    via: "pdf",
    contentOriginal: "<p>Text from the article.</p><p>Removed paragraph.</p>",
    highlights: [highlight()],
    readAt: 1_700_000_000_200,
    updatedAt: 1_700_000_000_300,
  });

  const accepted = asArticle(JSON.parse(JSON.stringify(pdf)));
  // In particular, silently normalizing "pdf" to null would store content
  // that no longer matches the source marker covered by the client's hash.
  assert.deepEqual(accepted, pdf);
  assert.deepEqual(asArticle(JSON.parse(JSON.stringify(accepted))), pdf);
});

test("existing article sources and their public URLs remain unchanged", () => {
  for (const via of [null, "archive", "render", "paste", "freedium"] as const) {
    const existing = article({ via });
    assert.deepEqual(asArticle(JSON.parse(JSON.stringify(existing))), existing);
  }
});

test("older records still normalize absent optional fields and omit empty highlights", () => {
  const existing = article();
  const legacy = {
    ...existing,
    byline: undefined,
    siteName: undefined,
    excerpt: undefined,
    readAt: undefined,
    deletedAt: undefined,
    via: undefined,
    highlights: [],
  };
  assert.deepEqual(asArticle(legacy), {
    ...existing,
    byline: null,
    siteName: null,
    excerpt: null,
  });
  assert.equal(asArticle({ ...existing, via: "unrecognized" })?.via, null);
});

test("PDFs obey the existing article content, URL, title, and timestamp limits", () => {
  const pdf = article({ url: "", via: "pdf" });
  const limit = "a".repeat(2_000_000);
  assert.equal(asArticle({ ...pdf, content: limit })?.content, limit);
  for (const invalid of [
    { content: `${limit}a` },
    { content: null },
    { url: null },
    { url: "a".repeat(2049) },
    { title: "a".repeat(1025) },
    { id: "" },
    { savedAt: -1 },
    { updatedAt: Infinity },
    { readAt: "today" },
    { deletedAt: -1 },
    { wordCount: "4" },
  ]) {
    assert.equal(asArticle({ ...pdf, ...invalid }), null);
  }
});

test("malformed PDF highlights reject the entire record instead of altering hashed content", () => {
  const pdf = article({ url: "", via: "pdf" });
  for (const highlights of [
    "not an array",
    [null],
    [highlight({ text: "" })],
    [highlight({ text: "a".repeat(4001) })],
    [highlight({ prefix: "a".repeat(201) })],
    [highlight({ note: "a".repeat(8001) })],
    [highlight({ createdAt: -1 })],
    Array.from({ length: 501 }, (_, index) => highlight({ id: `h-${index}` })),
  ]) {
    assert.equal(asArticle({ ...pdf, highlights }), null);
  }
});

test("PDF tombstones retain their source marker for subsequent sync", () => {
  const pdf = article({ url: "", via: "pdf", deletedAt: 1_700_000_000_400 });
  assert.deepEqual(asArticle(pdf), pdf);
});
