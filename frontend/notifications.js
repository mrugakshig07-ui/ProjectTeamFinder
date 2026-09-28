// Notifications: a real activity feed — filterable by category, with real
// actor avatars, real mutual-connection counts on pending connection
// requests, and inline Accept/Reject where the underlying action still
// applies.
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

function timeAgo(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// Every real notification type this app generates, grouped into the four
// categories the filter tabs use.
const CATEGORY_OF = {
  message: 'messages',
  connection_request: 'requests', connection_accepted: 'requests', follow: 'requests',
  project_request: 'requests', project_request_accepted: 'requests', project_request_rejected: 'requests',
  team_invitation: 'requests', team_invitation_accepted: 'requests', team_invitation_declined: 'requests',
  team_member_left: 'team_updates', team_member_removed: 'team_updates'
};
const CATEGORY_ICON = {
  messages: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5h16a1 1 0 0 1 1 1V16a1 1 0 0 1-1 1H9l-4.5 4V17H4a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1Z"/></svg>',
  requests: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M2.8 19c.6-3.2 3-5 6.2-5s5.6 1.8 6.2 5"/><path d="M18 8v6M15 11h6"/></svg>',
  team_updates: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="13" rx="2.2"/><path d="M8 21h8M12 17v4"/></svg>',
  system: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.2 6.8L21 11l-6.8 2.2L12 20l-2.2-6.8L3 11l6.8-2.2L12 2z"/></svg>'
};
const TITLE = {
  follow: 'New follower', connection_request: 'Connection request', connection_accepted: 'Connection accepted',
  project_request: 'Join request', project_request_accepted: 'Request accepted', project_request_rejected: 'Request declined',
  team_invitation: 'Team invitation', team_invitation_accepted: 'Invitation accepted', team_invitation_declined: 'Invitation declined',
  team_member_removed: 'Team update', team_member_left: 'Team update', message: 'New message'
};

let notifications = [];
let activeTab = 'all';
let sortMode = 'latest';

function categoryOf(n) { return CATEGORY_OF[n.type] || 'system'; }

function avatarOrIcon(n) {
  const category = categoryOf(n);
  if (n.actor && n.actor.photo) return `<img src="${esc(n.actor.photo)}" alt="">`;
  if (n.actor) return esc((n.actor.name || '?')[0].toUpperCase());
  return CATEGORY_ICON[category];
}

function notifRow(n, i = 0) {
  const category = categoryOf(n);
  const unread = !n.read_at;
  const title = TITLE[n.type] || 'Update';
  const meta = n.actor && n.actor.role_title ? `<span class="notif-meta">${esc(n.actor.role_title)}</span>` : '';
  const mutual = n.connection_request && n.connection_request.mutual_connections > 0
    ? `<span class="notif-meta">${n.connection_request.mutual_connections} mutual connection${n.connection_request.mutual_connections === 1 ? '' : 's'}</span>` : '';

  const body = `
    <div class="notif-avatar notif-avatar-${category}">${avatarOrIcon(n)}${unread ? '<span class="notif-dot"></span>' : ''}</div>
    <div class="notif-body">
      <div class="notif-body-top"><strong${unread ? ' class="is-unread"' : ''}>${esc(title)}</strong><span class="notif-time">${timeAgo(n.created_at)}</span></div>
      <p>${esc(n.message)}</p>
      ${meta || mutual ? `<div class="notif-meta-row">${meta}${mutual}</div>` : ''}
    </div>`;

  if (n.connection_request) {
    return `<article class="notif-row notif-row-${category} is-actionable" style="--i:${i % 12}" data-id="${esc(n.id)}">
      ${n.link ? `<a class="notif-row-main" href="${esc(n.link)}">${body}</a>` : `<div class="notif-row-main">${body}</div>`}
      <div class="notif-row-actions">
        <button type="button" class="app-gradient-button notif-accept" data-connection="${esc(n.connection_request.id)}" data-notif="${esc(n.id)}" data-status="accepted">Accept</button>
        <button type="button" class="secondary-button notif-reject" data-connection="${esc(n.connection_request.id)}" data-notif="${esc(n.id)}" data-status="rejected">Reject</button>
      </div>
    </article>`;
  }
  return `<article class="notif-row notif-row-${category}" style="--i:${i % 12}" data-id="${esc(n.id)}">
    ${n.link ? `<a class="notif-row-main notif-row-clickable" href="${esc(n.link)}">${body}<span class="notif-arrow">›</span></a>` : `<div class="notif-row-main">${body}</div>`}
  </article>`;
}

function counts() {
  const c = { all: notifications.length, messages: 0, requests: 0, team_updates: 0, system: 0 };
  notifications.forEach(n => c[categoryOf(n)]++);
  return c;
}

function render() {
  const c = counts();
  $('tabAllCount').textContent = c.all;
  $('tabMsgCount').textContent = c.messages;
  $('tabReqCount').textContent = c.requests;
  $('tabTeamCount').textContent = c.team_updates;
  $('tabSysCount').textContent = c.system;

  const unread = notifications.filter(n => !n.read_at).length;
  $('statMsg').textContent = notifications.filter(n => categoryOf(n) === 'messages' && !n.read_at).length;
  $('statReq').textContent = notifications.filter(n => categoryOf(n) === 'requests' && !n.read_at).length;
  $('statTeam').textContent = notifications.filter(n => categoryOf(n) === 'team_updates' && !n.read_at).length;
  $('statSys').textContent = notifications.filter(n => categoryOf(n) === 'system' && !n.read_at).length;
  $('markAll').hidden = unread === 0;

  let list = activeTab === 'all' ? notifications : notifications.filter(n => categoryOf(n) === activeTab);
  list = list.slice();
  if (sortMode === 'oldest') list.reverse();

  $('feed').innerHTML = list.length
    ? list.map((n, i) => notifRow(n, i)).join('')
    : '<p class="search-empty">Nothing here yet.</p>';
}

async function load() {
  try {
    const data = await api('/api/notifications');
    notifications = data.notifications;
    render();
  } catch (error) {
    $('feed').innerHTML = '<p class="search-empty">Could not load notifications.</p>';
  }
}

$('notifTabs').addEventListener('click', e => {
  const tabBtn = e.target.closest('button[data-tab]');
  if (tabBtn) { activeTab = tabBtn.dataset.tab; document.querySelectorAll('#notifTabs button[data-tab]').forEach(b => b.classList.toggle('is-active', b === tabBtn)); render(); }
});
$('sortSelect').addEventListener('change', () => { sortMode = $('sortSelect').value; render(); });

document.addEventListener('click', async event => {
  const acceptBtn = event.target.closest('.notif-accept, .notif-reject');
  if (acceptBtn) {
    event.preventDefault();
    acceptBtn.closest('.notif-row-actions').querySelectorAll('button').forEach(b => b.disabled = true);
    try {
      await api('/api/connections/' + encodeURIComponent(acceptBtn.dataset.connection), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: acceptBtn.dataset.status })
      });
      await api(`/api/notifications/${encodeURIComponent(acceptBtn.dataset.notif)}/read`, { method: 'PUT' });
      setMessage(acceptBtn.dataset.status === 'accepted' ? 'Connection accepted.' : 'Connection request rejected.', 'success');
      await load();
    } catch (error) {
      setMessage(error.message, 'error');
      acceptBtn.closest('.notif-row-actions').querySelectorAll('button').forEach(b => b.disabled = false);
    }
    return;
  }

  const clickable = event.target.closest('.notif-row-clickable');
  if (clickable) {
    const row = clickable.closest('.notif-row');
    if (row && row.dataset.id) api(`/api/notifications/${encodeURIComponent(row.dataset.id)}/read`, { method: 'PUT' }).catch(() => {});
    return; // real navigation via the anchor's own href
  }

  if (event.target.closest('#markAll')) {
    const button = event.target.closest('#markAll');
    button.disabled = true;
    try { await api('/api/notifications/read', { method: 'PUT' }); await load(); }
    catch (error) { setMessage(error.message, 'error'); button.disabled = false; }
  }
});

load();
