// Shared UI helpers: one consistent way to talk to the API, to describe what
// state a list is in, and to avoid firing a request on every keystroke.
window.PF = (() => {
  const esc = v => { const d = document.createElement('div'); d.textContent = v == null ? '' : v; return d.innerHTML; };

  // Throws an Error carrying `code` and `status` so callers can tell an
  // auth problem apart from a permission problem apart from a server fault.
  async function api(url, options) {
    let response;
    try {
      response = await fetch(url, options);
    } catch (networkError) {
      const error = new Error('offline');
      error.code = 'offline';
      throw error;
    }
    let data = null;
    try { data = await response.json(); } catch (_) { data = null; }
    if (!response.ok || !data || !data.success) {
      const error = new Error((data && data.message) || 'Request failed.');
      error.code = (data && data.code) || (response.status === 401 ? 'auth_required' : 'server_error');
      error.status = response.status;
      error.detail = data && data.detail;   // localhost-only cause, shown below the message
      throw error;
    }
    return data;
  }

  // What the user sees, per state. Raw database text never reaches here.
  const MESSAGES = {
    offline: ['You appear to be offline.', 'Check your connection and try again.'],
    auth_required: ['Please log in to see this.', ''],
    db_permission: ["We couldn't load this right now.", 'The site owner has been notified.'],
    db_schema: ["We couldn't load this right now.", 'Please try again shortly.'],
    server_error: ["We couldn't load this right now.", 'Please try again.'],
    bad_request: ['That search was not valid.', 'Try adjusting your filters.']
  };

  function loading(text) {
    return `<p class="state state-loading">${esc(text || 'Loading…')}</p>`;
  }

  function empty(text, hint) {
    return `<div class="state state-empty"><p>${esc(text)}</p>${hint ? `<span>${esc(hint)}</span>` : ''}</div>`;
  }

  // `error` is what api() threw. The developer detail goes to the console,
  // never to the page.
  function failure(error, context) {
    console.error(`[${context}]`, error.code || 'unknown', error.status || '', error.message);
    const [title, hint] = MESSAGES[error.code] || MESSAGES.server_error;
    const action = error.code === 'auth_required'
      ? '<a class="primary-button" href="login.html">Log in</a>'
      : '<button type="button" class="secondary-button" data-retry>Try again</button>';
    const detail = error.detail ? `<code class="state-detail">${esc(error.detail)}</code>` : '';
    return `<div class="state state-error"><p>${esc(title)}</p>${hint ? `<span>${esc(hint)}</span>` : ''}${detail}<div class="state-actions">${action}</div></div>`;
  }

  // Waits for typing to stop before firing, so a 20-character search is one
  // request instead of twenty.
  function debounce(fn, wait = 300) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  return { api, esc, loading, empty, failure, debounce };
})();
