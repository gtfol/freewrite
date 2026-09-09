import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyRemoteArticle, deleteArticle, getArticle, getPdfOriginal, listOutbox, putPdfArticle } from "./db.ts";
import { asArticle } from "./article-validation.ts";
import { pdfArticle } from "./pdf.ts";
import type { Article } from "./types.ts";

const record = (id: string): Article => ({
  ...pdfArticle({ title: "Original", text: "Saved reading text.", pageCount: 1, emptyPages: 0 }, "Original"),
  id, via: "pdf", savedAt: 1, readAt: null, updatedAt: 1, deletedAt: null,
});

test("PDF import saves article + original locally while the sync record contains text only", async () => {
  const article = record("local-pdf");
  const file = new File(["%PDF-1.7\noriginal bytes"], "source.pdf", { type: "application/pdf" });
  await putPdfArticle(article, file);
  const saved = await getArticle(article.id);
  assert.ok(saved);
  assert.equal(saved.content, article.content);
  const original = await getPdfOriginal(article.id);
  assert.equal(original?.name, "source.pdf");
  assert.equal(await original?.file.text(), await file.text());
  assert.deepEqual(asArticle(JSON.parse(JSON.stringify(saved))), saved);
  assert.ok(!("file" in saved));
  assert.deepEqual((await listOutbox()).filter((change) => change.id === article.id).map((change) => change.collection), ["articles"]);
  await deleteArticle(article.id);
  assert.equal(await getArticle(article.id), undefined);
  assert.equal(await getPdfOriginal(article.id), undefined);
});

test("a failed original-file write rolls back the article and sync marker", async () => {
  const article = record("failed-pdf");
  const uncloneable = { name: "broken.pdf", fail: () => {} } as unknown as File;
  await assert.rejects(putPdfArticle(article, uncloneable));
  // Let the explicitly aborted transaction finish before looking for remnants.
  assert.equal(await getArticle(article.id), undefined);
  assert.equal(await getPdfOriginal(article.id), undefined);
  assert.ok(!(await listOutbox()).some((change) => change.id === article.id));
});

test("remote text updates preserve a local original and remote deletion removes it", async () => {
  const article = record("remote-pdf");
  await putPdfArticle(article, new File(["%PDF-1.7"], "source.pdf", { type: "application/pdf" }));
  await applyRemoteArticle({ ...article, title: "Renamed remotely", updatedAt: 2 });
  assert.equal((await getArticle(article.id))?.title, "Renamed remotely");
  assert.ok(await getPdfOriginal(article.id));
  await applyRemoteArticle({ ...article, deletedAt: 3, updatedAt: 3 });
  assert.equal(await getPdfOriginal(article.id), undefined);
});
