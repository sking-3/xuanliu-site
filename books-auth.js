/* GitHub Pages bridge for the Books VPS authentication API.
 * Set window.BOOKS_API_BASE before loading this file when Pages and the API
 * use different origins. The VPS must allow that exact origin with cookies.
 */
(function installBooksAuth(global) {
  function apiBase() {
    const configured = global.BOOKS_API_BASE || document.querySelector('meta[name="books-api-base"]')?.content || '/';
    return String(configured).replace(/\/+$/, '');
  }

  async function request(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body !== undefined && !headers.has('content-type')) headers.set('content-type', 'application/json');
    const response = await fetch(`${apiBase()}${path}`, { ...options, headers, credentials: 'include' });
    let payload = null;
    try { payload = await response.json(); } catch { payload = { error: 'invalid_server_response' }; }
    if (!response.ok) {
      const error = new Error(payload?.error || `http_${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  global.BooksAuth = Object.freeze({
    apiBase,
    request,
    me: () => request('/api/auth/me'),
    register: (value) => request('/api/auth/register', { method: 'POST', body: JSON.stringify(value) }),
    login: (value) => request('/api/auth/login', { method: 'POST', body: JSON.stringify(value) }),
    logout: () => request('/api/auth/logout', { method: 'POST', body: '{}' }),
    profile: () => request('/api/account/profile'),
    setAvatar: (value) => request('/api/account/profile/avatar', { method: 'POST', body: JSON.stringify(value) }),
    wallet: () => request('/api/wallet'),
    recharges: () => request('/api/wallet/recharges'),
    recharge: (value) => request('/api/wallet/recharge', { method: 'POST', body: JSON.stringify(value) }),
    adminUsers: () => request('/api/admin/users'),
    disableUser: (userId) => request('/api/admin/users/disable', { method: 'POST', body: JSON.stringify({ userId }) })
  });
})(window);
