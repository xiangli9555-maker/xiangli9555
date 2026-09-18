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

// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-16 职能组权限（PM 拍板）
//   · 只有两个组：copy（文案，含文案 PM）/ audio（音频，含音频 PM）
//   · 文案组：除「录制档期」以外的页面都能编辑 → 除 schedule 域外的写请求都放行
//   · 音频组：全部 5 个页面都能编辑 → 所有域都放行
//   · 删除不再是特权：任意 editor 都能删，前端负责二次确认（assets/guest-mode.js）
//   名单可用 VOMI_USERS_JSON 整体覆盖（数组或 {account:{name,group,title,role}}）；
//   未配则用下面的内置名单（与企微账号一致）。
// ─────────────────────────────────────────────────────────────────────────────
const GROUP_LABELS = Object.freeze({ copy: '文案', audio: '音频' });
const SCOPE_LABELS = Object.freeze({ schedule: '录制档期' });
const SCOPE_GROUPS = Object.freeze({ schedule: Object.freeze(['audio']) });
const DEFAULT_USERS = Object.freeze([
  // 文案 PM
  { account: 'ukongwang', name: '汪亚茜', group: 'copy', title: 'pm' },
  // 文案
  { account: 'archili', name: '李光源', group: 'copy' },
  { account: 'bojackgguan', name: '关学院', group: 'copy' },
  { account: 'hayden', name: 'HAYDEN PATRICK CAREY', group: 'copy' },
  { account: 'jiejwluo', name: '罗婧文', group: 'copy' },
  { account: 'julianxie', name: '谢佳洺', group: 'copy' },
  { account: 'julyyyhu', name: '胡瑞璋', group: 'copy' },
  { account: 'kaiyuanyang', name: '杨开元', group: 'copy' },
  { account: 'luxxchen', name: '陈晨', group: 'copy' },
  { account: 'rickiecai', name: '蔡曦锐', group: 'copy' },
  { account: 'tinozheng', name: '郑懿', group: 'copy' },
  { account: 'elliexiong', name: '熊雯玥', group: 'copy' },
  // 音频 PM（站点负责人，保留 admin 以执行同步 / 还原等维护动作）
  { account: 'lycheelli', name: '李想', group: 'audio', title: 'pm', role: 'admin' },
  // 音频
  { account: 'axuanzhang', name: '张娴', group: 'audio' },
  { account: 'azuzhu', name: '朱光祖', group: 'audio' },
  { account: 'chengzhenli', name: '李成桢', group: 'audio' },
  { account: 'cyntiajiang', name: '姜欣钰', group: 'audio' },
  { account: 'diyayang', name: '杨迪雅', group: 'audio' },
  { account: 'gretchenhou', name: '侯晓菲', group: 'audio' },
  { account: 'haibiaoli', name: '李海标', group: 'audio' },
  { account: 'lukexlwang', name: '王祥礼', group: 'audio' },
  { account: 'merlechen', name: '陈小荣', group: 'audio' },
  { account: 'scarletxia', name: '夏誉嘉', group: 'audio' },
  { account: 'shellymao', name: '毛润坤', group: 'audio' },
  { account: 'twinkyli', name: '李莹莹', group: 'audio' },
  { account: 'v_jnanmo', name: '莫江楠', group: 'audio' },
  { account: 'v_pzknpan', name: '潘梓宽', group: 'audio' },
  { account: 'veigarjiang', name: '姜彦成', group: 'audio' },
  { account: 'yumuchen', name: '陈骏枫', group: 'audio' },
]);

function normAccount(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

/**
 * 用户手输/粘贴的账号清洗（2026-09-17）：同事习惯从通讯录里复制「twinkyli(李莹莹)」
 * 或直接写中文名，这里统一归一成名单里的 key。
 *   'twinkyli(李莹莹)' / 'twinkyli (李莹莹)' / 'twinkyli@xxx.com' → 'twinkyli'
 *   '李莹莹' → '李莹莹'（交给 resolveIdentity 按中文名反查）
 * 取第一段连续 ASCII 账号串；全中文时原样返回（去空白）。
 */
function normalizeAccountInput(value) {
  let s = String(value == null ? '' : value).trim();
  if (!s) return '';
  const at = s.indexOf('@');
  if (at > 0) s = s.slice(0, at);
  const m = s.match(/[A-Za-z][A-Za-z0-9._-]*/);
  if (m) return m[0];
  return s.replace(/\s+/g, '');
}

function parseUsers() {
  const raw = String(process.env.VOMI_USERS_JSON || '').trim();
  let source = DEFAULT_USERS;
  if (raw) {
    try {
      source = JSON.parse(raw);
    } catch (_) {
      throw new Error('VOMI_USERS_JSON must be valid JSON');
    }
  }
  const rows = Array.isArray(source)
    ? source
    : Object.entries(source).map(([account, value]) => ({ account, ...(typeof value === 'string' ? { name: value } : value) }));
  const map = new Map();
  for (const row of rows) {
    const account = normAccount(row && row.account);
    if (!account) continue;
    if (!SUBJECT_PATTERN.test(account)) throw new Error(`Invalid user account: ${account}`);
    const group = String((row && row.group) || '').trim().toLowerCase();
    if (group !== 'copy' && group !== 'audio') throw new Error(`Unsupported user group: ${group}`);
    map.set(account, {
      account,
      subject: account,
      name: String((row && row.name) || account),
      // 可选：按账号单独发口令；留空则沿用全站共享的编辑口令
      key: String((row && row.key) || ''),
      group,
      title: String((row && row.title) || '').trim().toLowerCase() === 'pm' ? 'pm' : 'member',
      role: String((row && row.role) || '').trim().toLowerCase() === 'admin' ? 'admin' : 'editor',
    });
  }
  return map;
}

const USERS = parseUsers();

// 可选：VOMI_USER_KEYS_JSON='{"archili":"...","ukongwang":"..."}' 给指定账号单独发口令。
// ⚠️ 目前默认是「共享编辑口令 + 自己填账号」，拿到口令的人可以填别人的账号冒充。
//    对内工具可接受；要收紧时给每人发独立口令即可，无需改代码。
const USER_KEYS = new Map();
(() => {
  const raw = String(process.env.VOMI_USER_KEYS_JSON || '').trim();
  if (!raw) return;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    throw new Error('VOMI_USER_KEYS_JSON must be valid JSON');
  }
  for (const [account, key] of Object.entries(parsed || {})) {
    const name = normAccount(account);
    const value = String(key || '');
    if (name && value) USER_KEYS.set(name, value);
  }
})();

// 口令即身份（2026-09-16）：站点拿不到企微登录态（IP + 裸 HTTP，做不了 OAuth，也读不到
// 浏览器里的企微身份），所以退一步——给每个人派生一把专属口令，输口令即等于报身份，
// 既不用手填账号，也无法冒充别人。只要 master 口令不泄露，外人推不出别人的口令。
// 开启方式：CVM .env 里 VOMI_PER_ACCOUNT_KEYS=true（配合强 VOMI_OWNER_KEY）。
const PER_ACCOUNT_KEYS = String(process.env.VOMI_PER_ACCOUNT_KEYS || '').toLowerCase() === 'true';

// 2026-09-17 PM 拍板：**名单即授权** —— 解锁只要填企业微信账号，命中权限名单就按
// 职能组签发令牌，不必再输口令（内网工具，账号本身就是凭证）。
// 需要口令的场合（对外分享 / 更严场景）在 CVM .env 设 VOMI_UNLOCK_KEY，或开启
// VOMI_PER_ACCOUNT_KEYS 走每人专属口令，届时解锁接口会重新要求口令。
const UNLOCK_REQUIRES_KEY =
  String(process.env.VOMI_UNLOCK_KEY || '').trim() !== '' || PER_ACCOUNT_KEYS;

// 2026-09-17 PM：名单内的人**填一次账号就永久记住**，不做 30 天过期——解锁令牌按
// 100 年有效期签发（等同永久；仍保留 exp 字段以兼容前端过期校验）。移出名单才是
// 真正的"踢出"手段（名单即真源，旧令牌立刻降级）。
const IDENTITY_TOKEN_TTL_MS = 100 * 365.25 * 24 * 3600 * 1000;

function deriveAccountKey(account) {
  return b64url(
    crypto.createHmac('sha256', OWNER_KEY).update(`vomi-acct:${normAccount(account)}`).digest()
  ).slice(0, 16);
}

/** 该账号的口令：① 名单/环境变量显式配的 ② 开启后按 master 口令派生 ③ '' = 走共享口令。 */
function accountKeyFor(account) {
  const user = USERS.get(normAccount(account));
  const explicit = (user && user.key) || USER_KEYS.get(normAccount(account)) || '';
  if (explicit) return explicit;
  return PER_ACCOUNT_KEYS ? deriveAccountKey(account) : '';
}

/** 口令 → 账号反查（免填账号解锁）。要求全局唯一命中，撞口令一律拒绝。 */
function accountForKey(key) {
  const given = String(key || '');
  if (!given) return null;
  let hit = null;
  for (const user of USERS.values()) {
    const expected = accountKeyFor(user.account);
    if (!expected || !safeEqual(given, expected)) continue;
    if (hit) return null;
    hit = user.account;
  }
  return hit;
}

/** 解锁校验：账号有专属口令就只认专属口令，否则认共享编辑口令。 */
function checkAccountKey(account, key) {
  const perAccount = accountKeyFor(account);
  if (perAccount) return safeEqual(String(key || ''), perAccount);
  return checkOwnerKey(key);
}

/** 企微账号 → 身份（{account,subject,name,group,title,role,key}），不在名单返回 null。 */
function resolveIdentity(account) {
  const cleaned = normalizeAccountInput(account);
  const direct = USERS.get(normAccount(cleaned));
  if (direct) return { ...direct };
  // 中文名反查：同事只记得名字时也能解锁。要求名单内唯一命中，重名一律拒绝。
  const target = normAccount(cleaned);
  if (!target || !/[\u4e00-\u9fff]/.test(target)) return null;
  let hit = null;
  for (const user of USERS.values()) {
    if (normAccount(user.name) !== target) continue;
    if (hit) return null;
    hit = user;
  }
  return hit ? { ...hit } : null;
}

/** 名单里的所有人（供 /api/auth/me 等只读用途）。 */
function listUsers() {
  return Array.from(USERS.values()).map((row) => ({ ...row }));
}

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

/**
 * 签发编辑令牌：`<base64url(payload)>.<hmac>`。
 * 2026-09-16：payload 带上 group / title / role，使后端能按职能组做 scope 鉴权。
 * 名单外的 subject 只给 editor 且不带组（等价于「能写但受域限制」）。
 */
function issueOwnerToken(subject = OWNER_SUBJECT, ttlMs = OWNER_SESSION_TTL_MS) {
  const identity = resolveIdentity(subject);
  const now = Date.now();
  const payload = identity
    ? {
        sub: identity.account,
        name: identity.name,
        group: identity.group,
        title: identity.title,
        role: identity.role,
        iat: now,
        exp: now + ttlMs,
      }
    : { sub: String(subject), name: String(subject), group: '', title: 'member', role: 'editor', iat: now, exp: now + ttlMs };
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  return `${body}.${signPayload(body)}`;
}

/**
 * 校验编辑令牌，通过返回身份对象 {subject,name,group,title,role}，否则 null。
 * 名单是权限真源：账号被移出名单后，旧令牌里的 group/role 不再生效。
 */
function verifySessionToken(token) {
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
    const identity = resolveIdentity(payload.sub);
    if (identity) return identity;
    // 名单外的主体：只认 payload 自带的最小权限（默认 editor，无组）
    const role = ROLE_LEVEL[String(payload.role)] ? String(payload.role) : 'editor';
    return {
      account: String(payload.sub),
      subject: String(payload.sub),
      name: String(payload.name || payload.sub),
      group: '',
      title: 'member',
      role,
    };
  } catch (_) {
    return null;
  }
}

/** 校验编辑令牌，通过返回 subject，否则 null（旧签名保留，内部转调 verifySessionToken）。 */
function verifyOwnerToken(token) {
  const identity = verifySessionToken(token);
  return identity ? identity.subject : null;
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

  // 2) 已解锁的成员：X-Vomi-Editor 带有效 HMAC 令牌 → 按名单解析出 role + 职能组。
  const session = verifySessionToken(req.headers['x-vomi-editor']);
  if (session) {
    req.auth = { ...session, via: 'owner-session' };
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
  // 2026-09-16 PM 拍板：删除不再是特权（admin-only 会让文案 / 音频都删不动），
  // 降为 editor，由前端统一弹二次确认兜底。
  return requireRole('editor')(req, res, next);
}

/** 当前身份能否写某个资源域；无 group（回环作业 / 服务端令牌）或 admin 一律放行。 */
function hasScope(req, scope) {
  const allowed = SCOPE_GROUPS[scope];
  if (!allowed) return true;
  const auth = (req && req.auth) || {};
  if (auth.role === 'admin') return true;
  if (!auth.group) return true;
  return allowed.includes(auth.group);
}

/** 资源域写权限中间件：例 requireScope('schedule') → 仅音频组可改档期。 */
function requireScope(scope) {
  const allowed = SCOPE_GROUPS[scope];
  if (!allowed) throw new Error(`Unsupported scope: ${scope}`);
  return (req, res, next) => {
    if (hasScope(req, scope)) return next();
    const groups = allowed.map((g) => GROUP_LABELS[g] || g).join(' / ');
    res.setHeader('X-Vomi-Apply-To', OWNER_SUBJECT);
    return res.status(403).json({
      ok: false,
      error: 'scope_forbidden',
      scope,
      required_group: allowed.slice(),
      message: `「${SCOPE_LABELS[scope] || scope}」只有 ${groups} 组可以修改，请找 ${OWNER_SUBJECT} 申请`,
    });
  };
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
  accountForKey,
  accountKeyFor,
  checkAccountKey,
  deriveAccountKey,
  checkOwnerKey,
  corsGuard,
  hasScope,
  issueOwnerToken,
  listUsers,
  methodRbac,
  normalizeAccountInput,
  OWNER_SUBJECT,
  DENY_MESSAGE,
  GROUP_LABELS,
  SCOPE_GROUPS,
  SCOPE_LABELS,
  positiveInt,
  publicError,
  rateLimit,
  requireRole,
  requireScope,
  resolveIdentity,
  secureHeaders,
  UNLOCK_REQUIRES_KEY,
  IDENTITY_TOKEN_TTL_MS,
  verifyOwnerToken,
  verifySessionToken,
};
