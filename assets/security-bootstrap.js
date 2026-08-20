(() => {
  'use strict';

  const TOKEN_KEY = 'vo_api_token_v1';
  const originalFetch = window.fetch.bind(window);

  function isProtectedRequest(input) {
    try {
      const raw = typeof input === 'string' ? input : input.url;
      const url = new URL(raw, window.location.href);
      return url.origin === window.location.origin && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/audio/'));
    } catch (_) {
      return false;
    }
  }

  function readToken() {
    return sessionStorage.getItem(TOKEN_KEY) || '';
  }

  function askForToken() {
    const token = window.prompt('请输入 Vo Manager 访问令牌。令牌仅保存在当前浏览器标签页。', '');
    if (token && token.trim()) {
      sessionStorage.setItem(TOKEN_KEY, token.trim());
      return token.trim();
    }
    return '';
  }

  async function authorizedFetch(input, init = {}) {
    if (!isProtectedRequest(input)) return originalFetch(input, init);

    let token = readToken();
    const execute = () => {
      const headers = new Headers(init.headers || (typeof input !== 'string' && input.headers) || undefined);
      if (token) headers.set('Authorization', `Bearer ${token}`);
      return originalFetch(input, { ...init, headers });
    };

    const response = await execute();
    if (response.status !== 401 || init.__voAuthRetried) return response;

    sessionStorage.removeItem(TOKEN_KEY);
    token = askForToken();
    if (!token) return response;
    return authorizedFetch(input, { ...init, __voAuthRetried: true, headers: init.headers });
  }

  window.fetch = authorizedFetch;
  window.voClearAccessToken = () => sessionStorage.removeItem(TOKEN_KEY);
})();
