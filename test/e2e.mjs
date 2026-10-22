// End-to-end: the REAL app in headless Chromium, talking to the real server + Postgres.
// Google is stubbed (token check + the Drive folder calls); everything else is the app's own code.
//
//   TEST_DATABASE_URL=postgres://... node test/e2e.mjs
//
// Needs `playwright` (global is fine: NODE_PATH=$(npm root -g)).
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { initSchema } from '../src/db.js';
import { authError } from '../src/auth.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
process.env.NODE_ENV = 'test';
const frontendDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'frontend');

const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 3 });
await pool.query('DROP TABLE IF EXISTS app_state, state_history, backups');
await initSchema(pool);
const verify = async (t) => { if (t === 'tok') return { email: 'vallesindia@gmail.com' }; throw authError(401, 'INVALID_TOKEN', 'bad'); };
const server = await new Promise((r) => { const s = createApp({ pool, verify, frontendDir }).listen(0, () => r(s)); });
const base = 'http://127.0.0.1:' + server.address().port;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const results = [];
const ok = (name) => { results.push(name); console.log('  ok -', name); };

async function newPage(ctx) {
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Stub Google: gsi script, folder lookups. The data.json/backup calls must NOT reach here (bridge handles them).
  const googleCalls = [];
  await page.route('https://accounts.google.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await page.route('https://www.googleapis.com/**', async (r) => {
    const u = new URL(r.request().url());
    googleCalls.push(r.request().method() + ' ' + u.pathname + u.search.slice(0, 80));
    if (u.pathname === '/drive/v3/files' && r.request().method() === 'GET')
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ files: [{ id: 'FOLDER1', name: 'x' }] }) });
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  return { page, errors, googleCalls };
}

try {
  // ───────── Browser A: first run. App has data locally, Drive "connected", sync → server. ─────────
  const ctxA = await browser.newContext();
  const A = await newPage(ctxA);
  await A.page.goto(base + '/');
  await A.page.waitForFunction(() => typeof driveSyncNow === 'function' && ORG);
  const shimOn = await A.page.evaluate(() => window.fetch.toString().includes('realFetch'));
  assert.ok(shimOn, 'bridge installed on window.fetch');
  ok('bridge is active in the served page');

  await A.page.evaluate(async () => {
    localStorage.setItem('vallesEasyEmsStaffName', 'Priya');
    ORG.gdrive = Object.assign(ORG.gdrive || {}, { connected: true, clientId: 'cid', folderId: 'FOLDER1', backupsFolderId: 'BK1', pinnedFolderId: 'FOLDER1' });
    driveAccessToken = 'tok'; driveTokenExpiry = Date.now() + 3600e3;
    EMPLOYEES.push({ id: 'emp-1', name: 'Test Employee ₹', _rev: 1, salaryHistory: [{ id: 's1', basic: 50000 }] });
    PARTIES.push({ id: 'p-1', partyName: 'Fassco', _rev: 1 });
    await saveEmployees(); await saveParties(); await saveOrg();
    driveDirty = true;
    await driveSyncNow();
  });
  const st = await pool.query('SELECT data, version FROM app_state');
  assert.equal(st.rowCount, 1, 'data landed in Postgres via the app\'s own driveSyncNow');
  assert.equal(st.rows[0].data.employees[0].name, 'Test Employee ₹');
  assert.equal(st.rows[0].data.parties[0].partyName, 'Fassco');
  ok('app sync (driveSyncNow) writes its data payload to Postgres');
  assert.ok(!A.googleCalls.some((c) => /data\.json|upload\/drive\/v3\/files\/valles-api-data/.test(c)), 'no data.json call reached Google');
  ok('no data.json traffic went to Google Drive');

  // The payload in the DB equals what the app itself would build.
  const built = await A.page.evaluate(() => JSON.parse(JSON.stringify(buildPayload())));
  const dbData = st.rows[0].data;
  for (const k of ['employees', 'parties', 'payslips', 'transactions', 'expenses', 'documents', 'reimbursements', 'compliance', 'tombstones']) {
    assert.deepEqual(dbData[k], built[k], 'payload field identical: ' + k);
  }
  ok('stored payload is identical to the app\'s own buildPayload() output');

  // Backup via the app's own function.
  await A.page.evaluate(async () => { await driveBackupNow(); });
  const bk = await pool.query('SELECT name FROM backups');
  assert.equal(bk.rowCount, 1);
  assert.match(bk.rows[0].name, /^backup-.*\.json$/);
  ok('app "Backup now" stores a backup in Postgres');

  // ───────── Browser B: brand-new empty browser; connect → app pulls the data from the server ─────────
  const ctxB = await browser.newContext();
  const B = await newPage(ctxB);
  await B.page.goto(base + '/');
  await B.page.waitForFunction(() => typeof driveReconcileOnConnect === 'function' && ORG);
  await B.page.evaluate(async () => {
    localStorage.setItem('vallesEasyEmsStaffName', 'Arun');
    ORG.gdrive = Object.assign(ORG.gdrive || {}, { connected: true, clientId: 'cid', folderId: 'FOLDER1', backupsFolderId: 'BK1', pinnedFolderId: 'FOLDER1' });
    driveAccessToken = 'tok'; driveTokenExpiry = Date.now() + 3600e3;
    await driveReconcileOnConnect(); // exactly what the app runs right after Google sign-in
  });
  const bState = await B.page.evaluate(() => ({ emp: EMPLOYEES.map((e) => e.name), par: PARTIES.map((p) => p.partyName) }));
  assert.deepEqual(bState.emp, ['Test Employee ₹']);
  assert.deepEqual(bState.par, ['Fassco']);
  ok('a second, empty browser receives the data through the app\'s own first-connect import');

  // Multi-user: B edits and syncs; A pulls.
  await B.page.evaluate(async () => {
    PARTIES.push({ id: 'p-2', partyName: 'Added by Arun', _rev: 1 });
    await saveParties(); driveDirty = true; await driveSyncNow();
  });
  const aSees = await A.page.evaluate(async () => {
    const remote = await pullRemotePayload();
    return remote.parties.map((p) => p.partyName);
  });
  assert.deepEqual(aSees.sort(), ['Added by Arun', 'Fassco']);
  ok('changes made in one browser are visible to the other via pullRemotePayload()');

  // Listing + restore of backups through the app's own functions.
  const listed = await A.page.evaluate(async () => (await driveListBackups()).map((f) => f.name));
  assert.equal(listed.length, 1);
  const restored = await A.page.evaluate(async () => {
    const f = (await driveListBackups())[0];
    const r = await driveFetch(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`);
    const d = await r.json();
    return { app: d.app, emp: d.employees.length };
  });
  assert.equal(restored.app, 'Valles Management System');
  ok('app lists and reads backups from Postgres (driveListBackups / restore read)');

  // ───────── One-time migration: server empty, Drive has the real data.json ─────────
  await pool.query('TRUNCATE app_state, state_history, backups');
  const ctxC = await browser.newContext();
  const C = await newPage(ctxC);
  const legacy = { app: 'Valles Management System', version: 2, org: { name: 'Legacy' }, employees: [{ id: 'old1', name: 'From Drive', _rev: 4 }], payslips: [], parties: [], documents: [], transactions: [], expenses: [], reimbursements: [], compliance: {}, presence: {}, tombstones: {} };
  await C.page.route('https://www.googleapis.com/drive/v3/files/REALDRIVEID?alt=media', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(legacy) }));
  await C.page.goto(base + '/');
  await C.page.waitForFunction(() => typeof driveReconcileOnConnect === 'function' && ORG);
  await C.page.evaluate(async () => {
    localStorage.setItem('vallesEasyEmsStaffName', 'Priya');
    ORG.gdrive = Object.assign(ORG.gdrive || {}, { connected: true, clientId: 'cid', folderId: 'FOLDER1', backupsFolderId: 'BK1', pinnedFolderId: 'FOLDER1', fileId: 'REALDRIVEID' });
    driveAccessToken = 'tok'; driveTokenExpiry = Date.now() + 3600e3;
    await driveReconcileOnConnect();
  });
  const seeded = await pool.query('SELECT data FROM app_state');
  assert.equal(seeded.rowCount, 1);
  assert.equal(seeded.rows[0].data.employees[0].name, 'From Drive');
  const cEmp = await C.page.evaluate(() => EMPLOYEES.map((e) => e.name));
  assert.deepEqual(cEmp, ['From Drive']);
  ok('first run copies the existing Google Drive data.json into the database automatically');

  // ───────── ?backend=drive switches the bridge off ─────────
  const D = await newPage(await browser.newContext());
  await D.page.goto(base + '/?backend=drive');
  await D.page.waitForFunction(() => typeof driveSyncNow === 'function');
  assert.equal(await D.page.evaluate(() => window.fetch.toString().includes('realFetch')), false);
  ok('?backend=drive turns the bridge off');

  for (const p of [A, B, C, D]) assert.deepEqual(p.errors, [], 'no JS errors in page: ' + p.errors.join('; '));
  ok('no JavaScript errors on any page');
  console.log(`\nE2E PASSED (${results.length} checks)`);
} catch (e) {
  console.error('\nE2E FAILED:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
  await pool.end();
}
