import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeContent } from "./article-html.ts";
import { applyRemoteArticle, deleteArticle, getArticle, getPdfOriginal, listOutbox, putArticle, putPdfArticle, saveArticleContent } from "./db.ts";
import type { Article } from "./types.ts";

const record = (id: string): Article => ({ id, title: "A reading", url: "https://example.com/story", byline: null,
  siteName: null, excerpt: null, content: '<p>Keep <em>these</em> words.</p>\n<p>Trim just part.</p>',
  wordCount: 6, savedAt: 1, updatedAt: 1, readAt: null, deletedAt: null, via: "paste" });

test("editing sanitizes executable HTML while preserving article formatting, links, images and TeX", () => {
  const safe = sanitizeContent('<h2>Title</h2><p onclick="bad()">Edited <em>words</em> <a href="/next">next</a><img src="/image.png" onerror="bad()"><span class="math">x^2</span></p><script>bad()</script><iframe src="https://evil.example"></iframe><a href="javascript:bad()">bad link</a>', "https://example.com/story");
  assert.ok(safe.includes('<h2>Title</h2>'));
  assert.ok(safe.includes('<em>words</em>'));
  assert.ok(safe.includes('href="https://example.com/next"'));
  assert.ok(safe.includes('rel="noreferrer noopener"'));
  assert.ok(safe.includes('src="https://example.com/image.png"'));
  assert.ok(safe.includes('<span class="math">x^2</span>'));
  assert.doesNotMatch(safe, /script|iframe|onclick|onerror|bad\(\)/);
});

test("edits preserve a byte-identical original through repeated saves and restore", async () => {
  const article = record("edits"); await putArticle(article);
  const once = await saveArticleContent(article.id, article.content, '<p>Keep <em>these</em> words.</p>', 3);
  assert.equal(once.contentOriginal, article.content);
  const twice = await saveArticleContent(article.id, once.content, '<p>Edited words.</p>', 2);
  assert.equal(twice.contentOriginal, article.content);
  const restored = await saveArticleContent(article.id, twice.content, twice.contentOriginal!, article.wordCount);
  assert.equal(restored.content, article.content);
  assert.equal((await getArticle(article.id))?.content, article.content);
  assert.ok((await listOutbox()).some((item) => item.id === article.id));
});

test("a no-op edit preserves content, timestamp, and absent original", async () => {
  const article = record("noop"); await putArticle(article);
  const before = (await getArticle(article.id))!;
  const after = await saveArticleContent(article.id, before.content, before.content, before.wordCount);
  assert.deepEqual(after, before);
});

test("conflicting remote content is not overwritten and a deletion is not resurrected", async () => {
  const article = record("conflict"); await putArticle(article);
  await applyRemoteArticle({ ...article, content: '<p>New remote body</p>', updatedAt: 2 });
  await assert.rejects(saveArticleContent(article.id, article.content, '<p>Local draft</p>', 2), /changed elsewhere/);
  assert.equal((await getArticle(article.id))?.content, '<p>New remote body</p>');
  await deleteArticle(article.id);
  await assert.rejects(saveArticleContent(article.id, '<p>New remote body</p>', '<p>Resurrection</p>', 1), /changed elsewhere/);
  assert.equal(await getArticle(article.id), undefined);
});

test("editing a PDF retains its source file and concurrent metadata and notes", async () => {
  const article = { ...record("pdf-edit"), via: "pdf" as const, url: "" };
  await putPdfArticle(article, new File(["%PDF-source"], "original.pdf", { type: "application/pdf" }));
  const highlights = [{ id: "note", text: "Keep", prefix: "", suffix: "", note: "my note", createdAt: 1, updatedAt: 2 }];
  await applyRemoteArticle({ ...article, title: "Renamed elsewhere", highlights, updatedAt: 2 });
  const saved = await saveArticleContent(article.id, article.content, '<p>Keep words.</p>', 2);
  assert.equal(saved.title, "Renamed elsewhere");
  assert.deepEqual(saved.highlights, highlights);
  assert.equal(saved.wordCount, 2);
  assert.equal(await (await getPdfOriginal(article.id))?.file.text(), "%PDF-source");
});

test("removing all text is an intentional reversible edit", async () => {
  const article = record("empty-edit"); await putArticle(article);
  const saved = await saveArticleContent(article.id, article.content, "", 0);
  assert.equal(saved.content, ""); assert.equal(saved.wordCount, 0);
  assert.equal(saved.contentOriginal, article.content);
});
