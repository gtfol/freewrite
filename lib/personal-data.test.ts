import assert from 'node:assert/strict';
import { test } from 'node:test';
import 'fake-indexeddb/auto';
import { personalDataExport } from './personal-data.ts';
import { applyRemoteEntry, getEntry, localPut, AUDIO, putEntry, putPdfArticle, readPersonalData, resetPersonalData } from './db.ts';
import type { Entry, Article } from './types.ts';

test('export allowlist omits credentials, tombstones and sync internals', () => {
  const entry = {id: 'e', createdAt: 1, updatedAt: 2, content: 'Writing', token: 'private', userId: 'account', hash: 'sync', deletedAt: null};
  const exported = personalDataExport({entries: [entry], articles: [], sketches: []}, 0);
  assert.deepEqual(exported.entries, [{id: 'e', content: 'Writing', createdAt: 1, updatedAt: 2}]);
  assert.equal(exported.version, 1);
  assert.equal(exported.exportedAt, '1970-01-01T00:00:00.000Z');
});

test('snapshot includes original PDFs; reset blocks delayed saves, sync and audio writes', async () => {
  const entry: Entry = {id: 'entry', content: 'Draft', createdAt: 1, updatedAt: 2};
  await putEntry(entry);
  const article = {id: 'pdf', url: '', title: 'PDF', content: '<p>Text</p>', wordCount: 1, savedAt: 1, updatedAt: 1} as Article;
  await putPdfArticle(article, new File(['original'], 'original.pdf', {type: 'application/pdf'}));
  const snapshot = await readPersonalData();
  assert.equal(snapshot.entries[0].content, 'Draft');
  assert.equal(await snapshot.pdfs[0].file.text(), 'original');
  await resetPersonalData();
  await assert.rejects(putEntry({...entry, content: 'Delayed autosave'}));
  await assert.rejects(applyRemoteEntry(entry));
  await assert.rejects(localPut(AUDIO, {key: 'audio', bytes: new Blob(['audio'])}));
  assert.equal(await getEntry('entry'), undefined);
  assert.deepEqual(await readPersonalData(), {entries: [], articles: [], sketches: [], pdfs: []});
});
