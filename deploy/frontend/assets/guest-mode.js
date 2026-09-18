'use strict';
/**
 * Vomi 访问模式 · 进站登录门禁
 * ------------------------------------------------------------------
 * 2026-09-18 PM 拍板：**打开网站必须先登录** —— 输入企业微信账号，命中权限名单
 * 才进得去；没登录连业务数据都读不到（后端 /api 一律 401 login_required），
 * 也就不再有「匿名只读浏览」这个中间态，那条黄色横幅随之取消。
 * 登录一次记住六个自然月：同地址同浏览器再打开直接进入；换人/退出用 __vomiLogout()。
 *
 * 身份 = 职能组（2026-09-16）：后端按名单签发带 group（copy 文案 / audio 音频）的令牌。
 *   · 文案组：除「录制档期」外都能编辑
 *   · 音频组：全部页面都能编辑
 *   · 删除不设特权，但前端统一二次确认
 *
 * 名单即授权（2026-09-17）：只填企微账号，不必输口令
 * （账号容错：'twinkyli(李莹莹)' / 'twinkyli@xx' / '李莹莹' 都能认）。
 * 需要口令的场合由后端 VOMI_UNLOCK_KEY / VOMI_PER_ACCOUNT_KEYS 开启，此时前端
 * 才把口令框显示出来。
 *
 * 三层保护（缺一层都能被绕过，所以都留着）：
 *   1) 前端门禁：未登录直接铺满登录层，没有取消 / 点遮罩关闭 / Esc 关闭的出口；
 *      接口返回 401 login_required 时清掉本地身份并重新要求登录。
 *   2) 前端拦截：只读态下 fetch / XHR 的 POST·PUT·PATCH·DELETE 直接返回 403 假响应
 *      + toast，压根不发网络请求（避免写一半）。
 *   3) 后端门禁 + scope 鉴权：/api 除 health 与登录入口外一律 requireLogin（401）；
 *      X-Vomi-Editor 携带有效令牌才升为 editor/admin，并按 group 校验资源域。
 *
 * 只读分享：URL 带 ?role=guest（或 hash 里 role=guest）→ **已登录**的人能看，
 * 写请求被拦。没人登录时它同样要求登录（分享头本身不是身份）。
 * 兼容：仍导出 window.__VOMI_GUEST__（= 只读且由 guest 链接触发），老代码不用改。
 */
(function () {
  var TOKEN_KEY = 'vomi_owner_token_v1';
  var DENY_MSG = '请找 lycheelli 申请权限';
  var OWNER = 'lycheelli';
  var WRITE_METHODS = { POST: 1, PUT: 1, PATCH: 1, DELETE: 1 };
  // 与 deploy/backend/src/security.js 的 SCOPE_GROUPS / GROUP_LABELS 保持一致
  var GROUP_LABELS = { copy: '文案', audio: '音频' };
  var SCOPE_GROUPS = { schedule: ['audio'] };
  // 登录后自动弹出的「身份操作指引」（2026-09-18）：站内全屏层内嵌，不用 window.open ——
  // 登录成功后前端会 reload，reload 之后的新窗口属于非用户手势，几乎必被浏览器拦截。
  var GUIDE_PAGE = 'Vomi-身份操作指引-C版-高音谱号.html';
  var GUIDE_VER = '20260918f';   // 指引页内容更新时 bump，强制丢弃 iframe 缓存
  var GUIDE_SEEN_KEY = 'vomi_guide_seen_v1';
  // 2026-09-18 全员强制重新登录：这个戳一改，本地旧身份立刻作废，必须重走门禁。
  // 后端另有 VOMI_TOKEN_EPOCH 令牌世代兜底（旧令牌一律判无效），这里是前端这一侧，
  // 让人一打开就重新登录，而不是等第一次接口 401 才弹窗。
  var RELOGIN_KEY = 'vomi_relogin_stamp_v1';
  var RELOGIN_STAMP = '20260918';
  function forceReloginOnce() {
    try {
      if (localStorage.getItem(RELOGIN_KEY) === RELOGIN_STAMP) return;
      localStorage.removeItem(TOKEN_KEY);
      localStorage.setItem(RELOGIN_KEY, RELOGIN_STAMP);
    } catch (_) {}
  }

  // ---------- 身份判定 ----------
  var TOKEN_PAYLOAD = null;
  function identityExpiresAt(issuedAt) {
    var start = new Date(issuedAt);
    var end = new Date(issuedAt);
    var day = start.getUTCDate();
    end.setUTCDate(1);
    end.setUTCMonth(end.getUTCMonth() + 6);
    var lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
    end.setUTCDate(Math.min(day, lastDay));
    return end.getTime();
  }
  function readToken() {
    try {
      var raw = localStorage.getItem(TOKEN_KEY) || '';
      if (!raw) return '';
      var body = raw.split('.')[0] || '';
      var json = JSON.parse(decodeB64(body));
      // 与后端同口径：从原始登录时刻起六个自然月，不因访问滚动续期。
      if (!json || !json.sub || !Number.isFinite(json.iat) || !Number.isFinite(json.exp)) return '';
      if (json.iat > Date.now() || Math.min(json.exp, identityExpiresAt(json.iat)) <= Date.now()) {
        localStorage.removeItem(TOKEN_KEY);
        return '';
      }
      TOKEN_PAYLOAD = json;
      return raw;
    } catch (_) {
      return '';
    }
  }
  function decodeB64(s) {
    var b = s.replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    return decodeURIComponent(
      atob(b).split('').map(function (c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
      }).join('')
    );
  }
  function forcedGuest() {
    try {
      var url = new URL(window.location.href);
      if ((url.searchParams.get('role') || '').toLowerCase() === 'guest') return true;
      if (/[?&]role=guest\b/i.test(url.hash || '')) return true;
      // 2026-09-18 PM 拍板：只要输入过企微账号（localStorage 里有有效令牌），
      // 同一标签页继续浏览普通链接就不再按访客渲染 —— 之前点开过 ?role=guest
      // 分享链接会在 sessionStorage 留下 vomi_guest_mode=1，把已解锁的人压回只读。
      if (readToken()) return false;
      if (sessionStorage.getItem('vomi_guest_mode') === '1') return true;
    } catch (_) {}
    return false;
  }

  forceReloginOnce();
  var REMEMBERED_TOKEN = readToken();
  var FORCED_GUEST = forcedGuest();
  // 2026-09-18：进站必须登录。身份（REMEMBERED_TOKEN）与写态（READONLY）分开：
  //   未登录         → 自动弹登录层；请求不带身份，后端业务接口一律 401 login_required
  //   已登录         → 正常读写（仍按职能组 scope 限制）
  //   已登录 + guest → 能看，写请求被拦（对外分享链接）
  var SIGNED_IN = !!REMEMBERED_TOKEN;
  var TOKEN = REMEMBERED_TOKEN;
  var READONLY = FORCED_GUEST || !SIGNED_IN;
  window.__VOMI_READONLY__ = READONLY;
  window.__VOMI_GUEST__ = READONLY && FORCED_GUEST;
  window.__VOMI_OWNER__ = !READONLY;
  window.__vomiOwnerToken = TOKEN;

  // ---------- 职能组身份（供页面判断「我能不能改这块」） ----------
  // 令牌 payload 直接带 group / title / role，无需额外请求；admin 与无组身份一律放行。
  var IDENTITY = null;
  if (TOKEN && TOKEN_PAYLOAD) {
    var p = TOKEN_PAYLOAD;
    IDENTITY = {
      subject: String(p.sub || ''),
      name: String(p.name || p.sub || ''),
      group: String(p.group || ''),
      groupLabel: GROUP_LABELS[String(p.group || '')] || '',
      title: String(p.title || '') === 'pm' ? 'pm' : 'member',
      role: String(p.role || 'editor')
    };
  }
  window.__VOMI_IDENTITY__ = IDENTITY;
  window.__VOMI_CAN__ = function (scope) {
    if (!IDENTITY || READONLY) return false;
    if (IDENTITY.role === 'admin') return true;
    var allowed = SCOPE_GROUPS[scope];
    if (!allowed) return true;
    if (!IDENTITY.group) return true;
    return allowed.indexOf(IDENTITY.group) >= 0;
  };
  window.__vomiLogout = function () {
    try { localStorage.removeItem(TOKEN_KEY); } catch (_) {}
    try { window.location.reload(); } catch (_) {}
  };

  if (FORCED_GUEST) {
    try { sessionStorage.setItem('vomi_guest_mode', '1'); } catch (_) {}
  }

  var IN_FRAME = false;
  try { IN_FRAME = window.top !== window.self; } catch (_) { IN_FRAME = false; }

  // ---------- toast ----------
  var toastTimer = 0;
  function toast(msg) {
    try {
      var host = document.body || document.documentElement;
      if (!host) return;
      var t = document.getElementById('vomi-guest-toast');
      if (!t) {
        t = document.createElement('div');
        t.id = 'vomi-guest-toast';
        t.style.cssText = 'position:fixed;bottom:32px;left:50%;transform:translateX(-50%);z-index:99999;background:rgba(20,30,36,.96);color:#FFD24C;padding:10px 20px;font:600 12px/1.4 "Microsoft YaHei UI","PingFang SC",sans-serif;letter-spacing:.3px;border:1px solid rgba(255,210,76,.5);box-shadow:0 8px 24px rgba(0,0,0,.55);clip-path:polygon(6px 0,100% 0,100% calc(100% - 6px),calc(100% - 6px) 100%,0 100%,0 6px);pointer-events:none;opacity:0;transition:opacity .18s;max-width:80vw;text-align:center';
        host.appendChild(t);
      }
      t.textContent = msg;
      t.style.opacity = '1';
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { t.style.opacity = '0'; }, 2600);
    } catch (_) {}
  }
  window.__vomiGuestToast = toast;

  // ---------- 账号输入容错（2026-09-17）----------
  // 同事习惯从通讯录复制「twinkyli(李莹莹)」或直接写中文名：这里归一成名单里的英文账号；
  // 全中文时原样交给后端按姓名反查（名单内唯一命中才认）。
  function cleanAccount(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return '';
    var at = s.indexOf('@');
    if (at > 0) s = s.slice(0, at);
    var m = s.match(/[A-Za-z][A-Za-z0-9._-]*/);
    if (m) return m[0];
    return s.replace(/\s+/g, '');
  }

  // ---------- 登录弹层（2026-09-18：进站必须登录，没有取消/关闭出口）----------
  function openUnlock(hint) {
    if (document.getElementById('vomi-unlock-mask')) return;
    var mask = document.createElement('div');
    mask.id = 'vomi-unlock-mask';
    mask.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(6,10,13,.94);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center';
    mask.innerHTML =
      '<div style="width:min(380px,92vw);background:#0F171C;border:1px solid rgba(15,247,150,.35);box-shadow:0 18px 48px rgba(0,0,0,.6);clip-path:polygon(10px 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%,0 10px);padding:20px 22px;font:400 13px/1.6 \'Microsoft YaHei UI\',\'PingFang SC\',sans-serif;color:#D3DFDD">' +
        '<style>#vomi-unlock-account::placeholder{color:#5F7078;font-size:12px;letter-spacing:.3px}</style>' +
        '<div style="font:700 13px/1.4 inherit;color:#0FF796;letter-spacing:.4px;margin-bottom:10px">登录 Vomi</div>' +
        '<div style="color:#8FA0A8;font-size:12px;margin-bottom:12px">' +
          (hint ? hint : '输入企业微信账号') +
        '</div>' +
        '<input id="vomi-unlock-account" type="text" placeholder="Vomi（温米）" autocomplete="off" autocapitalize="off" spellcheck="false" ' +
          'style="width:100%;box-sizing:border-box;background:#0A1015;border:1px solid rgba(255,255,255,.14);color:#E9E6DF;padding:9px 11px;font:400 13px inherit;outline:none;clip-path:polygon(5px 0,100% 0,100% calc(100% - 5px),calc(100% - 5px) 100%,0 100%,0 5px)">' +
        '<input id="vomi-unlock-input" type="password" placeholder="编辑口令" autocomplete="off" ' +
          'style="display:none;width:100%;box-sizing:border-box;margin-top:8px;background:#0A1015;border:1px solid rgba(255,255,255,.14);color:#E9E6DF;padding:9px 11px;font:400 13px inherit;outline:none;clip-path:polygon(5px 0,100% 0,100% calc(100% - 5px),calc(100% - 5px) 100%,0 100%,0 5px)">' +
        // 2026-09-18 保密问题：只有不在权限名单里的账号才会看到这一块
        '<div id="vomi-unlock-q" style="display:none;color:#FFD24C;font-size:12px;margin-top:12px"></div>' +
        '<input id="vomi-unlock-answer" type="text" placeholder="答案" autocomplete="off" autocapitalize="off" spellcheck="false" ' +
          'style="display:none;width:100%;box-sizing:border-box;margin-top:8px;background:#0A1015;border:1px solid rgba(255,210,76,.4);color:#E9E6DF;padding:9px 11px;font:400 13px inherit;outline:none;clip-path:polygon(5px 0,100% 0,100% calc(100% - 5px),calc(100% - 5px) 100%,0 100%,0 5px)">' +
        '<div id="vomi-unlock-err" style="color:#D699BE;font-size:12px;min-height:18px;margin-top:8px"></div>' +
        '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:4px">' +
          '<button type="button" id="vomi-unlock-ok" style="background:#0FF796;border:none;color:#0A1015;padding:6px 16px;font:700 12px inherit;cursor:pointer;clip-path:polygon(4px 0,100% 0,100% calc(100% - 4px),calc(100% - 4px) 100%,0 100%,0 4px)">登录</button>' +
        '</div>' +
      '</div>';
    (document.body || document.documentElement).appendChild(mask);

    var accountInput = document.getElementById('vomi-unlock-account');
    var input = document.getElementById('vomi-unlock-input');
    var qBox = document.getElementById('vomi-unlock-q');
    var answerInput = document.getElementById('vomi-unlock-answer');
    var err = document.getElementById('vomi-unlock-err');
    function close() { mask.remove(); }
    // 登录层不可取消：点遮罩、按 Esc 都不关，必须登录或关掉页面。
    [accountInput, input, answerInput].forEach(function (el) {
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') submit();
      });
    });
    function submit() {
      var account = cleanAccount(accountInput.value);
      var key = String(input.value || '').trim();
      var answer = String(answerInput.value || '').trim();
      // 名单即授权：只填账号就能解锁；口令框默认隐藏，只有后端要求时才出现。
      if (!account) { err.textContent = '请输入企业微信账号'; accountInput.focus(); return; }
      err.textContent = '校验中…';
      var req = (window.__vomiRawFetch || window.fetch).call(window, '/api/session/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: account, key: key, answer: answer })
      });
      Promise.resolve(req).then(function (r) { return r.json(); }).then(function (j) {
        if (j && j.ok && j.token) {
          try { localStorage.setItem(TOKEN_KEY, j.token); }
          catch (_) { err.textContent = '浏览器无法保存登录状态，请允许网站存储后重试'; return; }
          try { sessionStorage.removeItem('vomi_guest_mode'); } catch (_) {}
          close();
          // 用户主动解锁后退出当前分享预览，不让 role=guest 再次压回只读。
          try {
            var target = new URL(window.location.href);
            target.searchParams.delete('role');
            target.hash = target.hash.replace(/([?&])role=guest\b&?/ig, function (all, sep) { return /&$/.test(all) ? sep : ''; });
            if (target.href !== window.location.href) window.location.replace(target.href);
            else window.location.reload();
          } catch (_) { window.location.reload(); }
        } else {
          // 后端要求口令时（VOMI_UNLOCK_KEY / 专属口令模式）才把口令框显示出来
          if (j && (j.error === 'key_required' || j.error === 'bad_key')) {
            input.style.display = 'block';
            if (j.error === 'key_required') { err.textContent = ''; input.focus(); return; }
          }
          // 2026-09-18 保密问题：账号不在名单里 → 显示题目，答对才放行（只读）
          if (j && (j.error === 'question_required' || j.error === 'bad_answer')) {
            qBox.style.display = 'block';
            answerInput.style.display = 'block';
            if (j.question) qBox.textContent = '保密问题：' + j.question;
            if (j.error === 'question_required') { err.textContent = ''; answerInput.focus(); return; }
            err.textContent = (j && j.message) || '不足为外人道也~';
            answerInput.focus();
            return;
          }
          err.textContent = (j && j.message) || ('账号不在权限名单里，请找 ' + OWNER + ' 添加');
        }
      }).catch(function () {
        err.textContent = '无法连接服务，请稍后再试';
      });
    }
    document.getElementById('vomi-unlock-ok').onclick = submit;
    setTimeout(function () { try { accountInput.focus(); } catch (_) {} }, 30);
  }
  window.__vomiOpenUnlock = openUnlock;

  // ---------- 进站门禁（2026-09-18）：没登录就先登录，不看业务内容 ----------
  // iframe 子页不自己弹（父页已经挡住，避免叠两层）；已记住身份的人直接进入。
  function ensureLogin() {
    if (SIGNED_IN || IN_FRAME) return;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { openUnlock(); });
    } else {
      openUnlock();
    }
  }
  ensureLogin();

  // 同域其他标签页解锁/退出后同步当前页；相同 token 不重载，避免相互刷新。
  window.addEventListener('storage', function (e) {
    if (e.key === TOKEN_KEY && e.oldValue !== e.newValue) window.location.reload();
  });

  // ---------- 已解锁提示（每个标签页只提示一次）----------
  // 令牌存 localStorage，六个月内不重输账号；清理网站数据/主动退出除外。
  if (!READONLY && IDENTITY && !IN_FRAME) {
    var showUnlockHint = function () {
      try {
        if (sessionStorage.getItem('vomi_unlock_hint') === '1') return;
        sessionStorage.setItem('vomi_unlock_hint', '1');
      } catch (_) {}
      toast('已解锁 · ' + (IDENTITY.name || IDENTITY.subject) + ' · ' +
        (IDENTITY.groupLabel || '成员') + ' · 身份已记住，下次免登录');
    };
    // 延后一拍：等主页面渲染完再提示，避免被后续 DOM 重建清掉
    setTimeout(showUnlockHint, 900);
  }

  // ---------- 自动弹出「身份操作指引」（每个账号一次）----------
  // 口径（2026-09-18）：上线后每个账号第一次打开就弹一次，不要求「重新登录」——
  // 否则六个月免登录期内的存量成员永远不会看到。关掉即记 seen，之后不再自动弹。
  // 层里不加任何自加外壳/头部栏，iframe 直接铺满，用指引页自带的 × 关闭
  // （页面点 × 时 postMessage 通知这里收层）。
  function openGuide() {
    if (document.getElementById('vomi-guide-mask')) return;
    var mask = document.createElement('div');
    mask.id = 'vomi-guide-mask';
    mask.style.cssText = 'position:fixed;inset:0;z-index:100001;background:#0A1015';
    mask.innerHTML = '<iframe src="' + encodeURI(GUIDE_PAGE) + '?v=' + GUIDE_VER +
      '" style="position:absolute;inset:0;width:100%;height:100%;border:0;background:#0A1015" title="身份操作指引"></iframe>';
    (document.body || document.documentElement).appendChild(mask);

    function onMessage(e) { if (e && e.data === 'vomi-guide-close') dismiss(); }
    function onKey(e) { if (e.key === 'Escape') dismiss(); }
    function dismiss() {
      try { localStorage.setItem(GUIDE_SEEN_KEY, String((IDENTITY && IDENTITY.subject) || '')); } catch (_) {}
      window.removeEventListener('message', onMessage, false);
      document.removeEventListener('keydown', onKey);
      mask.remove();
    }
    window.addEventListener('message', onMessage, false);
    document.addEventListener('keydown', onKey);
  }
  window.__vomiOpenGuide = openGuide;

  function maybeShowGuide() {
    if (IN_FRAME || !IDENTITY || READONLY) return;
    var seen = '';
    try { seen = localStorage.getItem(GUIDE_SEEN_KEY) || ''; } catch (_) {}
    if (seen === IDENTITY.subject) return;
    // 延后一拍：等主页面渲染完再弹，避免被后续 DOM 重建清掉。
    setTimeout(openGuide, 600);
  }
  maybeShowGuide();

  // ---------- 写请求判定 ----------
  function isWrite(method) { return !!WRITE_METHODS[String(method || '').toUpperCase()]; }
  function denyResponse() {
    var body = JSON.stringify({ ok: false, error: 'readonly', message: DENY_MSG, apply_to: OWNER });
    try {
      return new Response(body, { status: 403, headers: { 'Content-Type': 'application/json', 'X-Vomi-Readonly': '1' } });
    } catch (_) {
      return { ok: false, status: 403, json: function () { return Promise.resolve(JSON.parse(body)); } };
    }
  }

  // ---------- 删除二次确认（2026-09-16 PM 拍板：删除不设特权，但要再问一次） ----------
  function describeTarget(input) {
    var url = '';
    try {
      if (typeof input === 'string') url = input;
      else if (input && input.url) url = String(input.url);
    } catch (_) {}
    if (!url) return '';
    var path = url;
    try { path = new URL(url, window.location.href).pathname; } catch (_) {}
    var tail = String(path).split('/').filter(Boolean).pop() || '';
    if (/^\d+$/.test(tail)) return 'ID ' + tail;
    return String(path);
  }
  function cancelResponse() {
    var body = JSON.stringify({ ok: false, cancelled: true, error: 'cancelled', message: '已取消删除' });
    try {
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json', 'X-Vomi-Cancelled': '1' } });
    } catch (_) {
      return { ok: true, status: 200, json: function () { return Promise.resolve(JSON.parse(body)); } };
    }
  }
  function confirmDelete(input) {
    var label = describeTarget(input);
    return window.confirm('确认删除？\n' + (label ? label + '\n' : '') + '删除后不可恢复。');
  }

  // 登录态失效（过期 / 被移出名单 / 换人）→ 清掉本地身份并重新要求登录。
  function handleUnauthorized(res) {
    try {
      res.clone().json().then(function (j) {
        if (!j || j.error !== 'login_required') return;
        try { localStorage.removeItem(TOKEN_KEY); } catch (_) {}
        openUnlock('登录已失效，请重新输入企业微信账号');
      }).catch(function () {});
    } catch (_) {}
    return res;
  }

  // ---------- fetch ----------
  var _fetch = window.fetch ? window.fetch.bind(window) : null;
  if (_fetch) {
    window.__vomiRawFetch = _fetch;
    window.fetch = function (input, init) {
      init = init || {};
      var method = init.method;
      if (!method && typeof input === 'object' && input && input.method) method = input.method;
      method = String(method || 'GET').toUpperCase();
      var headers = new Headers(init.headers || (typeof input === 'object' && input ? input.headers : undefined) || {});
      // 已登录就始终带身份头；只读态（未登录或分享链接）额外带 guest 头，
      // 后端据此降级为 viewer —— 未登录时没有身份头，业务接口直接 401。
      if (TOKEN) headers.set('X-Vomi-Editor', TOKEN);
      if (READONLY) {
        headers.set('X-Vomi-Role', 'guest');
        if (isWrite(method)) {
          toast(DENY_MSG);
          init.headers = headers;
          return Promise.resolve(denyResponse());
        }
      } else if (method === 'DELETE' && !headers.get('X-Vomi-Skip-Confirm') && !confirmDelete(input)) {
        toast('已取消删除');
        return Promise.resolve(cancelResponse());
      }
      headers.delete('X-Vomi-Skip-Confirm');
      init.headers = headers;
      return _fetch(input, init).then(function (res) {
        if (res && res.status === 401) return handleUnauthorized(res);
        if (res && res.status === 403) {
          // 后端现在会给出具体原因（权限不足 / 只有某组能改），优先展示它
          try {
            res.clone().json().then(function (j) {
              toast((j && j.message) || DENY_MSG);
            }).catch(function () { toast(DENY_MSG); });
          } catch (_) {
            toast(DENY_MSG);
          }
        }
        return res;
      });
    };
  }

  // 顶层页面验证已存身份并记一次到访；不把刷新/翻页算成重新登录。
  // 旧长效令牌以原 iat 收口六个月，不强迫当前成员再输入账号。
  if (TOKEN && !IN_FRAME && _fetch) {
    var resumeToken = TOKEN;
    _fetch('/api/session/resume', { method: 'POST', headers: { 'X-Vomi-Editor': resumeToken } })
      .then(function (r) {
        if (r.status === 401 || r.status === 403) {
          if (localStorage.getItem(TOKEN_KEY) === resumeToken) {
            localStorage.removeItem(TOKEN_KEY);
            window.location.reload();
          }
          return null;
        }
        if (!r.ok) throw new Error('resume_failed');
        return r.json();
      }).then(function (j) {
        if (!j || !j.ok || !j.token) return;
        if (localStorage.getItem(TOKEN_KEY) !== resumeToken) return;
        localStorage.setItem(TOKEN_KEY, j.token);
        TOKEN = j.token;
        REMEMBERED_TOKEN = j.token;
        window.__vomiOwnerToken = j.token;
        var payload = JSON.parse(decodeB64(j.token.split('.')[0]));
        if (IDENTITY && (IDENTITY.group !== payload.group || IDENTITY.role !== payload.role)) window.location.reload();
      }).catch(function () {
        // 临时网络/存储故障不清身份，但明确说明本次统计未完成。
        setTimeout(function () { toast('访问记录未入库，请稍后刷新重试'); }, 1200);
      });
  }

  // ---------- XHR（少量老代码兜底） ----------
  try {
    var XHRopen = XMLHttpRequest.prototype.open;
    var XHRsend = XMLHttpRequest.prototype.send;
    var XHRsetReq = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function (method) {
      this.__vomi_method = String(method || '').toUpperCase();
      return XHRopen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      try {
        if (TOKEN) XHRsetReq.call(this, 'X-Vomi-Editor', TOKEN);
        if (READONLY) XHRsetReq.call(this, 'X-Vomi-Role', 'guest');
      } catch (_) {}
      if (READONLY && isWrite(this.__vomi_method)) {
        toast(DENY_MSG);
        var self = this;
        setTimeout(function () {
          try {
            Object.defineProperty(self, 'readyState', { value: 4, configurable: true });
            Object.defineProperty(self, 'status', { value: 403, configurable: true });
            Object.defineProperty(self, 'responseText', { value: '{"ok":false,"error":"readonly","message":"' + DENY_MSG + '"}', configurable: true });
            Object.defineProperty(self, 'response', { value: self.responseText, configurable: true });
          } catch (_) {}
          if (typeof self.onreadystatechange === 'function') self.onreadystatechange();
          if (typeof self.onload === 'function') self.onload();
        }, 5);
        return;
      }
      return XHRsend.apply(this, arguments);
    };
  } catch (_) {}

  // ---------- iframe 传承（只读时给子页打 role=guest） ----------
  function tagIframes() {
    if (!READONLY) return;
    var list = document.querySelectorAll('iframe[src]');
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      var src = f.getAttribute('src') || '';
      if (!src || src.indexOf('data:') === 0 || src.indexOf('blob:') === 0 || src.indexOf('about:') === 0) continue;
      if (/([?&]role=guest\b)/i.test(src)) continue;
      try {
        var u = new URL(src, window.location.href);
        u.searchParams.set('role', 'guest');
        f.setAttribute('src', u.toString());
      } catch (_) {
        f.setAttribute('src', src + (src.indexOf('?') >= 0 ? '&' : '?') + 'role=guest');
      }
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tagIframes);
  } else {
    tagIframes();
  }
  try {
    new MutationObserver(function (muts) {
      var any = false;
      for (var i = 0; i < muts.length; i++) {
        var nodes = muts[i].addedNodes || [];
        for (var j = 0; j < nodes.length; j++) {
          if (nodes[j] && nodes[j].tagName === 'IFRAME') { any = true; break; }
        }
        if (any) break;
      }
      if (any) tagIframes();
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch (_) {}
})();
