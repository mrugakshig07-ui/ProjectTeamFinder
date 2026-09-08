// Team Dashboard: one page per team — roster, project progress, tasks,
// files and activity, all scoped to a single project.
const $ = id => document.getElementById(id);
const esc = v => { const d = document.createElement('div'); d.textContent = v == null ? '' : v; return d.innerHTML; };
async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({ success: false, message: 'The server sent an unreadable response.' }));
  if (!data.success) throw new Error(data.message || 'Request failed.');
  return data;
}

const projectId = new URLSearchParams(location.search).get('id');
const avatar = person => person && person.photo ? `<img src="${esc(person.photo)}" alt="">` : '👤';
const profileLink = person => `member-profile.html?user=${encodeURIComponent(person.public_id)}`;
const STATUS_TONE = { Open: 'is-open', 'In Progress': 'is-progress', 'On Hold': 'is-hold', Closed: 'is-closed' };
const TASK_PHASES = ['Research & Planning', 'Design', 'Development', 'Testing', 'Launch'];
const TASK_STATUS_LABEL = { todo: 'To Do', in_progress: 'In Progress', done: 'Done' };
const ACTIVITY_ICON = {
  member_joined: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M2.8 19c.6-3.2 3-5 6.2-5s5.6 1.8 6.2 5"/><path d="M18 8v6M15 11h6"/></svg>',
  member_left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M2.8 19c.6-3.2 3-5 6.2-5s5.6 1.8 6.2 5"/><path d="M15 8h6"/></svg>',
  task_created: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3.5" width="16" height="17" rx="2.2"/><path d="M8.5 9h7M8.5 13h7M8.5 17h4"/></svg>',
  task_status_changed: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  task_completed: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5 9 17l10.5-10.5"/></svg>',
  file_uploaded: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 6.5a1 1 0 0 1 1-1h4.4l1.6 2h9a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-11.5Z"/></svg>'
};

function timeAgo(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function setMessage(text, kind) {
  const el = $('tdMessage');
  el.textContent = text || '';
  el.className = 'profile-message' + (text ? ' is-visible' : '') + (kind === 'error' ? ' is-error' : kind === 'success' ? ' is-success' : '');
  if (text) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

let dashboard = null;
let myPublicId = null;

if (!projectId) {
  initPicker();
} else {
  $('teamdashPicker').hidden = true;
  $('teamdashState').hidden = false;
  fetch('/api/me').then(r => r.json()).then(d => { if (d.success) myPublicId = d.user.public_id; }).catch(() => {}).finally(loadDashboard);
}

async function loadDashboard() {
  try {
    const d = await api(`/api/projects/${encodeURIComponent(projectId)}/team-dashboard`);
    dashboard = d;
    renderHeader();
    $('teamdashState').hidden = true;
    $('teamdashApp').hidden = false;
    await Promise.all([loadTasks(), loadFiles(), loadActivity()]);
    loadSwitcher();
  } catch (error) {
    $('teamdashState').innerHTML = `<div class="state state-error"><p>${esc(error.message)}</p><div class="state-actions"><a class="secondary-button" href="team-dashboard.html">Back to My Teams</a></div></div>`;
  }
}

// ---- team switcher (dashboard mode only): jump straight to another team ----
async function loadSwitcher() {
  const select = $('tdSwitcher');
  try {
    const { teams } = await api('/api/my-teams');
    select.innerHTML = '<option value="">Switch team…</option>' + teams.map(t =>
      `<option value="${esc(t.project.id)}"${t.project.id === projectId ? ' selected' : ''}>${esc(t.project.title)}</option>`).join('');
  } catch (_) { /* the switcher is a convenience; a failed fetch just leaves it at the default option */ }
}
$('tdSwitcher').addEventListener('change', () => {
  const id = $('tdSwitcher').value;
  if (id && id !== projectId) location.href = `team-dashboard.html?id=${encodeURIComponent(id)}`;
});

function dueLabel(d) {
  if (!d) return '';
  const date = new Date(d + 'T00:00:00'), now = new Date(); now.setHours(0, 0, 0, 0);
  const days = Math.round((date - now) / 86400000);
  const formatted = date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  if (days < 0) return `Overdue · ${formatted}`;
  if (days === 0) return `Due today`;
  return `Due ${formatted}`;
}

function renderHeader() {
  const { project, team_code, viewer, roster, stats } = dashboard;
  document.title = `${project.title} · Team Dashboard · ProjectFinder`;
  $('tdTitle').textContent = project.title;
  $('tdStatus').textContent = project.status;
  $('tdStatus').className = 'status-pill ' + (STATUS_TONE[project.status] || '');
  $('tdCode').textContent = `Team Code: ${team_code}`;
  $('tdSize').textContent = `${stats.total_members} member${stats.total_members === 1 ? '' : 's'}`;
  if (project.due_date) { $('tdDue').hidden = false; $('tdDue').textContent = dueLabel(project.due_date); } else { $('tdDue').hidden = true; }
  $('tdViewProjectBtn').href = `project.html?id=${encodeURIComponent(project.id)}`;
  $('qaViewProject').href = `project.html?id=${encodeURIComponent(project.id)}`;
  $('tdInviteBtn').hidden = !viewer.is_owner;
  $('tdInviteForm').hidden = !viewer.is_owner;
  $('qaInvite').hidden = !viewer.is_owner;

  $('tdMemberCount').textContent = roster.length;
  $('tdMembers').innerHTML = roster.map((p, i) => `
    <article class="teamdash-member-card" style="--i:${i % 12}">
      <a class="teamdash-member-top" href="${profileLink(p)}">
        <div class="member-avatar">${avatar(p)}<span class="person-status person-status-${p.status || 'offline'}"></span></div>
        <div><strong>${esc(p.name)}</strong><span>@${esc(p.username)}</span></div>
      </a>
      <div class="teamdash-member-tags">
        <span class="team-role-badge${p.is_owner ? ' is-owner' : ''}">${esc(p.team_role)}</span>
        ${p.role_title ? `<span class="person-role">${esc(p.role_title)}</span>` : ''}
      </div>
      <div class="teamdash-member-actions">
        <a class="text-button" href="${profileLink(p)}">View Profile</a>
        ${p.public_id !== myPublicId ? `<a class="text-button" href="messages.html?start=${encodeURIComponent(p.public_id)}">Message</a>` : ''}
      </div>
    </article>`).join('');

  $('tdDescription').textContent = project.description || 'No description added yet.';
  $('tdProgressLabel').textContent = `${project.progress || 0}%`;
  $('tdProgressBar').style.width = `${project.progress || 0}%`;

  const assigneeSelect = $('tdTaskAssignee');
  assigneeSelect.innerHTML = '<option value="">Unassigned</option>' + roster.map(p => `<option value="${esc(p.public_id)}">${esc(p.name)}</option>`).join('');
  $('tdTaskPhase').innerHTML = TASK_PHASES.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');

  refreshStats();
}

function refreshStats() {
  const { stats, project } = dashboard;
  $('tdStatMembers').textContent = stats.total_members;
  $('tdStatInProgress').textContent = stats.tasks_in_progress;
  $('tdStatDone').textContent = stats.tasks_completed;
  $('tdStatProgress').textContent = `${project.progress || 0}%`;
}

function renderPhaseBreakdown(tasks) {
  const byPhase = new Map(TASK_PHASES.map(p => [p, { total: 0, done: 0 }]));
  tasks.forEach(t => { const bucket = byPhase.get(t.phase) || byPhase.get(TASK_PHASES[0]); bucket.total++; if (t.status === 'done') bucket.done++; });
  $('tdPhaseBreakdown').innerHTML = TASK_PHASES.map(phase => {
    const { total, done } = byPhase.get(phase);
    const pct = total ? Math.round((done / total) * 100) : 0;
    return `<div class="teamdash-phase-row">
      <div class="teamdash-phase-row-head"><span>${esc(phase)}</span><span>${total ? `${done}/${total} tasks` : 'No tasks yet'}</span></div>
      <div class="myprojects-progress-bar teamdash-phase-bar"><span style="width:${pct}%"></span></div>
    </div>`;
  }).join('');
}

// ---- Tasks ----
let allTasks = [];
async function loadTasks() {
  try {
    const { tasks } = await api(`/api/projects/${encodeURIComponent(projectId)}/tasks`);
    allTasks = tasks;
    dashboard.stats.tasks_total = tasks.length;
    dashboard.stats.tasks_in_progress = tasks.filter(t => t.status === 'in_progress').length;
    dashboard.stats.tasks_completed = tasks.filter(t => t.status === 'done').length;
    refreshStats();
    renderPhaseBreakdown(tasks);
    renderTasks();
  } catch (error) {
    $('tdTasks').innerHTML = `<p class="search-empty">${esc(error.message)}</p>`;
  }
}

function taskCard(t, i) {
  return `<article class="teamdash-task-card" style="--i:${i % 12}" data-task="${esc(t.id)}">
    <div class="teamdash-task-top">
      <strong>${esc(t.title)}</strong>
      ${t.can_manage ? `<button type="button" class="teamdash-task-delete" data-delete-task="${esc(t.id)}" aria-label="Delete task">✕</button>` : ''}
    </div>
    ${t.description ? `<p>${esc(t.description)}</p>` : ''}
    <div class="teamdash-task-foot">
      <span class="teamdash-phase-tag">${esc(t.phase)}</span>
      <select class="teamdash-status-select" data-status-task="${esc(t.id)}">
        ${Object.entries(TASK_STATUS_LABEL).map(([v, l]) => `<option value="${v}"${t.status === v ? ' selected' : ''}>${l}</option>`).join('')}
      </select>
      ${t.assignee ? `<span class="teamdash-task-assignee" title="${esc(t.assignee.name)}">${avatar(t.assignee)}</span>` : ''}
    </div>
  </article>`;
}

function renderTasks() {
  $('tdTaskCount').textContent = allTasks.length;
  $('tdTasks').innerHTML = allTasks.length
    ? allTasks.map(taskCard).join('')
    : '<p class="search-empty">No tasks yet. Add the first one above.</p>';
}

$('tdAddTaskForm').addEventListener('submit', async e => {
  e.preventDefault();
  const title = $('tdTaskTitle').value.trim();
  if (!title) return;
  const button = e.target.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api(`/api/projects/${encodeURIComponent(projectId)}/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, phase: $('tdTaskPhase').value, assigneePublicId: $('tdTaskAssignee').value })
    });
    $('tdTaskTitle').value = '';
    await loadTasks();
  } catch (error) { setMessage(error.message, 'error'); }
  finally { button.disabled = false; }
});

document.addEventListener('change', async e => {
  if (e.target.matches('[data-status-task]')) {
    const id = e.target.dataset.statusTask;
    e.target.disabled = true;
    try {
      await api(`/api/tasks/${encodeURIComponent(id)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: e.target.value })
      });
      await loadTasks();
    } catch (error) { setMessage(error.message, 'error'); }
    finally { e.target.disabled = false; }
  }
});

document.addEventListener('click', async e => {
  const delBtn = e.target.closest('[data-delete-task]');
  if (delBtn) {
    if (!confirm('Delete this task?')) return;
    try { await api(`/api/tasks/${encodeURIComponent(delBtn.dataset.deleteTask)}`, { method: 'DELETE' }); await loadTasks(); }
    catch (error) { setMessage(error.message, 'error'); }
  }
});

// ---- Files ----
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function loadFiles() {
  try {
    const { files } = await api(`/api/projects/${encodeURIComponent(projectId)}/files`);
    $('tdFileCount').textContent = files.length;
    $('tdFiles').innerHTML = files.length ? files.map((f, i) => `
      <article class="teamdash-file-row" style="--i:${i % 12}">
        <span class="teamdash-file-icon">${ACTIVITY_ICON.file_uploaded}</span>
        <div class="teamdash-file-info">
          <strong>${f.url ? `<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.name)}</a>` : esc(f.name)}</strong>
          <span>${formatSize(f.size)} · uploaded by ${f.uploaded_by ? esc(f.uploaded_by.name) : 'someone'} · ${timeAgo(f.created_at)}</span>
        </div>
        ${f.can_delete ? `<button type="button" class="text-button" data-delete-file="${esc(f.id)}">Delete</button>` : ''}
      </article>`).join('') : '<p class="search-empty">No files uploaded yet.</p>';
  } catch (error) {
    $('tdFiles').innerHTML = `<p class="search-empty">${esc(error.message)}</p>`;
  }
}

$('tdUploadBtn').addEventListener('click', () => $('tdFileInput').click());
$('tdFileInput').addEventListener('change', async () => {
  const file = $('tdFileInput').files[0];
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) { setMessage('File must be smaller than 20MB.', 'error'); $('tdFileInput').value = ''; return; }
  const reader = new FileReader();
  reader.onload = async () => {
    $('tdUploadBtn').disabled = true;
    try {
      await api(`/api/projects/${encodeURIComponent(projectId)}/files`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileDataUrl: reader.result, name: file.name })
      });
      await loadFiles();
      setMessage('File uploaded.', 'success');
    } catch (error) { setMessage(error.message, 'error'); }
    finally { $('tdUploadBtn').disabled = false; $('tdFileInput').value = ''; }
  };
  reader.readAsDataURL(file);
});

document.addEventListener('click', async e => {
  const delBtn = e.target.closest('[data-delete-file]');
  if (delBtn) {
    if (!confirm('Delete this file?')) return;
    try { await api(`/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(delBtn.dataset.deleteFile)}`, { method: 'DELETE' }); await loadFiles(); }
    catch (error) { setMessage(error.message, 'error'); }
  }
});

// ---- Activity ----
async function loadActivity() {
  try {
    const { activity } = await api(`/api/projects/${encodeURIComponent(projectId)}/activity`);
    $('tdActivity').innerHTML = activity.length ? activity.map((a, i) => `
      <article class="teamdash-activity-row" style="--i:${i % 12}">
        <span class="teamdash-activity-icon">${ACTIVITY_ICON[a.type] || ACTIVITY_ICON.task_created}</span>
        <div><p>${esc(a.message)}</p><span>${timeAgo(a.created_at)}</span></div>
      </article>`).join('') : '<p class="search-empty">Nothing has happened here yet.</p>';
  } catch (error) {
    $('tdActivity').innerHTML = `<p class="search-empty">${esc(error.message)}</p>`;
  }
}

// ---- Invite ----
async function sendInvite() {
  const publicId = $('tdInviteInput').value.trim();
  if (!publicId) { setMessage('Enter the public ID or @username of the person you want to invite.', 'error'); return; }
  $('tdInviteSend').disabled = true;
  try {
    const result = await api(`/api/projects/${encodeURIComponent(projectId)}/invite`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicId, role: $('tdInviteRole').value.trim() })
    });
    $('tdInviteInput').value = ''; $('tdInviteRole').value = '';
    setMessage(result.message || 'Invitation sent.', 'success');
  } catch (error) { setMessage(error.message, 'error'); }
  finally { $('tdInviteSend').disabled = false; }
}
$('tdInviteSend').addEventListener('click', sendInvite);
$('tdInviteBtn').addEventListener('click', () => { switchTab('team'); $('tdInviteInput').focus(); });
$('qaInvite').addEventListener('click', () => { switchTab('team'); $('tdInviteInput').focus(); });

// ---- Share link ----
function shareLink() {
  const url = location.href;
  navigator.clipboard?.writeText(url).then(
    () => setMessage('Team link copied to clipboard.', 'success'),
    () => setMessage(url, 'success')
  ).catch(() => setMessage(url, 'success'));
}
$('tdShareBtn').addEventListener('click', shareLink);
$('qaShare').addEventListener('click', shareLink);

// ---- Tabs ----
function switchTab(tab) {
  document.querySelectorAll('#teamdashTabs button').forEach(b => b.classList.toggle('is-active', b.dataset.tab === tab));
  document.querySelectorAll('.teamdash-panel').forEach(p => p.hidden = p.dataset.panel !== tab);
}
$('teamdashTabs').addEventListener('click', e => {
  const btn = e.target.closest('button'); if (!btn) return;
  switchTab(btn.dataset.tab);
});

// =================================================================
// PICKER MODE (no ?id=) — every team you're in, invitations waiting on
// you, and join requests waiting on you. Replaces the old My Teams page.
// =================================================================
function setPickerMessage(text, kind) {
  const el = $('tpMessage');
  el.textContent = text || '';
  el.className = 'profile-message' + (text ? ' is-visible' : '') + (kind === 'error' ? ' is-error' : kind === 'success' ? ' is-success' : '');
  if (text) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function switchCard(team, i = 0) {
  const seats = team.project.max_members ? `${team.team_size}/${team.project.max_members} members` : `${team.team_size} members`;
  return `<a class="teamdash-switch-card" style="--i:${i % 12}" href="team-dashboard.html?id=${encodeURIComponent(team.project.id)}">
    <div class="teamdash-switch-top">
      <h3>${esc(team.project.title)}</h3>
      <span class="status-pill ${STATUS_TONE[team.project.status] || ''}">${esc(team.project.status)}</span>
    </div>
    <div class="teamdash-switch-tags">
      <span class="teamdash-chip">${esc(seats)}</span>
      ${team.is_owner ? '<span class="team-owner-tag">You own this project</span>' : ''}
    </div>
    <span class="teamdash-switch-open">Open Dashboard →</span>
  </a>`;
}

function invitationCard(invitation, i = 0) {
  const inviter = invitation.profile;
  return `<article class="connection-row" style="--i:${i % 12}">
    <a class="connection-left" href="${inviter ? profileLink(inviter) : '#'}">
      <div class="member-avatar">${inviter ? avatar(inviter) : '👤'}</div>
      <div>
        <strong>${esc(invitation.project.title)}</strong>
        <span>${inviter ? `${esc(inviter.name)} (@${esc(inviter.username)})` : 'A member'} invited you as ${esc(invitation.role || 'Member')}</span>
        ${invitation.message ? `<span>“${esc(invitation.message)}”</span>` : ''}
      </div>
    </a>
    <div class="connection-actions">
      <button class="accept-button" data-invitation="${esc(invitation.id)}" data-status="accepted">Accept</button>
      <button class="decline-button" data-invitation="${esc(invitation.id)}" data-status="declined">Decline</button>
    </div>
  </article>`;
}

function requestCard(request, i = 0) {
  return `<article class="connection-row" style="--i:${i % 12}">
    <a class="connection-left" href="${profileLink(request.profile)}">
      <div class="member-avatar">${avatar(request.profile)}</div>
      <div>
        <strong>${esc(request.profile.name)}</strong>
        <span>@${esc(request.profile.username)} asked to join ${esc(request.project_title)}</span>
        ${request.message ? `<span>“${esc(request.message)}”</span>` : ''}
      </div>
    </a>
    <div class="connection-actions">
      <button class="accept-button" data-request="${esc(request.id)}" data-status="accepted">Accept</button>
      <button class="decline-button" data-request="${esc(request.id)}" data-status="rejected">Reject</button>
    </div>
  </article>`;
}

async function refreshPicker() {
  await Promise.all([loadPickerTeams(), loadPickerInvitations(), loadPickerRequests()]);
}

async function loadPickerTeams() {
  try {
    const { teams } = await api('/api/my-teams');
    $('tpTeamCount').textContent = teams.length;
    $('tpTeams').innerHTML = teams.length
      ? teams.map(switchCard).join('')
      : '<p class="search-empty">You\'re not part of any teams yet. Post a project, or ask to join one from Find Teams.</p>';
  } catch (error) {
    $('tpTeams').innerHTML = '<p class="search-empty">Could not load your teams.</p>';
    $('tpTeamCount').textContent = '0';
    setPickerMessage(error.message, 'error');
  }
}

async function loadPickerInvitations() {
  try {
    const { invitations } = await api('/api/my-invitations');
    $('tpInviteCount').textContent = invitations.length;
    $('tpInvitations').innerHTML = invitations.length
      ? invitations.map(invitationCard).join('')
      : '<p class="search-empty">No invitations waiting for you.</p>';
  } catch (error) {
    $('tpInvitations').innerHTML = '<p class="search-empty">Could not load your invitations.</p>';
    $('tpInviteCount').textContent = '0';
  }
}

async function loadPickerRequests() {
  try {
    const { requests } = await api('/api/my-project-requests');
    $('tpReqCount').textContent = requests.length;
    $('tpRequests').innerHTML = requests.length
      ? requests.map(requestCard).join('')
      : '<p class="search-empty">No pending join requests.</p>';
  } catch (error) {
    $('tpRequests').innerHTML = '<p class="search-empty">Could not load join requests.</p>';
    $('tpReqCount').textContent = '0';
  }
}

function initPicker() {
  document.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button) return;

    const act = async (work, successText) => {
      button.disabled = true;
      setPickerMessage('');
      try {
        const result = await work();
        setPickerMessage(successText || (result && result.message) || '', 'success');
        await refreshPicker();
      } catch (error) {
        setPickerMessage(error.message, 'error');
        button.disabled = false;
      }
    };

    if (button.dataset.invitation) {
      return act(() => api(`/api/project-invitations/${encodeURIComponent(button.dataset.invitation)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: button.dataset.status })
      }));
    }
    if (button.dataset.request) {
      return act(() => api(`/api/project-requests/${encodeURIComponent(button.dataset.request)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: button.dataset.status })
      }));
    }
  });

  refreshPicker();
}
