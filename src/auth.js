// Google access-token verification + email allowlist.
//
// The app already signs in with Google (for Drive). Every API call it makes carries that same
// access token. We verify it with Google, then ask Google who it belongs to, then check that
// email against ALLOWED_EMAILS. Fail-closed: if ALLOWED_EMAILS or GOOGLE_OAUTH_CLIENT_ID is not
// set, nobody gets in.
//
// Unlike a "warn but allow" audience check, the token's audience MUST equal our OAuth client ID,
// so a token issued to some other app can never be used here.

const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const ABOUT_URL = 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName)';
const CACHE_TTL_MS = 5 * 60 * 1000;

const cache = new Map();

function allowedEmails() {
  return (process.env.ALLOWED_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export async function verifyGoogleToken(accessToken) {
  const now = Date.now();
  const hit = cache.get(accessToken);
  if (hit && hit.expiresAt > now) return hit.user;

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!clientId) throw authError(500, 'SERVER_NOT_CONFIGURED', 'GOOGLE_OAUTH_CLIENT_ID is not set');
  const allow = allowedEmails();
  if (!allow.length) throw authError(500, 'SERVER_NOT_CONFIGURED', 'ALLOWED_EMAILS is not set');

  const infoRes = await fetch(`${TOKENINFO_URL}?access_token=${encodeURIComponent(accessToken)}`);
  if (!infoRes.ok) throw authError(401, 'INVALID_TOKEN', 'Google rejected the token');
  const info = await infoRes.json();
  if (info.aud !== clientId) throw authError(401, 'WRONG_AUDIENCE', 'Token was not issued to this app');

  // The Drive scope the app already uses is enough for Google to tell us who the user is.
  const aboutRes = await fetch(ABOUT_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!aboutRes.ok) throw authError(401, 'USER_LOOKUP_FAILED', 'Could not identify the signed-in user');
  const about = await aboutRes.json();
  const email = String(about?.user?.emailAddress || '').toLowerCase();
  if (!email) throw authError(401, 'NO_EMAIL', 'No email on this Google account');
  if (!allow.includes(email)) throw authError(403, 'NOT_ALLOWED', `${email} is not allowed to use this app`);

  const user = { email, name: about.user.displayName || email };
  const expiresIn = Number(info.expires_in) > 0 ? Number(info.expires_in) * 1000 - 30_000 : CACHE_TTL_MS;
  cache.set(accessToken, { user, expiresAt: now + Math.min(expiresIn, CACHE_TTL_MS) });
  return user;
}

export function authError(status, code, detail) {
  const e = new Error(detail);
  e.status = status;
  e.code = code;
  return e;
}

setInterval(() => {
  const now = Date.now();
  for (const [t, v] of cache) if (v.expiresAt <= now) cache.delete(t);
}, CACHE_TTL_MS).unref?.();

export function requireAuth(verify = verifyGoogleToken) {
  return async (req, res, next) => {
    const m = (req.headers.authorization || '').match(/^Bearer (.+)$/i);
    if (!m) return res.status(401).json({ error: { code: 'MISSING_TOKEN', message: 'Sign in with Google first' } });
    try {
      req.user = await verify(m[1]);
      next();
    } catch (err) {
      const status = err.status || 401;
      if (status >= 500) console.error('[auth]', err.message);
      res.status(status).json({ error: { code: err.code || 'AUTH_FAILED', message: err.message } });
    }
  };
}
