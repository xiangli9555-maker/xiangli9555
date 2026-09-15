'use strict';

const crypto = require('crypto');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const ALLOW_INSECURE_DEV = process.env.ALLOW_INSECURE_DEV === 'true';
const ROLE_LEVEL = Object.freeze({ viewer: 1, editor: 2, admin: 3 });

// ★ 2026-09-14 编辑权限收口：站点默认只读浏览，仅 lycheelli 用编辑口令解锁后可写。
//   口令用 VOMI_OWNER_KEY 覆盖（docker-compose / .env）；未配则用下面的内置默认口令。
//   签发的是 HMAC 签名的短期令牌（默认 30 天），前端存 localStorage，每次请求带 X-Vomi-Editor。
const OWNER_SUBJECT = 'lycheelli';
const DENY_MESSAGE = '请找 lycheelli 申请权限';
const DEFAULT_OWNER_KEY = 'vomi-owner-2026';
const OWNER_KEY = String(process.env.VOMI_OWNER_KEY || DEFAULT_OWNER_KEY);
const SESSION_SECRET = String(process.env.VOMI_SESSION_SECRET || OWNER_KEY || 'vomi-session-secret');
const OWNER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
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

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signPayload(body) {
  return b64url(crypto.createHmac('sha256', SESSION_SECRET).update(body).digest());
}

/** 校验编辑口令（常量时间比较）。 */
function checkOwnerKey(key) {
  return safeEqual(String(key || ''), OWNER_KEY);
}

/** 签发 lycheelli 的编辑令牌：`<base64url(payload)>.<hmac>`。 */
function issueOwnerToken(subject = OWNER_SUBJECT, ttlMs = OWNER_SESSION_TTL_MS) {
  const now = Date.now();
  const body = b64url(Buffer.from(JSON.stringify({ sub: String(subject), iat: now, exp: now + ttlMs })));
  return `${body}.${signPayload(body)}`;
}

/** 校验编辑令牌，通过返回 subject，否则 null。 */
function verifyOwnerToken(token) {
  const raw = String(token || '').trim();
  const dot = raw.indexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return null;
  const body = raw.slice(0, dot);
  const given = Buffer.from(raw.slice(dot + 1));
  const expect = Buffer.from(signPayload(body));
  if (given.length !== expect.length) return null;
  if (!crypto.timingSafeEqual(given, expect)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (!payload || !payload.sub || !Number.isFinite(payload.exp) || payload.exp < Date.now()) return null;
    return String(payload.sub);
  } catch (_) {
    return null;
  }
}

// 只看 socket 层的对端地址（不看 req.ip）：req.ip 会被 X-Forwarded-For 影响，
// 一旦被伪造成本机地址就会静默放权，所以这里只认「真的是容器内部回环」这种连接。
// 用途：backend 容器内的 run_demand_job 等作业会 POST http://127.0.0.1:3001/... ，需要保持可写。
function isLoopbackRequest(req) {
  const ip = String((req && req.socket && req.socket.remoteAddress) || '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function safeEqual(actual, expected) {
  const a = Buffer.from(String(actual || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function apiAuth(req, res, next) {
  // ★ 2026-09-14 权限收口（PM 拍板）：**默认只读**。
  //   优先级：guest 头 → lycheelli 编辑令牌 → 服务端 Bearer 令牌 → 本机回环 → viewer。
  //   1) 分享链接（X-Vomi-Role: guest）恒为 viewer，写请求由 methodRbac 拒 403。
  const guestHeader = String(req.headers['x-vomi-role'] || '').toLowerCase();
  if (guestHeader === 'guest') {
    req.auth = { subject: 'guest', role: 'viewer' };
    return next();
  }

  // 2) 已解锁的 lycheelli：X-Vomi-Editor 带有效 HMAC 令牌 → admin（唯一可写身份）。
  const owner = verifyOwnerToken(req.headers['x-vomi-editor']);
  if (owner) {
    req.auth = { subject: owner, role: 'admin', via: 'owner-session' };
    return next();
  }

  // 3) 服务端令牌（脚本 / CI）：令牌自带角色。
  const header = String(req.headers.authorization || '');
  const match = /^Bearer\s+([^\s]+)$/i.exec(header);
  const credential = match ? CREDENTIALS.find((row) => safeEqual(match[1], row.token)) : null;
  if (credential) {
    req.auth = { subject: credential.subject, role: credential.role, via: 'token' };
    return next();
  }

  // 4) 容器内回环调用（定时任务 / 冒烟脚本）维持 admin，避免现有内部作业被误伤。
  if (isLoopbackRequest(req)) {
    req.auth = { subject: 'loopback', role: 'admin', via: 'loopback' };
    return next();
  }

  // 5) 其余一律只读浏览：GET 正常，写请求被 methodRbac 拒 403（提示请找 lycheelli 申请权限）。
  req.auth = { subject: 'visitor', role: 'viewer', via: 'default' };
  return next();
}

function requireRole(minimumRole) {
  if (!ROLE_LEVEL[minimumRole]) throw new Error(`Unsupported minimum role: ${minimumRole}`);
  return (req, res, next) => {
    const actual = req.auth && req.auth.role;
    if (!ROLE_LEVEL[actual] || ROLE_LEVEL[actual] < ROLE_LEVEL[minimumRole]) {
      res.setHeader('X-Vomi-Apply-To', OWNER_SUBJECT);
      return res.status(403).json({
        ok: false,
        error: 'forbidden',
        required_role: minimumRole,
        message: DENY_MESSAGE,
      });
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
  checkOwnerKey,
  corsGuard,
  issueOwnerToken,
  methodRbac,
  OWNER_SUBJECT,
  DENY_MESSAGE,
  positiveInt,
  publicError,
  rateLimit,
  requireRole,
  secureHeaders,
  verifyOwnerToken,
};
