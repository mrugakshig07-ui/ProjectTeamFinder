const $=id=>document.getElementById(id),esc=v=>{const d=document.createElement('div');d.textContent=v||'';return d.innerHTML};
const api=PF.api;
let page=0,activeTab='all',mySignedIn=false;

const STATUS_LABEL={online:'Online',away:'Away',offline:'Offline'};

function statusDot(status){return `<span class="person-status person-status-${status||'offline'}" title="${STATUS_LABEL[status]||'Offline'}"></span>`}

function connectAction(p){
  if(p.connection?.status==='accepted')return `<button class="person-connect is-disabled" disabled>Connected</button>`;
  if(p.connection?.status==='pending')return `<button class="person-connect is-disabled" disabled>${p.connection.direction==='sent'?'Request Sent':'Respond'}</button>`;
  return `<button class="person-connect connect" data-id="${esc(p.public_id)}">Connect</button>`;
}

function card(p,i){
  const rating=p.rating==null?'No ratings yet':`${p.rating} ★`;
  return `<article class="person-card" style="--i:${i%12}">
    <button type="button" class="person-save${p.is_saved?' is-saved':''}" data-save="${esc(p.public_id)}" aria-label="${p.is_saved?'Remove from saved':'Save member'}">
      <svg viewBox="0 0 24 24" fill="${p.is_saved?'currentColor':'none'}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4h12a1 1 0 0 1 1 1v15l-7-4-7 4V5a1 1 0 0 1 1-1Z"/></svg>
    </button>
    <div class="person-top">
      <div class="person-avatar">${p.photo?`<img src="${esc(p.photo)}" alt="">`:'👤'}${statusDot(p.status)}</div>
      <div class="person-id">
        <strong>${esc(p.name)}</strong>
        <span>@${esc(p.username)}</span>
        <span class="person-status-label">${STATUS_LABEL[p.status]||'Offline'}</span>
      </div>
    </div>
    ${p.role_title?`<span class="person-role">${esc(p.role_title)}</span>`:''}
    <div class="person-skills">${p.skills.slice(0,4).map(s=>`<span>${esc(s)}</span>`).join('')}</div>
    <p class="person-bio">${esc(p.bio||'No bio added yet.')}</p>
    <div class="person-stats">
      <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 6.5a1 1 0 0 1 1-1h4.4l1.6 2h9a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-11.5Z"/></svg>${p.projects} Projects</span>
      <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="13" rx="2.2"/><path d="M8 21h8M12 17v4"/></svg>${p.teams} Teams</span>
      <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M2.8 19c.6-3.2 3-5 6.2-5s5.6 1.8 6.2 5"/></svg>${p.followers} Followers</span>
    </div>
    <div class="person-actions">
      ${connectAction(p)}
      <div class="person-menu-wrap">
        <button type="button" class="person-more" data-more aria-haspopup="true" aria-expanded="false">⋯</button>
        <div class="person-menu" hidden>
          <a href="member-profile.html?user=${encodeURIComponent(p.public_id)}">View Profile</a>
          ${p.connection?.status==='accepted'?`<a href="messages.html?start=${encodeURIComponent(p.public_id)}">Message</a>`:''}
          <button type="button" class="follow-toggle ${p.is_following?'is-following':''}" data-follow="${esc(p.public_id)}">${p.is_following?'Unfollow':'Follow'}</button>
        </div>
      </div>
    </div>
  </article>`;
}

function params(){
  const p=new URLSearchParams();
  [['q','q'],['skill','skill'],['education','education'],['rating','min_rating'],['availability','availability']].forEach(([a,b])=>{if($(a).value.trim())p.set(b,$(a).value.trim())});
  const cat=document.querySelector('#categoryPills button.is-active')?.dataset.cat;
  if(cat)p.set('roleCategory',cat);
  const sort=$('sort').value;
  if(sort&&sort!=='relevant')p.set('sort',sort);
  p.set('page',page);
  return p;
}

function setCount(n,label){$('resultCount').textContent=n;$('resultCountLabel').textContent=label||'members found'}

async function loadAll(reset){
  if(reset){page=0;$('results').innerHTML=PF.loading('Loading members…')}
  try{
    const d=await api('/api/members?'+params());
    $('more').hidden=!d.has_more;
    setCount(d.total??d.members.length,'members found');
    $('results').innerHTML=(reset?'':$('results').innerHTML)+(d.members.length?d.members.map(card).join(''):(reset?PF.empty('No members found.','Try clearing a filter or searching for something broader.'):''));
    bind();
  }catch(e){
    if(reset)$('results').innerHTML=PF.failure(e,'members');
    $('more').hidden=true;
  }
}

async function loadSimpleList(endpoint,label){
  $('more').hidden=true;
  $('results').innerHTML=PF.loading('Loading…');
  try{
    const d=await api(endpoint);
    setCount(d.members.length,label);
    $('results').innerHTML=d.members.length?d.members.map(card).join(''):`<p class="search-empty">Nothing here yet.</p>`;
    bind();
  }catch(e){
    $('results').innerHTML=PF.failure(e,'members');
  }
}

function load(reset=false){
  if(activeTab==='all')return loadAll(reset);
  if(activeTab==='connections')return loadSimpleList('/api/members/connections','connections');
  if(activeTab==='following')return loadSimpleList('/api/members/following','following');
}

function bind(){
  document.querySelectorAll('[data-follow]').forEach(b=>b.onclick=async()=>{
    const on=b.classList.contains('is-following');b.disabled=true;
    try{await api('/api/profiles/'+encodeURIComponent(b.dataset.follow)+'/follow',{method:on?'DELETE':'POST'});b.classList.toggle('is-following',!on);b.textContent=on?'Follow':'Unfollow'}
    catch(e){$('message').textContent=e.message;$('message').className='profile-message is-visible is-error'}
    finally{b.disabled=false}
  });
  document.querySelectorAll('.connect').forEach(b=>b.onclick=async()=>{
    b.disabled=true;
    try{await api('/api/profiles/'+encodeURIComponent(b.dataset.id)+'/connect',{method:'POST'});b.textContent='Request Sent';b.classList.add('is-disabled')}
    catch(e){$('message').textContent=e.message;$('message').className='profile-message is-visible is-error';b.disabled=false}
  });
  document.querySelectorAll('[data-save]').forEach(b=>b.onclick=async()=>{
    const on=b.classList.contains('is-saved');b.disabled=true;
    try{await api('/api/profiles/'+encodeURIComponent(b.dataset.save)+'/save',{method:on?'DELETE':'POST'});b.classList.toggle('is-saved',!on);b.querySelector('svg').setAttribute('fill',on?'none':'currentColor')}
    catch(e){/* not signed in, or transient — leave state as-is */}
    finally{b.disabled=false}
  });
  document.querySelectorAll('[data-more]').forEach(b=>b.onclick=e=>{
    e.stopPropagation();
    const menu=b.nextElementSibling,open=!menu.hidden;
    document.querySelectorAll('.person-menu').forEach(m=>m.hidden=true);
    menu.hidden=open;b.setAttribute('aria-expanded',String(!open));
  });
}
document.addEventListener('click',()=>document.querySelectorAll('.person-menu').forEach(m=>m.hidden=true));

function suggestedRow(p){
  return `<div class="suggested-row">
    <a class="suggested-avatar" href="member-profile.html?user=${encodeURIComponent(p.public_id)}">${p.photo?`<img src="${esc(p.photo)}" alt="">`:esc((p.name||'?')[0].toUpperCase())}</a>
    <div class="suggested-text"><strong>${esc(p.name)}</strong><span>@${esc(p.username)}</span><div class="suggested-tags">${p.skills.slice(0,2).map(s=>`<span>${esc(s)}</span>`).join('')}</div></div>
    <button type="button" class="suggested-follow follow-toggle" data-follow="${esc(p.public_id)}">Follow</button>
  </div>`;
}
async function loadSuggested(){
  try{
    const d=await api('/api/members/suggested');
    const emptyMessage=d.reason==='no_skills'?'Add a few skills to your profile to see suggestions.':'No new suggestions right now — you\'re already connected with everyone who shares your skills.';
    $('suggestedList').innerHTML=d.members.length?d.members.map(suggestedRow).join(''):`<p class="search-empty">${emptyMessage}</p>`;
    document.querySelectorAll('#suggestedList [data-follow]').forEach(b=>b.onclick=async()=>{
      b.disabled=true;
      try{await api('/api/profiles/'+encodeURIComponent(b.dataset.follow)+'/follow',{method:'POST'});b.textContent='Following';b.classList.add('is-disabled')}
      catch(e){b.disabled=false}
    });
  }catch(e){
    $('suggestedList').innerHTML='<p class="search-empty">Sign in to see people picked for you.</p>';
  }
}

async function loadStats(){
  try{
    const d=await api('/api/members/stats');
    $('statTotal').textContent=d.stats.total_members;
    $('statOnline').textContent=d.stats.online_now;
    $('statProjects').textContent=d.stats.projects;
    $('statTeams').textContent=d.stats.teams;
  }catch(e){['statTotal','statOnline','statProjects','statTeams'].forEach(id=>$(id).textContent='—')}
}

// ---- filters panel ----
$('filtersToggle').onclick=()=>{
  const open=$('filtersPanel').hidden;
  $('filtersPanel').hidden=!open;
  $('filtersToggle').setAttribute('aria-expanded',String(open));
  $('filtersToggle').classList.toggle('is-open',open);
};

// ---- category pills ----
$('categoryPills').addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b)return;
  document.querySelectorAll('#categoryPills button').forEach(x=>x.classList.toggle('is-active',x===b));
  load(true);
});

// ---- tabs ----
document.querySelector('.findpeople-tabs').addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b)return;
  activeTab=b.dataset.tab;
  document.querySelectorAll('.findpeople-tabs button').forEach(x=>x.classList.toggle('is-active',x===b));
  document.querySelector('.findteams-filter-row').style.display=activeTab==='all'?'':'none';
  $('filtersPanel').hidden=true;
  page=0;load(true);
});

$('sort').onchange=()=>load(true);
$('searchForm').addEventListener('submit',e=>{e.preventDefault();load(true)});
$('searchForm').oninput=PF.debounce(()=>load(true),300);
$('filtersPanel').oninput=PF.debounce(()=>load(true),300);
document.addEventListener('click',e=>{if(e.target.closest('[data-retry]'))load(true)});
$('more').onclick=()=>{page++;load()};
$('exploreMembersBtn').onclick=()=>{document.querySelector('.findteams-main').scrollIntoView({behavior:'smooth',block:'start'})};

load(true);
loadStats();
fetch('/api/me').then(r=>r.ok?r.json():null).then(d=>{if(d?.success){mySignedIn=true;loadSuggested()}else{$('suggestedList').innerHTML='<p class="search-empty">Log in to see people picked for you.</p>'}}).catch(()=>{});
