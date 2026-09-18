'use strict';

const crypto = require('crypto');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const ALLOW_INSECURE_DEV = process.env.ALLOW_INSECURE_DEV === 'true';
const ROLE_LEVEL = Object.freeze({ viewer: 1, editor: 2, admin: 3 });

// 进站必须登录（2026-09-18 PM 拍板）：没登录业务接口一律 401；成员输入企微账号
// 后按 copy/audio 组获得权限，HMAC 令牌记住六个自然月，存 localStorage，每次请求带 X-Vomi-Editor。
// 身份是本站声明账号，不是企微 OAuth 身份认证；签名密钥由环境变量配置。
const OWNER_SUBJECT = 'lycheelli';
const DENY_MESSAGE = '请找 lycheelli 申请权限';
// 2026-09-18 PM 拍板：站点改为「进站必须登录」——没登录连业务数据都读不到，
// 不再有「匿名只读浏览」这一层（只读分享链接也只在登录后生效）。
const LOGIN_MESSAGE = '请先输入企业微信账号登录';
const DEFAULT_OWNER_KEY = 'vomi-owner-2026';
const OWNER_KEY = String(process.env.VOMI_OWNER_KEY || DEFAULT_OWNER_KEY);
const SESSION_SECRET = String(process.env.VOMI_SESSION_SECRET || OWNER_KEY || 'vomi-session-secret');
// 令牌世代：改一次这个值，所有已签发的令牌立刻失效（用于全员强制重新登录）。
// 2026-09-18 引入，配合「名单即授权 + 名单外答保密问题」新门禁。
const TOKEN_EPOCH = String(process.env.VOMI_TOKEN_EPOCH || '').trim() || '1';
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
//
// 2026-09-18 新增第三档 guest（只读查看者，PM 拍板）：
//   · 名单里的 guest 成员可以正常看全站，但没有任何写权限（role 强制 viewer）。
//   · 不在名单里的人走「保密问题」：答对才以访客身份只读进入，答错一律看不到数据。
// ─────────────────────────────────────────────────────────────────────────────
const GROUP_LABELS = Object.freeze({ copy: '文案', audio: '音频', guest: '访客' });
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
  // ── 2026-09-18 只读查看者（PM 提供名单）：能看全站，不能改任何数据 ──
  { account: 'kellyqing', name: '卿慧玲', group: 'guest' },
  { account: 'amandaszhu', name: '朱爽', group: 'guest' },
  { account: 'berniebao', name: '鲍点峰', group: 'guest' },
  { account: 'casszhou', name: '周方正', group: 'guest' },
  { account: 'chloejcguo', name: '郭俊辰', group: 'guest' },
  { account: 'evvafan', name: '范芮', group: 'guest' },
  { account: 'halechen', name: '陈灏', group: 'guest' },
  { account: 'jasonlqu', name: '曲亮', group: 'guest' },
  { account: 'jieruzhao', name: '赵杰儒', group: 'guest' },
  { account: 'kuanni', name: '倪宽', group: 'guest' },
  { account: 'licli', name: '厉长春', group: 'guest' },
  { account: 'marchliang', name: '梁旭之', group: 'guest' },
  { account: 'msun', name: '孙星', group: 'guest' },
  { account: 'phillwang', name: '王相霏', group: 'guest' },
  { account: 'scottxsong', name: '宋伯轩', group: 'guest' },
  { account: 'shookychang', name: '常笑竹', group: 'guest' },
  { account: 'shuxzhao', name: '赵树勋', group: 'guest' },
  { account: 'sinyuhuang', name: '黄新玉', group: 'guest' },
  { account: 'tomoriyuan', name: '袁嘉威', group: 'guest' },
  { account: 'v_zynizhang', name: '张晏宁', group: 'guest' },
  { account: 'wenali', name: '李卓纹', group: 'guest' },
  { account: 'yararen', name: '任颖杰', group: 'guest' },
  { account: 'yidingzhao', name: '赵一定', group: 'guest' },
  { account: 'yongyilin', name: '林咏仪', group: 'guest' },
  { account: 'yorkgao', name: '高楠', group: 'guest' },
  { account: 'yuhuhe', name: '和玉虎', group: 'guest' },
  { account: 'yuximao', name: '毛禹锡', group: 'guest' },
  { account: 'zanechang', name: '常泽', group: 'guest' },
  { account: 'zewenbu', name: '卜泽文', group: 'guest' },
  { account: 'zhengguoxu', name: '徐正国', group: 'guest' },
  { account: 'zimujia', name: '贾子木', group: 'guest' },
  { account: 'cisong', name: '宋词', group: 'guest' },
  { account: 'justinchow', name: 'JIAN YAO CHOW', group: 'guest' },
  { account: 'kathydong', name: '董雪婷', group: 'guest' },
  { account: 'v_pgypiao', name: '朴贵英', group: 'guest' },
  { account: 'v_pshopeng', name: '彭少豪', group: 'guest' },
  { account: 'kosmosun', name: '孙达', group: 'guest' },
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
    if (group !== 'copy' && group !== 'audio' && group !== 'guest') throw new Error(`Unsupported user group: ${group}`);
    // guest 组只能是只读查看者：即使名单里误写了 role，也强制压成 viewer。
    const role = group === 'guest'
      ? 'viewer'
      : String((row && row.role) || '').trim().toLowerCase() === 'admin' ? 'admin' : 'editor';
    map.set(account, {
      account,
      subject: account,
      name: String((row && row.name) || account),
      // 可选：按账号单独发口令；留空则沿用全站共享的编辑口令
      key: String((row && row.key) || ''),
      group,
      title: String((row && row.title) || '').trim().toLowerCase() === 'pm' ? 'pm' : 'member',
      role,
    });
  }
  return map;
}

const USERS = parseUsers();

// 可选：VOMI_USER_KEYS_JSON='{"archili":"...","ukongwang":"..."}' 给指定账号单独发口令。
// 当前默认只报账号，不做企微身份认证；账号可被冒用。需收紧时配置专属口令并开启校验。
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

// ─────────────────────────────────────────────────────────────────────────────
// 2026-09-18 保密问题（PM 拍板）：不在权限名单里的人，必须答对问题才能进站。
//   · 名单内：照旧只填企微账号，免答，按职能组签发令牌（可编辑 / 只读按名单）。
//   · 名单外且没配问题：维持原行为 —— 直接 403 拒绝，看不到任何数据。
//   · 名单外且配了问题：先返回题目；答对 → 以「访客」身份只读进入；答错 → 401 拒绝。
//   开启方式（CVM .env）：
//     VOMI_UNLOCK_QUESTION=PM的个人微信群，第一个字是什么？
//     VOMI_UNLOCK_ANSWER=也
//   答案改动后，之前发出的访客令牌会立刻失效（令牌里带答案指纹 vid）。
// ─────────────────────────────────────────────────────────────────────────────
const UNLOCK_QUESTION = String(process.env.VOMI_UNLOCK_QUESTION || '').trim();
const UNLOCK_ANSWER = String(process.env.VOMI_UNLOCK_ANSWER || '').trim();

/** 配了答案才出题（只有题目没有答案视为未开启，避免「人人可进」的空门禁）。 */
function unlockQuestion() {
  return UNLOCK_ANSWER ? UNLOCK_QUESTION : '';
}

/** 答案比对：去首尾空白、忽略大小写，其余严格相等。 */
function checkUnlockAnswer(value) {
  if (!UNLOCK_ANSWER) return false;
  const given = String(value == null ? '' : value).trim().toLowerCase();
  return safeEqual(given, UNLOCK_ANSWER.toLowerCase());
}

/** 答案指纹：写进访客令牌，改答案即踢掉所有旧访客令牌。 */
function answerFingerprint() {
  if (!UNLOCK_ANSWER) return '';
  return b64url(crypto.createHash('sha256').update(`vomi-answer:${UNLOCK_ANSWER}`).digest()).slice(0, 16);
}

// 2026-09-18 PM：从输入账号起记住六个自然月，翻页不会滚动续期；月末落到目标月末。
function identityExpiresAt(issuedAt) {
  const start = new Date(issuedAt);
  const end = new Date(issuedAt);
  const day = start.getUTCDate();
  end.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() + 6);
  const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  end.setUTCDate(Math.min(day, lastDay));
  return end.getTime();
}

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
 * 浏览器令牌验证时必须仍命中名单；服务端 Bearer 凭据不走此令牌路径。
 */
function issueOwnerToken(subject = OWNER_SUBJECT, ttlMs, issuedAt = Date.now()) {
  const identity = resolveIdentity(subject);
  const now = issuedAt;
  const expiresAt = ttlMs === undefined ? identityExpiresAt(now) : now + ttlMs;
  const payload = identity
    ? {
        sub: identity.account,
        name: identity.name,
        group: identity.group,
        title: identity.title,
        role: identity.role,
        ep: TOKEN_EPOCH,
        iat: now,
        exp: expiresAt,
      }
    : {
        sub: String(subject),
        name: String(subject),
        group: '',
        title: 'member',
        role: 'editor',
        ep: TOKEN_EPOCH,
        iat: now,
        exp: expiresAt,
      };
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  return `${body}.${signPayload(body)}`;
}

/**
 * 签发「访客只读令牌」（2026-09-18 保密问题路径）：不在名单里、但答对问题的人。
 *   · group=guest / role=viewer —— 全站可读，任何写请求都被 requireRole('editor') 挡下。
 *   · vid = 答案指纹：改了答案，这批令牌立刻全部失效，不用等人走完有效期。
 *   · 有效期固定 7 天（名单内成员仍是六个月），泄露窗口更短。
 */
function issueGuestToken(account, issuedAt = Date.now()) {
  const now = issuedAt;
  const payload = {
    sub: normAccount(account),
    name: String(account || ''),
    group: 'guest',
    title: 'visitor',
    role: 'viewer',
    vid: answerFingerprint(),
    ep: TOKEN_EPOCH,
    iat: now,
    exp: now + 7 * 24 * 60 * 60 * 1000,
  };
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  return `${body}.${signPayload(body)}`;
}

/**
 * 校验编辑令牌，通过返回身份对象 {subject,name,group,title,role}，否则 null。
 * 名单是权限真源：账号被移出名单后，旧令牌里的 group/role 不再生效。
 * 例外：保密问题进来的访客（group=guest/role=viewer）不在名单里，靠 vid 指纹认。
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
    if (!payload || !payload.sub || !Number.isFinite(payload.exp) || !Number.isFinite(payload.iat)) return null;
    // 世代不符 = 已被管理员强制下线：令牌虽然还在有效期内、签名也没问题，
    // 但只要 ep 与当前世代不同就一律作废，持有人必须重新走一遍登录门禁
    // （名单内输企微账号直接进，名单外答保密问题）。这是「全员强制重登」的开关。
    if (String(payload.ep || '1') !== TOKEN_EPOCH) return null;
    const now = Date.now();
    const expiresAt = Math.min(payload.exp, identityExpiresAt(payload.iat));
    if (payload.iat > now || expiresAt <= now) return null;
    const identity = resolveIdentity(payload.sub);
    if (identity) return { ...identity, issuedAt: payload.iat, expiresAt };
    // 浏览器身份必须仍在名单内；不能让已移出者回退成无组 editor。
    // 服务端 Bearer 令牌 / 回环作业仍走 apiAuth 独立分支，不受此处影响。
    // 例外：保密问题进来的访客 —— group 必须是 guest、role 必须是 viewer，
    // 且 vid 与当前答案指纹一致（答案一改，旧访客令牌立即作废）。
    const fp = answerFingerprint();
    if (fp && payload.group === 'guest' && payload.role === 'viewer' && safeEqual(String(payload.vid || ''), fp)) {
      return {
        subject: payload.sub,
        account: payload.sub,
        name: String(payload.name || payload.sub),
        group: 'guest',
        title: 'visitor',
        role: 'viewer',
        issuedAt: payload.iat,
        expiresAt,
      };
    }
    return null;
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
  // ★ 2026-09-14 权限收口（PM 拍板）：默认只读；2026-09-18 升级为**进站必须登录**。
  //   优先级：已登录浏览器令牌 → 服务端 Bearer 令牌 → 本机回环 → 分享只读头 → 匿名。
  //   1) 已登录成员：X-Vomi-Editor 带有效 HMAC 令牌 → 按名单解析出 role + 职能组。
  //      同时带 X-Vomi-Role: guest（已登录的人打开只读分享链接）时降级为 viewer，
  //      但身份必须保留，否则会被当成匿名、连数据都读不到，也记不到到访。
  const session = verifySessionToken(req.headers['x-vomi-editor']);
  if (session) {
    const isGuestView = String(req.headers['x-vomi-role'] || '').toLowerCase() === 'guest';
    req.auth = isGuestView
      ? { ...session, role: 'viewer', via: 'owner-session', guest: true }
      : { ...session, via: 'owner-session' };
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

  // 3) 容器内回环调用（定时任务 / 冒烟脚本）维持 admin，避免现有内部作业被误伤。
  if (isLoopbackRequest(req)) {
    req.auth = { subject: 'loopback', role: 'admin', via: 'loopback' };
    return next();
  }

  // 4) 只读分享头（X-Vomi-Role: guest）本身不是身份：没人登录时它依然是匿名。
  const guestHeader = String(req.headers['x-vomi-role'] || '').toLowerCase();
  if (guestHeader === 'guest') {
    req.auth = { subject: 'guest', role: 'viewer', via: 'guest-header' };
    return next();
  }

  // 5) 其余一律匿名：登录门禁会挡在 methodRbac 之前，业务数据一律 401 login_required。
  req.auth = { subject: 'visitor', role: 'viewer', via: 'default' };
  return next();
}

/** 请求是否带真实身份（已登录成员 / 服务端凭据 / 容器内部作业）。 */
function isAuthenticated(req) {
  const auth = req && req.auth;
  if (!auth) return false;
  return auth.via === 'owner-session' || auth.via === 'token' || auth.via === 'loopback';
}

/**
 * 进站登录门禁（2026-09-18）：业务接口一律要求登录态；health 与登录入口本身必须放行。
 * 前端同样会在未登录时直接弹登录层，这里只是第二层——防止绕过 JS 直接拉数据。
 */
function requireLogin(req, res, next) {
  if (isAuthenticated(req)) return next();
  res.setHeader('X-Vomi-Login-Required', '1');
  res.setHeader('X-Vomi-Apply-To', OWNER_SUBJECT);
  return res.status(401).json({
    ok: false,
    error: 'login_required',
    message: LOGIN_MESSAGE,
  });
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
  issueGuestToken,
  unlockQuestion,
  checkUnlockAnswer,
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
  requireLogin,
  requireRole,
  requireScope,
  resolveIdentity,
  secureHeaders,
  TOKEN_EPOCH,
  UNLOCK_REQUIRES_KEY,
  identityExpiresAt,
  verifyOwnerToken,
  verifySessionToken,
};
