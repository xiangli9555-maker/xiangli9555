'use strict';

const crypto = require('crypto');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const ALLOW_INSECURE_DEV = process.env.ALLOW_INSECURE_DEV === 'true';
const ROLE_LEVEL = Object.freeze({ viewer: 1, editor: 2, admin: 3 });
const SUBJECT_PATTERN = /^[\w.@()\-\u4e00-\u9fff]{1,64}$/;
const ALLOWED_ORIGINS = new Set(
  String(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((value) => value.trim().replace(/\/$/, ''))
    .filter(Boolean)
);

function parseCredentials() {
  const credentials = [];
  const raw = String(process.env.API_TOKENS_JSON || '').trim();
  if (raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      throw new Error('API_TOKENS_JSON must be valid JSON');
    }
    const rows = Array.isArray(parsed)
      ? parsed
      : Object.entries(parsed).map(([token, value]) => ({ token, ...(typeof value === 'string' ? { role: value } : value) }));
    for (const row of rows) {
      const token = String(row && row.token || '');
      const role = String(row && row.role || '');
      const subject = String(row && row.subject || role || 'api-user');
      if (token.length < 32) throw new Error('Every API token must contain at least 32 characters');
      if (!ROLE_LEVEL[role]) throw new Error(`Unsupported API role: ${role}`);
      if (!SUBJECT_PATTERN.test(subject)) throw new Error(`Invalid API token subject: ${subject}`);
      credentials.push({ token, role, subject });
    }
  }

  const legacyAdminToken = String(process.env.API_AUTH_TOKEN || '');
  if (legacyAdminToken) {
    if (legacyAdminToken.length < 32) throw new Error('API_AUTH_TOKEN must contain at least 32 characters');
    credentials.push({ token: legacyAdminToken, role: 'admin', subject: 'legacy-admin' });
  }

  if (!credentials.length && IS_PRODUCTION && !ALLOW_INSECURE_DEV) {
    throw new Error('API_TOKENS_JSON or API_AUTH_TOKEN is required in production');
  }
  return credentials;
}

const CREDENTIALS = parseCredentials();

function secureHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', req.path === '/api/health' ? 'no-store' : 'private, no-store');
  next();
}

function requestOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : '';
}

function corsGuard(req, res, next) {
  const origin = String(req.headers.origin || '').replace(/\/$/, '');
  if (!origin) return next();

  const sameOrigin = origin === requestOrigin(req);
  if (!sameOrigin && !ALLOWED_ORIGINS.has(origin)) {
    return res.status(403).json({ ok: false, error: 'origin_not_allowed' });
  }

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

function safeEqual(actual, expected) {
  const a = Buffer.from(String(actual || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function apiAuth(req, res, next) {
  if (!CREDENTIALS.length && ALLOW_INSECURE_DEV && !IS_PRODUCTION) {
    req.auth = { subject: 'insecure-dev', role: 'admin' };
    return next();
  }

  const header = String(req.headers.authorization || '');
  const match = /^Bearer\s+([^\s]+)$/i.exec(header);
  const credential = match ? CREDENTIALS.find((row) => safeEqual(match[1], row.token)) : null;
  if (!credential) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="vo-manager"');
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  req.auth = { subject: credential.subject, role: credential.role };
  next();
}

function requireRole(minimumRole) {
  if (!ROLE_LEVEL[minimumRole]) throw new Error(`Unsupported minimum role: ${minimumRole}`);
  return (req, res, next) => {
    const actual = req.auth && req.auth.role;
    if (!ROLE_LEVEL[actual] || ROLE_LEVEL[actual] < ROLE_LEVEL[minimumRole]) {
      return res.status(403).json({ ok: false, error: 'forbidden', required_role: minimumRole });
    }
    next();
  };
}

function methodRbac(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return requireRole('viewer')(req, res, next);
  if (req.method === 'DELETE') return requireRole('admin')(req, res, next);
  return requireRole('editor')(req, res, next);
}

const rateBuckets = new Map();
function rateLimit({ windowMs = 60_000, max = 120 } = {}) {
  return (req, res, next) => {
    const now = Date.now();
    const key = String(req.ip || req.socket.remoteAddress || 'unknown');
    let bucket = rateBuckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      rateBuckets.set(key, bucket);
    }
    bucket.count += 1;
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
    res.setHeader('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({ ok: false, error: 'rate_limit_exceeded' });
    }
    if (rateBuckets.size > 10_000) {
      for (const [bucketKey, value] of rateBuckets) {
        if (now >= value.resetAt) rateBuckets.delete(bucketKey);
      }
    }
    next();
  };
}

function publicError(error) {
  if (!IS_PRODUCTION) return error && error.message ? error.message : 'internal_error';
  if (error && Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
    return error.message || 'bad_request';
  }
  return 'internal_error';
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

module.exports = {
  apiAuth,
  corsGuard,
  methodRbac,
  positiveInt,
  publicError,
  rateLimit,
  requireRole,
  secureHeaders,
};
