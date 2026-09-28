// Connections: a networking hub — requests waiting on you, requests you
// sent, your accepted connections, and real shared-skill suggestions.
const $ = id => document.getElementById(id);
const esc = v => { const d = document.createElement('div'); d.textContent = v == null ? '' : v; return d.innerHTML; };

async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({ success: false, message: 'The server sent an unreadable response.' }));
  if (!data.success) throw new Error(data.message || 'Request failed.');
  return data;
}

function setMessage(text, kind) {
  const el = $('message');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'profile-message' + (text ? ' is-visible' : '') + (kind === 'error' ? ' is-error' : kind === 'success' ? ' is-success' : '');
  if (text) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

const avatar = p => p.photo ? `<img src="${esc(p.photo)}" alt="">` : '👤';
const profileLink = p => `member-profile.html?user=${encodeURIComponent(p.public_id)}`;
const PREVIEW = { requests: 3, sent: 2, connections: 5 };
const expanded = { requestsGrid: false, sentGrid: false, connAvatars: false };
let state = { requests: [], sent: [], connections: [], suggestions: [], teamsCount: 0 };
let activeTab = 'all';
let sortMode = 'recent';

function requestCard(item, i = 0) {
  return `<article class="conn-card" style="--i:${i % 12}">
    <a class="conn-card-person" href="${profileLink(item.profile)}">
      <div class="member-avatar">${avatar(item.profile)}</div>
      <div><strong>${esc(item.profile.name)}</strong><span>${esc(item.profile.role_title || 'Member')}</span></div>
    </a>
    <div class="conn-card-actions">
      <button type="button" class="conn-icon-btn conn-icon-accept" data-id="${esc(item.id)}" data-status="accepted" title="Accept" aria-label="Accept">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5 9 17l10.5-10.5"/></svg>
      </button>
      <button type="button" class="conn-icon-btn conn-icon-reject" data-id="${esc(item.id)}" data-status="rejected" title="Reject" aria-label="Reject">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
      </button>
    </div>
  </article>`;
}

function sentCard(item, i = 0) {
  return `<article class="conn-card" style="--i:${i % 12}">
    <a class="conn-card-person" href="${profileLink(item.profile)}">
      <div class="member-avatar">${avatar(item.profile)}</div>
      <div><strong>${esc(item.profile.name)}</strong><span>${esc(item.profile.role_title || 'Member')}</span></div>
    </a>
    <div class="conn-card-actions">
      <span class="conn-pending-pill">Pending</span>
      <button type="button" class="text-button" data-id="${esc(item.id)}" data-status="cancelled">Withdraw</button>
    </div>
  </article>`;
}

function connTile(profile, i = 0) {
  return `<div class="conn-avatar-tile" style="--i:${i % 12}">
    <button type="button" class="conn-tile-remove" data-remove="${esc(profile.connection.id)}" title="Remove connection" aria-label="Remove connection">✕</button>
    <a class="conn-avatar-tile-link" href="${profileLink(profile)}">
      <div class="conn-avatar-tile-photo">${avatar(profile)}<span class="person-status person-status-${profile.status || 'offline'}"></span></div>
      <strong>${esc(profile.name)}</strong>
      <span>${esc(profile.role_title || 'Member')}</span>
    </a>
  </div>`;
}

function suggestCard(profile, i = 0) {
  return `<article class="conn-card conn-suggest-card" style="--i:${i % 12}">
    <a class="conn-card-person" href="${profileLink(profile)}">
      <div class="member-avatar">${avatar(profile)}</div>
      <div><strong>${esc(profile.name)}</strong><span>${esc(profile.role_title || 'Member')}</span></div>
    </a>
    <div class="conn-card-actions">
      <button type="button" class="secondary-button conn-connect" data-connect="${esc(profile.public_id)}">Connect</button>
      <button type="button" class="conn-dismiss" data-dismiss="${esc(profile.public_id)}" title="Not interested" aria-label="Dismiss">✕</button>
    </div>
  </article>`;
}

function suggestRow(profile) {
  return `<div class="conn-suggested-row">
    <a class="conn-suggested-avatar" href="${profileLink(profile)}">${avatar(profile)}</a>
    <div class="conn-suggested-text"><strong>${esc(profile.name)}</strong><span>${esc(profile.role_title || 'Member')}</span></div>
    <button type="button" class="secondary-button conn-connect" data-connect="${esc(profile.public_id)}">Connect</button>
    <button type="button" class="conn-dismiss" data-dismiss="${esc(profile.public_id)}" title="Not interested" aria-label="Dismiss">✕</button>
  </div>`;
}

function renderExpandable(containerId, items, renderFn, previewCount, emptyText) {
  const el = $(containerId);
  const isExpanded = expanded[containerId];
  const shown = isExpanded ? items : items.slice(0, previewCount);
  el.innerHTML = items.length ? shown.map(renderFn).join('') : `<p class="search-empty">${emptyText}</p>`;
  const viewAllBtn = document.querySelector(`[data-viewall="${containerId}"]`);
  if (viewAllBtn) viewAllBtn.hidden = items.length <= previewCount;
  if (viewAllBtn) viewAllBtn.textContent = isExpanded ? 'Show less ←' : 'View all →';
}

function sortedConnections() {
  const list = state.connections.slice();
  if (sortMode === 'name') list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
}

function renderAll() {
  $('reqCount').textContent = state.requests.length;
  $('sentCount').textContent = state.sent.length;
  $('connCount').textContent = state.connections.length;
  $('tabAllCount').textContent = state.connections.length;
  $('tabReqCount').textContent = state.requests.length;
  $('tabSugCount').textContent = state.suggestions.length;
  $('sugTabCount').textContent = state.suggestions.length;

  renderExpandable('requestsGrid', state.requests, requestCard, PREVIEW.requests, 'No pending connection requests.');
  renderExpandable('sentGrid', state.sent, sentCard, PREVIEW.sent, "You have no requests waiting on a reply.");

  const connections = sortedConnections();
  const preview = expanded.connAvatars ? connections : connections.slice(0, PREVIEW.connections);
  const remaining = connections.length - preview.length;
  $('connAvatars').innerHTML = connections.length
    ? preview.map((p, i) => connTile(p, i)).join('') + (!expanded.connAvatars && remaining > 0
        ? `<button type="button" class="conn-avatar-more" data-viewall="connAvatars">+${remaining} More</button>` : '')
    : '<p class="search-empty">No connections yet. Find people on the <a href="members.html">Members</a> page.</p>';
  const connViewAll = document.querySelector('[data-viewall="connAvatars"].conn-viewall');
  if (connViewAll) { connViewAll.hidden = connections.length <= PREVIEW.connections; connViewAll.textContent = expanded.connAvatars ? 'Show less ←' : 'View all →'; }

  $('suggestionsGrid').innerHTML = state.suggestions.length
    ? state.suggestions.map((p, i) => suggestCard(p, i)).join('')
    : '<p class="search-empty">No suggestions right now — add a few skills to your profile, or check back once more members join.</p>';

  const sidebarPicks = state.suggestions.slice(0, 4);
  $('suggestedSidebar').innerHTML = sidebarPicks.length
    ? sidebarPicks.map(suggestRow).join('')
    : '<p class="search-empty">No suggestions right now.</p>';

  $('statTotal').textContent = state.connections.length;
  $('statPending').textContent = state.requests.length;
  $('statSuggestions').textContent = state.suggestions.length;
  $('statTeams').textContent = state.teamsCount;
}

async function load() {
  try {
    const [pending, accepted, suggested, teams] = await Promise.all([
      api('/api/connection-requests'),
      api('/api/connections'),
      api('/api/members/suggested?limit=12'),
      api('/api/my-teams')
    ]);
    state = {
      requests: pending.requests,
      sent: pending.sent,
      connections: accepted.connections,
      suggestions: suggested.members,
      teamsCount: teams.teams.length
    };
    renderAll();
  } catch (error) {
    setMessage(error.message, 'error');
  }
}

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('#connTabs button[data-tab]').forEach(b => b.classList.toggle('is-active', b.dataset.tab === tab));
  document.querySelectorAll('.conn-panel').forEach(panel => {
    const tabs = (panel.dataset.panel || '').split(' ');
    panel.hidden = !tabs.includes(tab);
  });
}
$('connTabs').addEventListener('click', e => {
  const btn = e.target.closest('button[data-tab]');
  if (btn) switchTab(btn.dataset.tab);
});
$('sortSelect').addEventListener('change', () => { sortMode = $('sortSelect').value; renderAll(); });
document.querySelectorAll('[data-seeall]').forEach(b => b.addEventListener('click', () => switchTab('suggestions')));

// Delegated so buttons keep working after every re-render.
document.addEventListener('click', async event => {
  const viewAllBtn = event.target.closest('[data-viewall]');
  if (viewAllBtn) {
    const id = viewAllBtn.dataset.viewall;
    expanded[id] = !expanded[id];
    renderAll();
    return;
  }

  const connectBtn = event.target.closest('[data-connect]');
  if (connectBtn) {
    connectBtn.disabled = true;
    try {
      await api('/api/profiles/' + encodeURIComponent(connectBtn.dataset.connect) + '/connect', { method: 'POST' });
      state.suggestions = state.suggestions.filter(p => p.public_id !== connectBtn.dataset.connect);
      setMessage('Connection request sent.', 'success');
      renderAll();
      const fresh = await api('/api/connection-requests');
      state.sent = fresh.sent;
      renderAll();
    } catch (error) { setMessage(error.message, 'error'); connectBtn.disabled = false; }
    return;
  }

  const dismissBtn = event.target.closest('[data-dismiss]');
  if (dismissBtn) {
    state.suggestions = state.suggestions.filter(p => p.public_id !== dismissBtn.dataset.dismiss);
    renderAll();
    return;
  }

  const removeBtn = event.target.closest('[data-remove]');
  if (removeBtn) {
    if (!confirm('Remove this connection?')) return;
    removeBtn.disabled = true;
    try {
      const result = await api('/api/connections/' + encodeURIComponent(removeBtn.dataset.remove), { method: 'DELETE' });
      setMessage(result.message || '', 'success');
      await load();
    } catch (error) { setMessage(error.message, 'error'); removeBtn.disabled = false; }
    return;
  }

  const button = event.target.closest('button[data-id]');
  if (!button) return;
  if (button.dataset.status === 'cancelled' && !confirm('Withdraw this connection request?')) return;

  button.disabled = true;
  setMessage('');
  try {
    const result = await api('/api/connections/' + encodeURIComponent(button.dataset.id), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: button.dataset.status })
    });
    setMessage(result.message || '', 'success');
    await load();
  } catch (error) {
    setMessage(error.message, 'error');
    button.disabled = false;
  }
});

const initialTab = new URLSearchParams(location.search).get('tab');
if (['all', 'requests', 'suggestions'].includes(initialTab)) switchTab(initialTab);

load();
