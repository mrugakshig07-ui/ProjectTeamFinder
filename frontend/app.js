// Applies the saved appearance preference on every page. Unauthenticated
// pages simply keep the system/default theme; no private data is exposed.
(async () => {
  try {
    const response = await fetch('/api/settings');
    const data = await response.json();
    if (!data.success) return;
    const preference = data.settings.appearance;
    const theme = preference === 'system'
      ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
      : preference;
    document.body.dataset.theme = theme;
    localStorage.setItem('pf-appearance', preference);
  } catch (_) {
    const preference = localStorage.getItem('pf-appearance');
    if (preference && preference !== 'system') document.body.dataset.theme = preference;
  }
})();

// ============================================================
// App shell: a left sidebar (always visible, no collapsing) plus a
// top bar (search + three buttons once signed in) shared by every
// in-app page. The marketing home page and the auth pages
// (login/register/…) keep their own layout, so this bails out early
// on those.
// ============================================================
(() => {
  const body = document.body;
  if (body.classList.contains('home-page') || body.classList.contains('auth-page')) return;
  const nav = document.querySelector('.navbar');
  if (!nav) return;

  const esc = v => { const d = document.createElement('div'); d.textContent = v == null ? '' : v; return d.innerHTML; };

  const ICONS = {
    spark: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.2 6.8L21 11l-6.8 2.2L12 20l-2.2-6.8L3 11l6.8-2.2L12 2z"/></svg>',
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9a1 1 0 0 0 1 1H9a1 1 0 0 0 1-1v-4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v4a1 1 0 0 0 1 1h2.5a1 1 0 0 0 1-1v-9"/></svg>',
    projects: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/></svg>',
    members: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M2.8 19c.6-3.2 3-5 6.2-5s5.6 1.8 6.2 5"/><circle cx="17" cy="7.5" r="2.4"/><path d="M15.6 11.3c2.6.2 4.4 1.9 4.9 4.6"/></svg>',
    teams: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="13" rx="2.2"/><path d="M8 21h8M12 17v4"/></svg>',
    connections: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="12" r="3.4"/><circle cx="17" cy="12" r="3.4"/><path d="M10.2 12h3.6"/></svg>',
    bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9a6 6 0 0 1 12 0c0 4.2 1.2 5.6 2 6.6H4c.8-1 2-2.4 2-6.6Z"/><path d="M10 19a2 2 0 0 0 4 0"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.4"/><path d="M4.8 20c.8-3.6 3.4-5.6 7.2-5.6s6.4 2 7.2 5.6"/></svg>',
    settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 13.5a1.7 1.7 0 0 0 .34 1.87l.06.06a2.06 2.06 0 1 1-2.92 2.92l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V19.6a2.06 2.06 0 1 1-4.12 0v-.1a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2.06 2.06 0 1 1-2.92-2.92l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H4.4a2.06 2.06 0 1 1 0-4.12h.1a1.7 1.7 0 0 0 1.55-1.1 1.7 1.7 0 0 0-.34-1.87l-.06-.06A2.06 2.06 0 1 1 8.57 3.9l.06.06a1.7 1.7 0 0 0 1.87.34H10.6a1.7 1.7 0 0 0 1-1.55V2.66a2.06 2.06 0 1 1 4.12 0v.1a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2.06 2.06 0 1 1 2.92 2.92l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1h.14a2.06 2.06 0 1 1 0 4.12h-.1a1.7 1.7 0 0 0-1.55 1Z"/></svg>',
    logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3"/><path d="M15 16l4-4-4-4"/><path d="M19 12H9"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.3-4.3"/></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 6.5a1 1 0 0 1 1-1h4.4l1.6 2h9a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-11.5Z"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5h16a1 1 0 0 1 1 1V16a1 1 0 0 1-1 1H9l-4.5 4V17H4a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1Z"/></svg>'
  };

  const page = location.pathname.split('/').pop() || 'index.html';
  const active = href => (page === href ? ' is-active' : '');

  const NAV_LINKS = [
    ['index.html', 'Home', ICONS.home],
    ['projects.html', 'Find Teams', ICONS.projects],
    ['my-projects.html', 'My Projects', ICONS.folder],
    ['messages.html', 'Messages', ICONS.chat, 'messages'],
    ['members.html', 'Members', ICONS.members],
    ['team-dashboard.html', 'My Teams', ICONS.teams],
    ['connections.html', 'Connections', ICONS.connections],
    ['notifications.html', 'Notifications', ICONS.bell]
  ];

  const sidebar = document.createElement('aside');
  sidebar.className = 'app-sidebar';
  sidebar.innerHTML = `
    <a class="app-logo" href="index.html"><span class="app-logo-mark">${ICONS.spark}</span><span class="app-logo-word">Project<em>Finder</em></span></a>
    <nav class="app-sidebar-nav">
      ${NAV_LINKS.map(([href, label, icon, marker]) => `<a class="app-nav-link${active(href)}" href="${href}">${icon}<span>${label}</span>${href === 'notifications.html' ? '<span class="app-nav-badge" id="sidebarNotifBadge" hidden></span>' : marker === 'messages' ? '<span class="app-nav-badge" id="sidebarMessagesBadge" hidden></span>' : ''}</a>`).join('')}
    </nav>
    ${body.classList.contains('members-page') ? `
    <a class="app-sidebar-promo" href="post-project.html">
      <span class="app-sidebar-promo-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M2.8 19c.6-3.2 3-5 6.2-5s5.6 1.8 6.2 5"/><circle cx="17" cy="7.5" r="2.4"/><path d="M15.6 11.3c2.6.2 4.4 1.9 4.9 4.6"/></svg></span>
      <strong>Better Teams Build Bigger Dreams</strong>
      <span>Find like-minded people, collaborate, create and make it happen.</span>
      <span class="app-sidebar-promo-arrow">→</span>
    </a>` : body.classList.contains('findteams-page') ? `
    <a class="app-sidebar-promo" href="post-project.html">
      <span class="app-sidebar-promo-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 3.5c3 0 6 3 6 6-3.5 1-6.5 3-9 6l-3-3c3-2.5 5-5.5 6-9Z"/><path d="M9.5 14 6 17.5M4 20l1.5-3.5L8 19 4 20Z"/><circle cx="15.5" cy="8.5" r="1.5"/></svg></span>
      <strong>Build Something Amazing Together</strong>
      <span>Find your perfect team, work on exciting projects, and grow your skills.</span>
      <span class="app-sidebar-promo-arrow">→</span>
    </a>` : body.classList.contains('notifications-page') ? `
    <a class="app-sidebar-promo" href="settings.html">
      <span class="app-sidebar-promo-icon">${ICONS.bell}</span>
      <strong>Stay in the Loop</strong>
      <span>Never miss a new opportunity, message or team update!</span>
      <span class="app-sidebar-promo-arrow">→</span>
    </a>` : ''}
    <div class="app-sidebar-footer" id="sidebarFooter"></div>`;

  const topbar = document.createElement('header');
  topbar.className = 'app-topbar';
  topbar.innerHTML = `
    <div class="app-search">
      <span class="app-search-icon">${ICONS.search}</span>
      <input type="search" id="appSearchInput" placeholder="Search projects or people…" autocomplete="off">
      <kbd class="app-search-kbd">⌘K</kbd>
      <div class="app-search-results" id="appSearchResults" hidden></div>
    </div>
    <div class="app-topbar-actions" id="topbarActions"></div>`;

  const contentCol = document.createElement('div');
  contentCol.className = 'app-content-col';
  const main = document.querySelector('main');
  nav.replaceWith(contentCol);
  contentCol.appendChild(topbar);
  if (main) contentCol.appendChild(main);
  body.insertBefore(sidebar, body.firstChild);
  body.classList.add('app-shell-active');

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') document.getElementById('appSearchResults').hidden = true;
  });

  // ---- search: live results from the existing members + projects APIs ----
  const searchInput = document.getElementById('appSearchInput');
  const searchResults = document.getElementById('appSearchResults');
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); searchInput.focus(); searchInput.select(); }
  });
  function personRow(p) {
    const initial = esc((p.name || '?')[0].toUpperCase());
    return `<a class="app-search-row" href="member-profile.html?user=${encodeURIComponent(p.public_id)}">
      <span class="app-search-avatar">${p.photo ? `<img src="${esc(p.photo)}" alt="">` : initial}</span>
      <span class="app-search-row-text"><strong>${esc(p.name)}</strong><span>@${esc(p.username)} · ${esc(p.role_title || 'Member')}</span></span>
    </a>`;
  }
  function projectRow(p) {
    return `<a class="app-search-row" href="project.html?id=${encodeURIComponent(p.id)}">
      <span class="app-search-avatar app-search-avatar-project">${ICONS.projects}</span>
      <span class="app-search-row-text"><strong>${esc(p.title)}</strong><span>${esc(p.category || 'Project')} · ${esc(p.status)}</span></span>
    </a>`;
  }
  async function runSearch(q) {
    searchResults.innerHTML = '<div class="app-search-loading">Searching…</div>';
    searchResults.hidden = false;
    try {
      const [members, projects] = await Promise.all([
        fetch('/api/members?q=' + encodeURIComponent(q) + '&page=0').then(r => r.json()).catch(() => null),
        fetch('/api/projects/discover?q=' + encodeURIComponent(q) + '&page=0').then(r => r.json()).catch(() => null)
      ]);
      const people = members?.success ? members.members.slice(0, 4) : [];
      const projectHits = projects?.success ? projects.projects.slice(0, 4) : [];
      if (!people.length && !projectHits.length) {
        searchResults.innerHTML = '<div class="app-search-empty">No matches for “' + esc(q) + '”.</div>';
        return;
      }
      searchResults.innerHTML = `
        ${people.length ? `<div class="app-search-group"><p>People</p>${people.map(personRow).join('')}</div>` : ''}
        ${projectHits.length ? `<div class="app-search-group"><p>Projects</p>${projectHits.map(projectRow).join('')}</div>` : ''}`;
    } catch (_) {
      searchResults.innerHTML = '<div class="app-search-empty">Search is unavailable right now.</div>';
    }
  }
  let searchTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = searchInput.value.trim();
    if (!q) { searchResults.hidden = true; searchResults.innerHTML = ''; return; }
    searchTimer = setTimeout(() => runSearch(q), 260);
  });
  searchInput.addEventListener('focus', () => { if (searchInput.value.trim() && searchResults.innerHTML) searchResults.hidden = false; });
  document.addEventListener('click', e => {
    if (!e.target.closest('.app-search')) searchResults.hidden = true;
  });

  // ---- signed-out topbar/sidebar footer ----
  function renderSignedOut() {
    document.getElementById('topbarActions').innerHTML = `
      <a class="app-text-link" href="login.html">Log in</a>
      <a class="app-gradient-button" href="register.html">Get started</a>`;
    document.getElementById('sidebarFooter').innerHTML = `
      <a class="app-nav-link${active('login.html')}" href="login.html">${ICONS.user}<span>Log in</span></a>
      <a class="app-nav-link app-nav-link-cta" href="register.html">${ICONS.spark}<span>Get started</span></a>`;
  }

  // ---- signed-in: sidebar footer + exactly three topbar buttons ----
  // (Home, Notifications, My Profile — no dropdowns; Settings/Log out
  // already live in the sidebar footer below.)
  async function refreshMessageBadge() {
    const badge = document.getElementById('sidebarMessagesBadge');
    if (!badge) return;
    try {
      const data = await fetch('/api/conversations').then(r => r.json());
      const unread = data.success ? data.conversations.reduce((sum, c) => sum + (c.unread || 0), 0) : 0;
      badge.hidden = unread === 0;
      badge.textContent = unread > 9 ? '9+' : String(unread);
    } catch (_) {}
  }
  async function refreshNotifBadges() {
    try {
      const data = await fetch('/api/notifications').then(r => r.json());
      if (!data.success) return;
      const unread = data.unread || 0;
      const topDot = document.getElementById('topNotifDot');
      const sideBadge = document.getElementById('sidebarNotifBadge');
      if (topDot) topDot.hidden = unread === 0;
      if (sideBadge) { sideBadge.hidden = unread === 0; sideBadge.textContent = unread > 9 ? '9+' : String(unread); }
    } catch (_) {}
  }
  function avatarMarkup(u) {
    return u.photo ? `<img src="${esc(u.photo)}" alt="">` : esc((u.name || '?')[0].toUpperCase());
  }
  async function renderSignedIn() {
    const { user: u } = await fetch('/api/me').then(r => r.json());
    document.getElementById('topbarActions').innerHTML = `
      <a class="app-icon-button${active('index.html')}" href="index.html" title="Home" aria-label="Home">${ICONS.home}</a>
      <a class="app-icon-button${active('notifications.html')}" href="notifications.html" title="Notifications" aria-label="Notifications">${ICONS.bell}<span class="app-bell-dot" id="topNotifDot" hidden></span></a>
      <a class="app-icon-button app-icon-button-avatar${active('profile.html')}" href="profile.html" title="My profile" aria-label="My profile">${avatarMarkup(u)}</a>`;
    document.getElementById('sidebarFooter').innerHTML = `
      <a class="app-nav-link${active('profile.html')}" href="profile.html">${ICONS.user}<span>Profile</span></a>
      <a class="app-nav-link${active('settings.html')}" href="settings.html">${ICONS.settings}<span>Settings</span></a>
      <button class="app-nav-link" type="button" data-logout>${ICONS.logout}<span>Log out</span></button>`;

    document.querySelectorAll('[data-logout]').forEach(btn => btn.addEventListener('click', async () => {
      try { await fetch('/api/logout', { method: 'POST' }); } catch (_) {}
      location.href = 'index.html';
    }));

    await Promise.all([refreshNotifBadges(), refreshMessageBadge()]);

    // Real presence: a heartbeat while this tab is open and visible, so
    // presenceStatus() on the server has a genuine timestamp to work from
    // — not a fake "online" dot.
    const ping = () => { if (document.visibilityState === 'visible') fetch('/api/presence/ping', { method: 'POST' }).catch(() => {}); };
    ping();
    setInterval(ping, 60000);
    document.addEventListener('visibilitychange', ping);
  }

  renderSignedOut();
  fetch('/api/me').then(r => r.ok ? r.json() : null).then(data => {
    if (data?.success) renderSignedIn();
  }).catch(() => {});
})();
