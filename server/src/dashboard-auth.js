import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const equal = (a, b) => typeof a === 'string' && typeof b === 'string' &&
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

export function createDashboardAuth({ username, password, secret, origin, now = Date.now }) {
  if (!username || !password || password.length < 12) throw new Error('Set DASHBOARD_USERNAME and DASHBOARD_PASSWORD (at least 12 characters) in .env');
  const sessions = new Map();
  const ttl = 8 * 60 * 60 * 1000;
  let attempts = 0, windowStart = now();
  const cookieName = origin.startsWith('https:') ? '__Host-rokid_session' : 'rokid_session';
  const attributes = `Path=/; HttpOnly; SameSite=Strict${origin.startsWith('https:') ? '; Secure' : ''}`;
  const sign = id => createHmac('sha256', secret).update(id).digest('base64url');
  function expire() {
    for (const [id, session] of sessions) if (session.expires <= now()) revoke(id);
  }
  function revoke(id) {
    const session = sessions.get(id);
    sessions.delete(id);
    for (const ws of session?.sockets || []) ws.terminate();
  }
  function session(req) {
    expire();
    const cookie = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    if (!cookie || cookie.length > 200) return null;
    const [id, signature, extra] = cookie.split('.');
    if (extra || !equal(signature, sign(id))) return null;
    const found = sessions.get(id);
    return found ? { id, ...found } : null;
  }
  async function handle(req, res, pathname) {
    if (!['/api/login', '/api/logout', '/api/session'].includes(pathname)) return false;
    res.setHeader('Content-Type', 'application/json');
    const reply = (status, value) => { res.writeHead(status); res.end(JSON.stringify(value)); return true; };
    if (pathname === '/api/session' && req.method === 'GET') return reply(session(req) ? 200 : 401, { authenticated: Boolean(session(req)) });
    if (req.method !== 'POST') return reply(405, { error: 'Method not allowed' });
    if (req.headers.origin !== origin) return reply(403, { error: 'Origin rejected' });
    if (pathname === '/api/logout') {
      const current = session(req); if (current) revoke(current.id);
      res.setHeader('Set-Cookie', `${cookieName}=; ${attributes}; Max-Age=0`);
      return reply(200, { authenticated: false });
    }
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') return reply(415, { error: 'JSON required' });
    if (now() - windowStart >= 60_000) { attempts = 0; windowStart = now(); }
    // Global bound is intentional for this single-user app behind a localhost reverse proxy.
    if (++attempts > 20) { res.setHeader('Retry-After', '60'); return reply(429, { error: 'Too many login attempts. Try again in a minute.' }); }
    let body = '', bytes = 0;
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 4096) return reply(413, { error: 'Request too large' });
        body += chunk;
      }
      const credentials = JSON.parse(body);
      const validUser = equal(credentials.username, username), validPassword = equal(credentials.password, password);
      if (!validUser || !validPassword) return reply(401, { error: 'Invalid username or password' });
    } catch { return reply(400, { error: 'Invalid login request' }); }
    expire();
    const previous = session(req); if (previous) revoke(previous.id);
    if (sessions.size >= 100) revoke(sessions.keys().next().value);
    const id = randomBytes(32).toString('base64url');
    sessions.set(id, { expires: now() + ttl, sockets: new Set() });
    res.setHeader('Set-Cookie', `${cookieName}=${id}.${sign(id)}; ${attributes}; Max-Age=${ttl / 1000}`);
    return reply(200, { authenticated: true });
  }
  return { handle, session, expire, attach(current, ws) { sessions.get(current.id)?.sockets.add(ws); ws.on('close', () => sessions.get(current.id)?.sockets.delete(ws)); } };
}
