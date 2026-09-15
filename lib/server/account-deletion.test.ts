import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validDeletionRequest, deleteAccount } from './account-deletion.ts';
import type { Pool } from 'pg';

test('account deletion requires same origin, JSON, typed confirmation and matching account', () => {
  const body = {confirmation: 'DELETE', expectedUserId: 'alice'};
  const request = (headers = {}) => new Request('https://freewrite.gtfol.dev/api/account', {method: 'DELETE', headers: {origin: 'https://freewrite.gtfol.dev', 'content-type': 'application/json', ...headers}});
  assert.equal(validDeletionRequest(request(), body, 'alice'), true);
  assert.equal(validDeletionRequest(request({origin: 'https://evil.test'}), body, 'alice'), false);
  assert.equal(validDeletionRequest(request({'content-type': 'text/plain'}), body, 'alice'), false);
  assert.equal(validDeletionRequest(request(), body, 'bob'), false);
  assert.equal(validDeletionRequest(request(), {...body, confirmation: ''}, 'alice'), false);
});

test('failed account removal rolls back verification cleanup and releases connection', async () => {
  const queries: string[] = []; let released = false;
  const pool = {connect: async () => ({query: async (sql: string) => { queries.push(sql); if (sql.startsWith('delete from "user"')) throw new Error('failed'); }, release: () => {released = true;}})} as unknown as Pool;
  await assert.rejects(deleteAccount(pool, {id: 'alice', email: 'alice@example.test'}));
  assert.equal(queries.at(-1), 'rollback');
  assert.equal(released, true);
});
