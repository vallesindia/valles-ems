// Express app factory. server.js wires in the real Postgres pool + Google verification;
// the tests wire in a test pool + a fake verifier.
//
// What this server does:
//   * serves the UNCHANGED index.html, adding one <script> tag for the storage bridge at serve time
//   * stores the app's single data payload (the same JSON the app used to keep in Drive's data.json)
//   * keeps a rolling history of that payload, and the app's named backups
// It never recomputes payroll, TDS, GST or invoices. All business logic stays in the browser.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { requireAuth, verifyGoogleToken } from './auth.js';

const STATE_ID = 'main';
const HISTORY_MIN_GAP_MS = 2 * 60 * 1000; // at most one history snapshot every 2 minutes
const HISTORY_KEEP = 300;

// Same counting the app itself uses to decide "is there real data here".
function recordCount(p) {
  if (!p || typeof p !== 'object') return 0;
  const n = (k) => (Array.isArray(p[k]) ? p[k].length : 0);
  return n('employees') + n('payslips') + n('parties') + n('documents') + n('transactions') + n('expenses') + n('reimbursements');
}

// Hash of everything except the fields that change on every heartbeat.
// Keys are sorted so the same data always hashes the same, whatever order it arrives in.
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}
function contentHash(p) {
  const { presence, savedAt, ...rest } = p;
  return crypto.createHash('sha256').update(canonical(rest)).digest('hex');
}

function validPayload(p) {
  return p && typeof p === 'object' && !Array.isArray(p) && typeof p.app === 'string' && p.app.includes('Valles');
}

export function createApp({ pool, verify = verifyGoogleToken, frontendDir }) {
  const app = express();
  app.set('trust proxy', true);

  app.use(
    helmet({
      contentSecurityPolicy: false, // the app uses inline scripts + Google scripts
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }, // Google sign-in popup
      crossOriginResourcePolicy: { policy: 'same-origin' },
    })
  );
  app.use(express.json({ limit: '50mb' }));
  if (process.env.NODE_ENV !== 'test') app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

  // ---- health ----
  app.get('/healthz', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
  app.get('/readyz', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true, db: 'up' });
    } catch (err) {
      console.error('[readyz]', err.message);
      res.status(503).json({ ok: false, db: 'down' });
    }
  });

  // ---- API (everything below needs a signed-in, allowed Google user) ----
  const api = express.Router();
  api.use(requireAuth(verify));
  api.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // Current data. 204 = nothing stored yet (the bridge then seeds it from Drive once).
  api.get('/state', async (_req, res, next) => {
    try {
      const r = await pool.query('SELECT data, version, updated_at, updated_by FROM app_state WHERE id=$1', [STATE_ID]);
      // A stored payload with zero records (e.g. a fresh browser that synced before connecting) counts as "no data yet".
      if (!r.rowCount || recordCount(r.rows[0].data) === 0) return res.status(204).end();
      const row = r.rows[0];
      res.set('X-State-Version', String(row.version));
      res.set('X-Updated-By', row.updated_by || '');
      res.json(row.data);
    } catch (e) {
      next(e);
    }
  });

  // Save data. Whole-payload write, same as the Drive data.json upload it replaces.
  api.put('/state', async (req, res, next) => {
    const payload = req.body;
    if (!validPayload(payload)) return res.status(400).json({ error: { code: 'BAD_PAYLOAD', message: 'Not a Valles data payload' } });
    const incomingCount = recordCount(payload);
    const hash = contentHash(payload);
    const by = req.user.email;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const cur = await client.query('SELECT data, content_hash, record_count, version FROM app_state WHERE id=$1 FOR UPDATE', [STATE_ID]);

      if (!cur.rowCount) {
        await client.query(
          'INSERT INTO app_state (id, data, content_hash, record_count, version, updated_by) VALUES ($1,$2,$3,$4,1,$5)',
          [STATE_ID, payload, hash, incomingCount, by]
        );
        await client.query('COMMIT');
        return res.json({ ok: true, version: 1, created: true });
      }

      const row = cur.rows[0];

      // Safety: an empty payload must never silently replace real data (e.g. a fresh browser).
      if (incomingCount === 0 && row.record_count > 0 && req.query.confirmWipe !== 'true') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: { code: 'REFUSED_EMPTY_WRITE', message: `Refused: would replace ${row.record_count} records with none. Restore from Backup instead.` },
        });
      }

      if (row.content_hash === hash) {
        // Only presence/heartbeat changed: update in place, no history row.
        await client.query('UPDATE app_state SET data=$2, updated_at=now(), updated_by=$3 WHERE id=$1', [STATE_ID, payload, by]);
        await client.query('COMMIT');
        return res.json({ ok: true, version: row.version, unchanged: true });
      }

      // Real change: keep the previous state in history (throttled, but always when shrinking a lot).
      const shrank = row.record_count > 0 && incomingCount < row.record_count * 0.8;
      const last = await client.query('SELECT saved_at FROM state_history ORDER BY saved_at DESC LIMIT 1');
      const gapOk = !last.rowCount || Date.now() - new Date(last.rows[0].saved_at).getTime() > HISTORY_MIN_GAP_MS;
      if (gapOk || shrank) {
        await client.query('INSERT INTO state_history (saved_by, record_count, data) VALUES ($1,$2,$3)', [by, row.record_count, row.data]);
        await client.query(
          'DELETE FROM state_history WHERE id IN (SELECT id FROM state_history ORDER BY saved_at DESC OFFSET $1)',
          [HISTORY_KEEP]
        );
      }

      const version = row.version + 1;
      await client.query(
        'UPDATE app_state SET data=$2, content_hash=$3, record_count=$4, version=$5, updated_at=now(), updated_by=$6 WHERE id=$1',
        [STATE_ID, payload, hash, incomingCount, version, by]
      );
      await client.query('COMMIT');
      res.json({ ok: true, version });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      next(e);
    } finally {
      client.release();
    }
  });

  // ---- named backups (replaces the 5 rolling backup files in Drive) ----
  api.get('/backups', async (_req, res, next) => {
    try {
      const r = await pool.query('SELECT id, name, created_at, size_bytes FROM backups ORDER BY created_at DESC LIMIT 20');
      res.json(r.rows.map((b) => ({ id: b.id, name: b.name, createdTime: b.created_at, size: String(b.size_bytes) })));
    } catch (e) {
      next(e);
    }
  });
  api.post('/backups', async (req, res, next) => {
    try {
      const { name, data } = req.body || {};
      if (!name || !validPayload(data)) return res.status(400).json({ error: { code: 'BAD_BACKUP', message: 'name and data required' } });
      const id = 'vbk_' + crypto.randomBytes(8).toString('hex');
      const size = Buffer.byteLength(JSON.stringify(data));
      await pool.query('INSERT INTO backups (id, name, created_by, size_bytes, data) VALUES ($1,$2,$3,$4,$5)', [id, String(name).slice(0, 200), req.user.email, size, data]);
      res.json({ id, name });
    } catch (e) {
      next(e);
    }
  });
  api.get('/backups/:id', async (req, res, next) => {
    try {
      const r = await pool.query('SELECT data FROM backups WHERE id=$1', [req.params.id]);
      if (!r.rowCount) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such backup' } });
      res.json(r.rows[0].data);
    } catch (e) {
      next(e);
    }
  });
  api.delete('/backups/:id', async (req, res, next) => {
    try {
      await pool.query('DELETE FROM backups WHERE id=$1', [req.params.id]);
      res.status(204).end();
    } catch (e) {
      next(e);
    }
  });

  // ---- history (point-in-time recovery of the data itself) ----
  api.get('/history', async (_req, res, next) => {
    try {
      const r = await pool.query('SELECT id, saved_at, saved_by, record_count FROM state_history ORDER BY saved_at DESC LIMIT 100');
      res.json(r.rows);
    } catch (e) {
      next(e);
    }
  });
  api.get('/history/:id', async (req, res, next) => {
    try {
      const r = await pool.query('SELECT data FROM state_history WHERE id=$1', [req.params.id]);
      if (!r.rowCount) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such snapshot' } });
      res.json(r.rows[0].data);
    } catch (e) {
      next(e);
    }
  });

  app.use('/api', api);

  // ---- frontend ----
  const staticOpts = {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.js')) res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
    },
  };
  app.use('/shim', express.static(path.join(frontendDir, 'shim'), staticOpts));

  // index.html is read from disk untouched; the bridge <script> tag is added to the response only.
  // Behind a path-routing proxy (e.g. easy-solutions.in/valles-ems) the proxy sends X-Base-Path so the
  // tag points at the right place. Only a plain path like /valles-ems is accepted.
  const indexPath = path.join(frontendDir, 'index.html');
  const indexHtml = fs.readFileSync(indexPath, 'utf8');
  if (!indexHtml.includes('<head>')) throw new Error('index.html has no <head> tag to inject the bridge into');
  const servedByPrefix = new Map();
  const servedFor = (prefix) => {
    if (!servedByPrefix.has(prefix)) {
      servedByPrefix.set(prefix, indexHtml.replace('<head>', `<head><script src="${prefix}/shim/valles-shim.js"></script>`));
    }
    return servedByPrefix.get(prefix);
  };
  const sendIndex = (req, res) => {
    const raw = String(req.get('x-base-path') || '').replace(/\/+$/, '');
    const prefix = /^(\/[A-Za-z0-9._-]+)+$/.test(raw) ? raw : '';
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'no-cache');
    res.send(servedFor(prefix));
  };
  app.get('/', sendIndex);
  app.get('/index.html', sendIndex);
  // ?backend=drive on the page URL turns the bridge off (handled inside the bridge itself).

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error('[error]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Server error' } });
  });

  return app;
}
