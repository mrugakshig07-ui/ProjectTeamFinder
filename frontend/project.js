// Project detail: full description, the team roster, and the right action for
// whoever is looking at it (owner / member / invited / can request to join).
const $ = id => document.getElementById(id);
const esc = v => { const d = document.createElement('div'); d.textContent = v == null ? '' : v; return d.innerHTML; };
const projectId = new URLSearchParams(location.search).get('id');

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
}

function statusLabel(status) {
  return status === 'Open' ? 'Recruiting' : status === 'Closed' ? 'Completed' : status;
}

function memberRow(person) {
  return `<article class="connection-row">
    <a class="connection-left" href="member-profile.html?user=${encodeURIComponent(person.public_id || '')}">
      <div class="member-avatar">${person.photo ? `<img src="${esc(person.photo)}" alt="">` : '👤'}</div>
      <div>
        <strong>${esc(person.name || 'ProjectFinder member')}</strong>
        <span>@${esc(person.username || '')}</span>
      </div>
    </a>
    <div class="connection-actions">
      <span class="team-role-badge${person.team_role === 'Owner' ? ' is-owner' : ''}">${esc(person.team_role)}</span>
    </div>
  </article>`;
}

// The single call-to-action that matches the viewer's actual state.
function action(project, viewer) {
  if (!viewer.signed_in) return '<a class="primary-button" href="login.html">Log in to join</a>';
  if (viewer.is_owner) return `<a class="secondary-button" href="team-dashboard.html?id=${encodeURIComponent(projectId)}">Manage your team</a>`;
  if (viewer.is_member) return `<a class="secondary-button" href="team-dashboard.html?id=${encodeURIComponent(projectId)}">You are on this team</a>`;
  if (viewer.invitation_status === 'pending') return '<a class="primary-button" href="team-dashboard.html">You are invited — respond</a>';
  if (viewer.request_status === 'pending') return '<button class="secondary-button" disabled>Request sent</button>';
  if (viewer.request_status === 'rejected') return '<button class="secondary-button" disabled>Request declined</button>';
  if (project.status !== 'Open') return '<button class="secondary-button" disabled>Not recruiting</button>';
  if (project.seats_left === 0) return '<button class="secondary-button" disabled>Team is full</button>';
  return `<button class="primary-button" id="requestJoin">Request to join</button>`;
}

async function load() {
  if (!projectId) { $('content').textContent = 'No project was specified.'; return; }
  try {
    const { project, team, viewer } = await api('/api/projects/' + encodeURIComponent(projectId));
    const owner = project.profiles || {};
    const seats = project.max_members ? `${project.team_size}/${project.max_members} members` : `${project.team_size} members`;

    $('content').innerHTML = `
      <div class="project-top">
        <span class="project-tag">${esc(project.category || 'PROJECT')}</span>
        <span class="members">${esc(statusLabel(project.status))}</span>
      </div>
      <h1>${esc(project.title)}</h1>
      <p>${esc(project.description || 'No description yet.')}</p>
      <div class="skills">${(project.skills || '').split(',').filter(Boolean).map(s => `<span>${esc(s.trim())}</span>`).join('')}</div>
      <div class="project-meta">
        <span>Roles: ${esc(project.roles_needed || 'Not specified')}</span>
        <span>${esc(seats)}</span>
        <span>${esc(project.availability || 'Availability not specified')}</span>
      </div>
      ${project.link ? `<p class="project-meta"><a href="${esc(project.link)}" target="_blank" rel="noopener">Project link</a></p>` : ''}
      <p class="project-meta">Owner: <a href="member-profile.html?user=${encodeURIComponent(owner.public_id || '')}">${esc(owner.name || 'ProjectFinder member')}</a></p>
      <div class="member-actions">${action(project, viewer)}</div>`;

    $('team').innerHTML = team.map(memberRow).join('');
    if ($('teamCount')) $('teamCount').textContent = team.length;

    const join = $('requestJoin');
    if (join) join.onclick = async () => {
      join.disabled = true;
      setMessage('');
      try {
        const result = await api(`/api/projects/${encodeURIComponent(projectId)}/request`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
        });
        setMessage(result.message || 'Join request sent.', 'success');
        await load();
      } catch (error) {
        setMessage(error.message, 'error');
        join.disabled = false;
      }
    };
  } catch (error) {
    $('content').textContent = error.message;
  }
}

load();
