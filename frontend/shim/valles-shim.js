/* Valles storage bridge
 * ─────────────────────
 * The app saves its data by uploading one JSON file ("data.json") to Google Drive, and keeps
 * rolling "backup-*.json" files beside it. This bridge sits underneath the app and redirects
 * ONLY those calls to the Valles server (Cloud SQL). It does nothing else:
 *
 *   data.json    read / write   → /api/state
 *   backup-*.json list/read/del → /api/backups
 *   everything else (folders, attachments, Google Sheets export, sign-in) → passes straight to Google
 *
 * The app's own code is not modified. It still thinks it is talking to Drive, so every
 * calculation, merge rule, conflict check and screen behaves exactly as before.
 *
 * Switch it off for a page load with  ?backend=drive  to compare against the old behaviour.
 */
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  if (params.get('backend') === 'drive') {
    console.info('[valles-bridge] off (?backend=drive) - using Google Drive directly');
    return;
  }

  // Where this app is mounted (e.g. "" at the root, or "/valles-ems" behind a path-routing proxy).
  // Worked out from this script's own address, so no configuration is needed.
  var BASE = '';
  try {
    BASE = new URL(document.currentScript.src).pathname.replace(/\/shim\/valles-shim\.js$/, '');
  } catch (e) {}

  var DATA_ID = 'valles-api-data';
  var BACKUP_PREFIX = 'vbk_';
  var realFetch = window.fetch.bind(window);

  function log() {
    var a = Array.prototype.slice.call(arguments);
    a.unshift('[valles-bridge]');
    console.info.apply(console, a);
  }

  function json(status, body) {
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status: status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  function authHeader(init) {
    var h = init && init.headers;
    if (!h) return null;
    if (typeof h.get === 'function') return h.get('Authorization');
    return h.Authorization || h.authorization || null;
  }

  // The app keeps its Drive settings in the global `ORG`. Read it lazily, at call time.
  function org() {
    try { return typeof ORG !== 'undefined' ? ORG : null; } catch (e) { return null; }
  }
  function gdrive() {
    var o = org();
    return (o && o.gdrive) || {};
  }
  function isDataId(id) {
    var g = gdrive();
    return id === DATA_ID || (!!g.fileId && id === g.fileId);
  }

  // Call our own server with the user's Google token (the same one the app uses for Drive).
  function api(path, init, auth) {
    init = init || {};
    init.headers = Object.assign({}, init.headers, { Authorization: auth });
    return realFetch(BASE + '/api' + path, init);
  }

  async function passErrorThrough(res) {
    var msg = 'Server error';
    try {
      var b = await res.clone().json();
      msg = (b && b.error && b.error.message) || msg;
    } catch (e) {}
    return json(res.status, { error: { message: 'Valles server: ' + msg } });
  }

  // Split a multipart/related body (built by the app's driveUploadJson) into metadata + content.
  function parseMultipart(body, contentType) {
    var m = /boundary=([^;]+)/i.exec(contentType || '');
    if (!m || typeof body !== 'string') return null;
    var boundary = '--' + m[1].replace(/^"|"$/g, '');
    var parts = body.split(boundary).filter(function (p) {
      return p && p.trim() && p.trim() !== '--';
    });
    if (parts.length < 2) return null;
    function payload(p) {
      var i = p.indexOf('\r\n\r\n');
      return i < 0 ? null : p.slice(i + 4).replace(/\r\n$/, '');
    }
    try {
      return { meta: JSON.parse(payload(parts[0])), content: JSON.parse(payload(parts[1])) };
    } catch (e) {
      return null;
    }
  }

  // The app is told data.json has our own id, so it never learns the real Drive file's id.
  // For the one-time migration we look the real file up ourselves, in the app's Drive folder.
  async function findRealDataFile(auth) {
    var g = gdrive();
    var folder = g.pinnedFolderId || g.folderId;
    if (!folder) return null;
    var q = "name='data.json' and mimeType='application/json' and trashed=false and '" + folder + "' in parents";
    try {
      var res = await realFetch('https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) + '&fields=files(id,name)', {
        headers: { Authorization: auth },
      });
      if (!res.ok) return null;
      var d = await res.json();
      return d.files && d.files.length ? d.files[0].id : null;
    } catch (e) {
      return null;
    }
  }

  // ---- data.json: read ----
  async function readData(auth) {
    var res = await api('/state', { method: 'GET' }, auth);
    if (res.status === 200) return res;
    if (res.status !== 204) return passErrorThrough(res);

    // Server has no data yet. One-time migration: copy the existing Drive data.json into the database.
    var g = gdrive();
    var realId = g.fileId && g.fileId !== DATA_ID ? g.fileId : await findRealDataFile(auth);
    if (realId) {
      try {
        var d = await realFetch('https://www.googleapis.com/drive/v3/files/' + realId + '?alt=media', {
          headers: { Authorization: auth },
        });
        if (d.ok) {
          var payload = await d.json();
          var put = await api('/state', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }, auth);
          if (put.ok) {
            log('first run: copied existing Google Drive data into the database');
            return json(200, payload);
          }
        }
      } catch (e) {
        log('seed from Drive failed:', e && e.message);
      }
    }
    return json(404, { error: { message: 'No data stored yet' } });
  }

  // ---- data.json: write ----
  async function writeData(content, auth) {
    var res = await api('/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(content),
    }, auth);
    if (!res.ok) return passErrorThrough(res);
    return json(200, { id: DATA_ID, name: 'data.json' });
  }

  window.fetch = async function (input, init) {
    var url;
    try {
      url = new URL(typeof input === 'string' ? input : input.url, location.href);
    } catch (e) {
      return realFetch(input, init);
    }
    if (url.hostname !== 'www.googleapis.com') return realFetch(input, init);

    var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    var auth = authHeader(init);
    if (!auth) return realFetch(input, init);

    var path = url.pathname;
    var m;

    try {
      // Look up data.json by name
      if (method === 'GET' && path === '/drive/v3/files') {
        var q = decodeURIComponent(url.searchParams.get('q') || '');
        if (q.indexOf("name='data.json'") >= 0) {
          return json(200, { files: [{ id: DATA_ID, name: 'data.json' }] });
        }
        var bf = gdrive().backupsFolderId;
        if (bf && q.indexOf("'" + bf + "' in parents") >= 0) {
          var lr = await api('/backups', { method: 'GET' }, auth);
          if (!lr.ok) return passErrorThrough(lr);
          return json(200, { files: await lr.json() });
        }
        return realFetch(input, init);
      }

      // Read a file's content
      m = /^\/drive\/v3\/files\/([^/]+)$/.exec(path);
      if (m && method === 'GET' && url.searchParams.get('alt') === 'media') {
        if (isDataId(m[1])) return readData(auth);
        if (m[1].indexOf(BACKUP_PREFIX) === 0) {
          var br = await api('/backups/' + encodeURIComponent(m[1]), { method: 'GET' }, auth);
          return br.ok ? br : passErrorThrough(br);
        }
        return realFetch(input, init);
      }

      // Delete an old backup
      if (m && method === 'DELETE' && m[1].indexOf(BACKUP_PREFIX) === 0) {
        var dr = await api('/backups/' + encodeURIComponent(m[1]), { method: 'DELETE' }, auth);
        return dr.ok ? new Response(null, { status: 204 }) : passErrorThrough(dr);
      }

      // Upload data.json or a backup (JSON text bodies only; attachments are Blobs and pass through)
      if ((method === 'POST' || method === 'PATCH') && /^\/upload\/drive\/v3\/files(\/[^/]+)?$/.test(path) && init && typeof init.body === 'string') {
        var ct = init.headers && (typeof init.headers.get === 'function' ? init.headers.get('Content-Type') : init.headers['Content-Type']);
        var parsed = parseMultipart(init.body, ct);
        if (parsed && parsed.meta && parsed.meta.name === 'data.json') {
          return writeData(parsed.content, auth);
        }
        if (parsed && parsed.meta && /^backup-.*\.json$/.test(parsed.meta.name || '')) {
          var cr = await api('/backups', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: parsed.meta.name, data: parsed.content }),
          }, auth);
          if (!cr.ok) return passErrorThrough(cr);
          var created = await cr.json();
          return json(200, { id: created.id, name: parsed.meta.name });
        }
      }
    } catch (err) {
      log('bridge error:', err && err.message);
      return json(502, { error: { message: 'Valles server unreachable: ' + (err && err.message) } });
    }

    return realFetch(input, init);
  };

  log('active - app data and backups are stored on the Valles server');
})();
