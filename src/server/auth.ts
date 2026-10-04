import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Auth (design §17.4): Google OIDC restricted to an email allowlist, httpOnly SameSite cookie, CSRF via a required custom header on mutations.
 * HK_AUTH=dev skips sign-in for local development and tests (never use in production).
 */
export interface AuthConfig { mode: 'dev' | 'google'; allowlist: string[]; googleClientId?: string; sessionSecret: string; devUser?: string }
const COOKIE = 'hk_session';

const b64 = (s: string) => Buffer.from(s).toString('base64url');
export function signSession(secret: string, email: string, ttlHours = 24 * 14): string {
  const body = b64(JSON.stringify({ email, exp: Date.now() + ttlHours * 3600_000 }));
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}
export function verifySession(secret: string, token: string | undefined): string | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const want = createHmac('sha256', secret).update(body).digest('base64url');
  if (want.length !== sig.length || !timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  try { const j = JSON.parse(Buffer.from(body, 'base64url').toString()); return j.exp > Date.now() ? String(j.email) : null; } catch { return null; }
}

export async function verifyGoogleIdToken(idToken: string, clientId: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const r = await fetchImpl(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  if (!r.ok) return null;
  const j = (await r.json()) as any;
  return j.aud === clientId && (j.email_verified === true || j.email_verified === 'true') ? String(j.email).toLowerCase() : null;
}

declare module 'fastify' { interface FastifyRequest { user?: string } }

export function registerAuth(app: FastifyInstance, cfg: AuthConfig, verifyId: (t: string) => Promise<string | null> = (t) => verifyGoogleIdToken(t, cfg.googleClientId ?? '')) {
  const allowed = new Set(cfg.allowlist.map((e) => e.toLowerCase()));
  app.post('/auth/google', async (req, reply) => {
    const { idToken } = (req.body ?? {}) as { idToken?: string };
    if (cfg.mode === 'dev') return { ok: true, user: cfg.devUser ?? 'dev' };
    const email = idToken ? await verifyId(idToken) : null;
    if (!email || !allowed.has(email)) return reply.code(403).send({ error: 'not allowed' });
    reply.header('set-cookie', `${COOKIE}=${signSession(cfg.sessionSecret, email)}; HttpOnly; SameSite=Lax; Path=/; Secure; Max-Age=${14 * 86400}`);
    return { ok: true, user: email };
  });
  app.post('/auth/logout', async (_req, reply) => { reply.header('set-cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`); return { ok: true }; });
  app.addHook('onRequest', async (req: FastifyRequest, reply) => {
    const path = req.url.split('?')[0];
    if (path.startsWith('/ingest/') || path.startsWith('/auth/') || path === '/healthz' || !path.startsWith('/api/')) return; // ingest has its own token auth; static assets are public
    if (cfg.mode === 'dev') { req.user = cfg.devUser ?? 'dev'; }
    else {
      const m = /(?:^|;\s*)hk_session=([^;]+)/.exec(req.headers.cookie ?? '');
      const email = verifySession(cfg.sessionSecret, m?.[1]);
      if (!email || !allowed.has(email)) return reply.code(401).send({ error: 'unauthorized' });
      req.user = email;
    }
    // CSRF: mutations must carry a custom header (cannot be set cross-site without CORS preflight)
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-requested-with'] !== 'hearthkeeper') return reply.code(403).send({ error: 'csrf' });
  });
}
