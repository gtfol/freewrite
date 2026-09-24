import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { deleteAccount } from './account-deletion.ts';

const connectionString = process.env.FREEWRITE_TEST_DATABASE_URL;
test('account deletion cascades personal records and credentials without touching another user', {skip: !connectionString}, async () => {
  const url = new URL(connectionString!);
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/freewrite_settings_test');
  const pool = new Pool({connectionString});
  try {
    await pool.query(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'));
    await pool.query('truncate "user", verification cascade');
    for (const [i, id] of ['alice', 'bob'].entries()) {
      const uuid = `00000000-0000-0000-0000-00000000000${i}`;
      await pool.query('insert into "user"(id,name,email) values ($1,$1,$2)', [id, `${id}@example.test`]);
      await pool.query('insert into session(id,"userId",token,"expiresAt") values ($1,$1,$1,now())', [id]);
      await pool.query('insert into account(id,"accountId","userId","providerId","accessToken") values ($1,$1,$1,\'spotify\',\'private\')', [id]);
      await pool.query('insert into verification(id,identifier,value,"expiresAt") values ($1,$2,$1,now())', [id, `${id}@example.test`]);
      await pool.query('insert into entries(id,user_id,content,created_at,updated_at) values ($1,$2,\'private\',1,1)', [uuid,id]);
      await pool.query('insert into articles(id,user_id,url,title,content,word_count,saved_at,updated_at) values ($1,$2,\'url\',\'title\',\'content\',1,1,1)', [uuid,id]);
      await pool.query('insert into sketches(id,user_id,w,h,bg,strokes,updated_at) values ($1,$1,1,1,\'white\',\'[]\',1)', [id]);
      await pool.query('insert into spotify_plays(user_id,played_at,track_id,name,artist) values ($1,1,\'track\',\'song\',\'artist\')', [id]);
    }
    await deleteAccount(pool, {id:'alice',email:'alice@example.test'});
    for (const [table, column] of [['user','id'],['session','userId'],['account','userId'],['verification','id'],['entries','user_id'],['articles','user_id'],['sketches','user_id'],['spotify_plays','user_id']]) {
      const result = await pool.query(`select "${column}" as owner from "${table}"`);
      assert.deepEqual(result.rows, [{owner:'bob'}], table);
    }
  } finally { await pool.end(); }
});
