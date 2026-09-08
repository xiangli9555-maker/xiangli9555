'use strict';
/**
 * Vomi 预览模式 (guest read-only)
 * ---------------------------------
 * 触发：URL search 或 hash 里带 role=guest → sessionStorage 传承
 * 前端保护：所有 POST/PUT/PATCH/DELETE 被 wrapper 拦截 → 返 403 fake + toast
 * 后端保护：所有请求带 X-Vomi-Role: guest header，后端 apiAuth 降为 viewer，
 *          methodRbac 自动 403（POST/PUT/PATCH 需 editor+，DELETE 需 admin）
 * iframe 透传：外壳里所有 iframe.src 自动加 role=guest（首次 + MutationObserver 兜后续动态）
 * 视觉：顶部品牌黄横幅 (position:fixed) + 底部 toast 玻璃卡片，切角军事风
 */
(function () {
  function isGuestMode() {
    try {
      const url = new URL(window.location.href);
      if ((url.searchParams.get('role') || '').toLowerCase() === 'guest') return true;
      const hash = url.hash || '';
      if (/[?&]role=guest\b/i.test(hash)) return true;
      if (sessionStorage.getItem('vomi_guest_mode') === '1') return true;
    } catch (_) {}
    return false;
  }
  const GUEST = isGuestMode();
  window.__VOMI_GUEST__ = GUEST;
  if (!GUEST) return;
  try { sessionStorage.setItem('vomi_guest_mode', '1'); } catch (_) {}

  // ---------- 顶部横幅 ----------
  function installBanner() {
    if (document.getElementById('vomi-guest-banner')) return;
    const bar = document.createElement('div');
    bar.id = 'vomi-guest-banner';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99998;background:#FFD24C;color:#0A1015;padding:7px 16px;font:600 12px/1.4 "Microsoft YaHei UI","PingFang SC",sans-serif;letter-spacing:.3px;display:flex;align-items:center;justify-content:center;gap:12px;box-shadow:0 2px 10px rgba(0,0,0,.45);border-bottom:1px solid rgba(10,16,21,.35);pointer-events:auto';
    bar.innerHTML = '<span style="font-family:\'JetBrains Mono\',monospace;font-weight:700;letter-spacing:.6px;background:#0A1015;color:#FFD24C;padding:2px 7px;">[PREVIEW]</span><span>预览模式 · Read Only · 你可以查看和试填，但改动不会保存</span><button type="button" id="vomi-guest-banner-close" title="收起（仅本次会话）" aria-label="收起横幅" style="margin-left:6px;background:transparent;border:1px solid rgba(10,16,21,.55);color:#0A1015;padding:2px 10px;font:600 11px inherit;cursor:pointer;border-radius:0;clip-path:polygon(4px 0,100% 0,100% calc(100% - 4px),calc(100% - 4px) 100%,0 100%,0 4px)">收起</button>';
    document.body.appendChild(bar);
    document.body.style.setProperty('padding-top', '32px', 'important');
    document.getElementById('vomi-guest-banner-close').onclick = function () {
      bar.style.display = 'none';
      document.body.style.paddingTop = '';
    };
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installBanner);
  } else {
    installBanner();
  }

  // ---------- toast ----------
  let toastTimer = 0;
  function toast(msg) {
    let t = document.getElementById('vomi-guest-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'vomi-guest-toast';
      t.style.cssText = 'position:fixed;bottom:32px;left:50%;transform:translateX(-50%);z-index:99999;background:rgba(20,30,36,.96);color:#FFD24C;padding:10px 20px;font:600 12px/1.4 "Microsoft YaHei UI","PingFang SC",sans-serif;letter-spacing:.3px;border:1px solid rgba(255,210,76,.5);box-shadow:0 8px 24px rgba(0,0,0,.55);clip-path:polygon(6px 0,100% 0,100% calc(100% - 6px),calc(100% - 6px) 100%,0 100%,0 6px);pointer-events:none;opacity:0;transition:opacity .18s';
      (document.body || document.documentElement).appendChild(t);
    }
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.style.opacity = '0'; }, 2400);
  }
  window.__vomiGuestToast = toast;

  // ---------- fetch wrapper ----------
  const _fetch = window.fetch ? window.fetch.bind(window) : null;
  if (_fetch) {
    window.fetch = function (input, init) {
      init = init || {};
      let method = init.method;
      if (!method && typeof input === 'object' && input && input.method) method = input.method;
      method = String(method || 'GET').toUpperCase();
      // 每次请求都带 header，让后端也能拦
      const headers = new Headers(init.headers || (typeof input === 'object' && input ? input.headers : undefined) || {});
      headers.set('X-Vomi-Role', 'guest');
      init.headers = headers;
      if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
        toast('预览模式：改动未保存');
        const body = JSON.stringify({ ok: false, error: 'guest_readonly', message: '预览模式，无写入权限' });
        return Promise.resolve(new Response(body, { status: 403, headers: { 'Content-Type': 'application/json', 'X-Vomi-Guest': '1' } }));
      }
      return _fetch(input, init);
    };
  }

  // ---------- XHR wrapper（少用兜底） ----------
  try {
    const XHRopen = XMLHttpRequest.prototype.open;
    const XHRsend = XMLHttpRequest.prototype.send;
    const XHRsetReq = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__vomi_method = String(method || '').toUpperCase();
      this.__vomi_url = url;
      return XHRopen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      try { XHRsetReq.call(this, 'X-Vomi-Role', 'guest'); } catch (_) {}
      const m = this.__vomi_method;
      if (m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE') {
        toast('预览模式：改动未保存');
        const self = this;
        setTimeout(function () {
          try {
            Object.defineProperty(self, 'readyState', { value: 4, configurable: true });
            Object.defineProperty(self, 'status', { value: 403, configurable: true });
            Object.defineProperty(self, 'responseText', { value: '{"ok":false,"error":"guest_readonly"}', configurable: true });
            Object.defineProperty(self, 'response', { value: '{"ok":false,"error":"guest_readonly"}', configurable: true });
          } catch (_) {}
          if (typeof self.onreadystatechange === 'function') self.onreadystatechange();
          if (typeof self.onload === 'function') self.onload();
        }, 5);
        return;
      }
      return XHRsend.apply(this, arguments);
    };
  } catch (_) {}

  // ---------- iframe.src 自动带 role=guest ----------
  function tagIframes() {
    const list = document.querySelectorAll('iframe[src]');
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      const src = f.getAttribute('src') || '';
      if (!src || src.startsWith('data:') || src.startsWith('blob:') || src.startsWith('about:')) continue;
      if (/([?&]role=guest\b)/i.test(src)) continue;
      try {
        const u = new URL(src, window.location.href);
        u.searchParams.set('role', 'guest');
        f.setAttribute('src', u.toString());
      } catch (_) {
        // 兜底：直接拼
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
    const mo = new MutationObserver(function (muts) {
      let any = false;
      for (let i = 0; i < muts.length; i++) {
        const nodes = muts[i].addedNodes || [];
        for (let j = 0; j < nodes.length; j++) {
          const n = nodes[j];
          if (n && n.tagName === 'IFRAME') { any = true; break; }
        }
        if (any) break;
      }
      if (any) tagIframes();
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  } catch (_) {}
})();
