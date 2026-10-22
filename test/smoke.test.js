// API-level checks against a real Postgres. Run:  TEST_DATABASE_URL=postgres://... node test/smoke.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { initSchema } from '../src/db.js';
import { authError } from '../src/auth.js';

process.env.NODE_ENV = 'test';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.join(__dirname, '..', 'frontend');
const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 3 });

const verify = async (tok) => {
  if (tok === 'good') return { email: 'vallesindia@gmail.com', name: 'Valles' };
  if (tok === 'stranger') throw authError(403, 'NOT_ALLOWED', 'stranger@x.com is not allowed to use this app');
  throw authError(401, 'INVALID_TOKEN', 'Google rejected the token');
};

let server, base;
const H = (t) => ({ Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' });
const payload = (extra = {}) => ({
  app: 'Valles Management System', version: 2, savedAt: new Date().toISOString(),
  org: { name: 'Valles' }, employees: [{ id: 'e1', name: 'A', _rev: 1 }], payslips: [], parties: [], documents: [],
  transactions: [], expenses: [], reimbursements: [], compliance: {}, presence: {}, tombstones: {}, ...extra,
});

test.before(async () => {
  await pool.query('DROP TABLE IF EXISTS app_state, state_history, backups');
  await initSchema(pool);
  const app = createApp({ pool, verify, frontendDir });
  await new Promise((r) => { server = app.listen(0, r); });
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => { server.close(); await pool.end(); });

test('index.html is served with the bridge tag, and the file on disk is untouched', async () => {
  const html = await (await fetch(base + '/')).text();
  assert.ok(html.startsWith('<!DOCTYPE html>') || html.startsWith('<!doctype html>') || html.includes('<head><script src="/shim/valles-shim.js">'));
  assert.ok(html.includes('<head><script src="/shim/valles-shim.js"></script>'));
  const disk = fs.readFileSync(path.join(frontendDir, 'index.html'), 'utf8');
  assert.ok(!disk.includes('valles-shim.js'), 'index.html on disk must not contain the bridge tag');
  assert.equal(html.replace('<script src="/shim/valles-shim.js"></script>', ''), disk, 'only the tag differs');
  const shim = await fetch(base + '/shim/valles-shim.js');
  assert.equal(shim.status, 200);
});

test('API rejects missing / bad / non-allowed tokens', async () => {
  assert.equal((await fetch(base + '/api/state')).status, 401);
  assert.equal((await fetch(base + '/api/state', { headers: H('bad') })).status, 401);
  assert.equal((await fetch(base + '/api/state', { headers: H('stranger') })).status, 403);
});

test('empty server returns 204, then save/load round-trips exactly', async () => {
  assert.equal((await fetch(base + '/api/state', { headers: H('good') })).status, 204);
  const p = payload({ employees: [{ id: 'e1', name: 'Ünï ₹ 日本', _rev: 3, nested: { a: [1, 2.5, null] } }] });
  const put = await fetch(base + '/api/state', { method: 'PUT', headers: H('good'), body: JSON.stringify(p) });
  assert.equal(put.status, 200);
  const got = await (await fetch(base + '/api/state', { headers: H('good') })).json();
  assert.deepEqual(got, p);
});

test('heartbeat-only change updates in place without a history row', async () => {
  const before = (await pool.query('SELECT count(*)::int n FROM state_history')).rows[0].n;
  const cur = await (await fetch(base + '/api/state', { headers: H('good') })).json();
  cur.presence = { Priya: new Date().toISOString() }; cur.savedAt = new Date().toISOString();
  const r = await (await fetch(base + '/api/state', { method: 'PUT', headers: H('good'), body: JSON.stringify(cur) })).json();
  assert.equal(r.unchanged, true);
  assert.equal((await pool.query('SELECT count(*)::int n FROM state_history')).rows[0].n, before);
});

test('empty payload cannot wipe real data; large shrink is snapshotted first', async () => {
  const wipe = await fetch(base + '/api/state', { method: 'PUT', headers: H('good'), body: JSON.stringify(payload({ employees: [] })) });
  assert.equal(wipe.status, 409);
  assert.equal((await wipe.json()).error.code, 'REFUSED_EMPTY_WRITE');

  const many = payload({ employees: Array.from({ length: 10 }, (_, i) => ({ id: 'x' + i, _rev: 1 })) });
  await fetch(base + '/api/state', { method: 'PUT', headers: H('good'), body: JSON.stringify(many) });
  const small = payload({ employees: [{ id: 'x0', _rev: 1 }] });
  await fetch(base + '/api/state', { method: 'PUT', headers: H('good'), body: JSON.stringify(small) });
  const hist = await (await fetch(base + '/api/history', { headers: H('good') })).json();
  assert.ok(hist.some((h) => h.record_count === 10), 'the 10-record state was kept in history');
  const snap = await (await fetch(base + '/api/history/' + hist.find((h) => h.record_count === 10).id, { headers: H('good') })).json();
  assert.equal(snap.employees.length, 10);
});

test('bad payloads are refused', async () => {
  const r = await fetch(base + '/api/state', { method: 'PUT', headers: H('good'), body: JSON.stringify({ hello: 1 }) });
  assert.equal(r.status, 400);
});

test('backups: create, list, read, delete', async () => {
  const data = payload();
  const c = await (await fetch(base + '/api/backups', { method: 'POST', headers: H('good'), body: JSON.stringify({ name: 'backup-2026-10-22.json', data }) })).json();
  assert.ok(c.id.startsWith('vbk_'));
  const list = await (await fetch(base + '/api/backups', { headers: H('good') })).json();
  assert.equal(list[0].name, 'backup-2026-10-22.json');
  const one = await (await fetch(base + '/api/backups/' + c.id, { headers: H('good') })).json();
  assert.deepEqual(one, data);
  assert.equal((await fetch(base + '/api/backups/' + c.id, { method: 'DELETE', headers: H('good') })).status, 204);
  assert.equal((await fetch(base + '/api/backups/' + c.id, { headers: H('good') })).status, 404);
});

test('health endpoints work without a token', async () => {
  assert.equal((await fetch(base + '/healthz')).status, 200);
  assert.equal((await fetch(base + '/readyz')).status, 200);
});
