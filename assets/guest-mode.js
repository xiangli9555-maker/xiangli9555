'use strict';
/**
 * Vomi 访问模式 · 默认只读 / 成员解锁
 * ------------------------------------------------------------------
 * 2026-09-14 PM 拍板：站点默认对所有人「只读浏览」——可以看、可以点、可以试填，
 * 但任何写请求都不会落库，并提示「请找 lycheelli 申请权限」。
 *
 * 2026-09-16 升级为职能组鉴权：解锁填企业微信账号，后端按名单签发带 group
 * （copy 文案 / audio 音频）的令牌。
 *   · 文案组：除「录制档期」外都能编辑
 *   · 音频组：全部页面都能编辑
 *   · 删除不设特权，但前端统一二次确认
 *
 * 2026-09-17 简化为**名单即授权**：只填企微账号，命中名单即解锁，不必输口令
 * （账号容错：'twinkyli(李莹莹)' / 'twinkyli@xx' / '李莹莹' 都能认）。
 * 需要口令的场合由后端 VOMI_UNLOCK_KEY / VOMI_PER_ACCOUNT_KEYS 开启，此时前端
 * 才把口令框显示出来。
 *
 * 三层保护（缺一层都能被绕过，所以都留着）：
 *   1) 前端拦截：fetch / XHR 的 POST·PUT·PATCH·DELETE 直接返回 403 假响应 + toast，
 *      压根不发网络请求（避免写一半）。
 *   2) 请求头标记：只读态每个请求带 X-Vomi-Role: guest，后端 apiAuth 降为 viewer，
 *      就算有人绕过 JS（控制台里 fetch / curl）写接口也会被 methodRbac 拒 403。
 *   3) 后端默认 viewer + scope 鉴权：security.js 里无凭据请求一律 viewer；
 *      X-Vomi-Editor 携带有效令牌才升为 editor/admin，并按 group 校验资源域。
 *
 * 解锁：顶部横幅「申请编辑权限」→ 输入企微账号 → POST /api/session/unlock
 *       → 返回 token 存 localStorage（长期有效）→ 之后所有请求带 X-Vomi-Editor。
 *       同一台电脑同一浏览器再打开不用重输（名单内填一次永久记住）；换人/退出用 __vomiLogout()。
 * 强制只读分享：URL 带 ?role=guest（或 hash 里 role=guest）→ 即使已解锁也按只读渲染。
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

  // ---------- 身份判定 ----------
  var TOKEN_PAYLOAD = null;
  function readToken() {
    try {
      var raw = localStorage.getItem(TOKEN_KEY) || '';
      if (!raw) return '';
      var body = raw.split('.')[0] || '';
      var json = JSON.parse(decodeB64(body));
      // 2026-09-17 起令牌长期有效（名单即授权，填一次永久记住）；旧 30 天令牌过期照样清。
      if (!json || !json.sub) return '';
      if (json.exp && Number(json.exp) < Date.now()) {
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
      if (sessionStorage.getItem('vomi_guest_mode') === '1') return true;
    } catch (_) {}
    return false;
  }

  var FORCED_GUEST = forcedGuest();
  var TOKEN = FORCED_GUEST ? '' : readToken();
  var READONLY = !TOKEN;
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
    if (!IDENTITY) return false;
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

  // ---------- 顶部横幅（只在顶层窗口渲染，避免每个 iframe 叠一条） ----------
  function installBanner() {
    if (!READONLY || IN_FRAME) return;
    if (document.getElementById('vomi-guest-banner')) return;
    var bar = document.createElement('div');
    bar.id = 'vomi-guest-banner';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99998;background:#FFD24C;color:#0A1015;padding:7px 16px;font:600 12px/1.4 "Microsoft YaHei UI","PingFang SC",sans-serif;letter-spacing:.3px;display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;box-shadow:0 2px 10px rgba(0,0,0,.45);border-bottom:1px solid rgba(10,16,21,.35)';
    bar.innerHTML =
      '<span style="font-family:\'JetBrains Mono\',monospace;font-weight:700;letter-spacing:.6px;background:#0A1015;color:#FFD24C;padding:2px 7px">' +
      (FORCED_GUEST ? '[PREVIEW]' : '[只读]') + '</span>' +
      '<span>浏览模式 · 你可以查看和试填，但改动不会保存 · 需要编辑权限请联系 <b>' + OWNER + '</b></span>' +
      '<button type="button" id="vomi-unlock-btn" style="background:#0A1015;border:1px solid rgba(10,16,21,.55);color:#FFD24C;padding:3px 12px;font:600 11px inherit;cursor:pointer;clip-path:polygon(4px 0,100% 0,100% calc(100% - 4px),calc(100% - 4px) 100%,0 100%,0 4px)">申请编辑权限</button>' +
      '<button type="button" id="vomi-guest-banner-close" title="收起（仅本次浏览）" aria-label="收起横幅" style="background:transparent;border:1px solid rgba(10,16,21,.55);color:#0A1015;padding:3px 10px;font:600 11px inherit;cursor:pointer;clip-path:polygon(4px 0,100% 0,100% calc(100% - 4px),calc(100% - 4px) 100%,0 100%,0 4px)">收起</button>';
    document.body.appendChild(bar);
    document.body.style.setProperty('padding-top', '32px', 'important');

    document.getElementById('vomi-guest-banner-close').onclick = function () {
      bar.style.display = 'none';
      document.body.style.paddingTop = '';
    };
    document.getElementById('vomi-unlock-btn').onclick = openUnlock;
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installBanner);
  } else {
    installBanner();
  }

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

  // ---------- 解锁 / 申请权限弹层 ----------
  function openUnlock() {
    if (document.getElementById('vomi-unlock-mask')) return;
    var mask = document.createElement('div');
    mask.id = 'vomi-unlock-mask';
    mask.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(6,10,13,.72);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center';
    mask.innerHTML =
      '<div style="width:min(380px,92vw);background:#0F171C;border:1px solid rgba(15,247,150,.35);box-shadow:0 18px 48px rgba(0,0,0,.6);clip-path:polygon(10px 0,100% 0,100% calc(100% - 10px),calc(100% - 10px) 100%,0 100%,0 10px);padding:20px 22px;font:400 13px/1.6 \'Microsoft YaHei UI\',\'PingFang SC\',sans-serif;color:#D3DFDD">' +
        '<style>#vomi-unlock-account::placeholder{color:#5F7078;font-size:12px;letter-spacing:.3px}</style>' +
        '<div style="font:700 13px/1.4 inherit;color:#0FF796;letter-spacing:.4px;margin-bottom:10px">编辑权限</div>' +
        '<div style="color:#8FA0A8;font-size:12px;margin-bottom:12px">输入企业微信账号</div>' +
        '<input id="vomi-unlock-account" type="text" placeholder="Vomi（温米）" autocomplete="off" autocapitalize="off" spellcheck="false" ' +
          'style="width:100%;box-sizing:border-box;background:#0A1015;border:1px solid rgba(255,255,255,.14);color:#E9E6DF;padding:9px 11px;font:400 13px inherit;outline:none;clip-path:polygon(5px 0,100% 0,100% calc(100% - 5px),calc(100% - 5px) 100%,0 100%,0 5px)">' +
        '<input id="vomi-unlock-input" type="password" placeholder="编辑口令" autocomplete="off" ' +
          'style="display:none;width:100%;box-sizing:border-box;margin-top:8px;background:#0A1015;border:1px solid rgba(255,255,255,.14);color:#E9E6DF;padding:9px 11px;font:400 13px inherit;outline:none;clip-path:polygon(5px 0,100% 0,100% calc(100% - 5px),calc(100% - 5px) 100%,0 100%,0 5px)">' +
        '<div id="vomi-unlock-err" style="color:#D699BE;font-size:12px;min-height:18px;margin-top:8px"></div>' +
        '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:4px">' +
          '<button type="button" id="vomi-unlock-cancel" style="background:transparent;border:1px solid rgba(255,255,255,.18);color:#8FA0A8;padding:6px 14px;font:600 12px inherit;cursor:pointer;clip-path:polygon(4px 0,100% 0,100% calc(100% - 4px),calc(100% - 4px) 100%,0 100%,0 4px)">取消</button>' +
          '<button type="button" id="vomi-unlock-ok" style="background:#0FF796;border:none;color:#0A1015;padding:6px 16px;font:700 12px inherit;cursor:pointer;clip-path:polygon(4px 0,100% 0,100% calc(100% - 4px),calc(100% - 4px) 100%,0 100%,0 4px)">解锁</button>' +
        '</div>' +
      '</div>';
    (document.body || document.documentElement).appendChild(mask);

    var accountInput = document.getElementById('vomi-unlock-account');
    var input = document.getElementById('vomi-unlock-input');
    var err = document.getElementById('vomi-unlock-err');
    function close() { mask.remove(); }
    document.getElementById('vomi-unlock-cancel').onclick = close;
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    [accountInput, input].forEach(function (el) {
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') submit();
        if (e.key === 'Escape') close();
      });
    });
    function submit() {
      var account = cleanAccount(accountInput.value);
      var key = String(input.value || '').trim();
      // 名单即授权：只填账号就能解锁；口令框默认隐藏，只有后端要求时才出现。
      if (!account) { err.textContent = '请输入企业微信账号'; accountInput.focus(); return; }
      err.textContent = '校验中…';
      var req = (window.__vomiRawFetch || window.fetch).call(window, '/api/session/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account: account, key: key })
      });
      Promise.resolve(req).then(function (r) { return r.json(); }).then(function (j) {
        if (j && j.ok && j.token) {
          try { localStorage.setItem(TOKEN_KEY, j.token); } catch (_) {}
          try { sessionStorage.removeItem('vomi_guest_mode'); } catch (_) {}
          close();
          try { window.location.reload(); } catch (_) {}
        } else {
          // 后端要求口令时（VOMI_UNLOCK_KEY / 专属口令模式）才把口令框显示出来
          if (j && (j.error === 'key_required' || j.error === 'bad_key')) {
            input.style.display = 'block';
            if (j.error === 'key_required') { err.textContent = ''; input.focus(); return; }
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

  // ---------- 已解锁提示（每个标签页只提示一次）----------
  // 令牌存 localStorage、长期有效（100 年，等同永久）：再次打开不用重新输账号。
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
      if (READONLY) {
        headers.set('X-Vomi-Role', 'guest');
        if (isWrite(method)) {
          toast(DENY_MSG);
          init.headers = headers;
          return Promise.resolve(denyResponse());
        }
      } else if (TOKEN) {
        headers.set('X-Vomi-Editor', TOKEN);
        if (method === 'DELETE' && !headers.get('X-Vomi-Skip-Confirm') && !confirmDelete(input)) {
          toast('已取消删除');
          return Promise.resolve(cancelResponse());
        }
        headers.delete('X-Vomi-Skip-Confirm');
      }
      init.headers = headers;
      return _fetch(input, init).then(function (res) {
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
        XHRsetReq.call(this, READONLY ? 'X-Vomi-Role' : 'X-Vomi-Editor', READONLY ? 'guest' : TOKEN);
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
