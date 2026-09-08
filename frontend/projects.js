const $=id=>document.getElementById(id),esc=v=>{const d=document.createElement('div');d.textContent=v||'';return d.innerHTML};let page=0;
const api=PF.api;

// A few pastel-to-brand gradients, cycled by index, standing in for a cover
// photo (there is no cover-image field on a project — this is an honest
// placeholder, not a fake photo).
const BANNER_GRADIENTS=[
  'linear-gradient(135deg,#6a5cf0,#8e6bd8)','linear-gradient(135deg,#3a3f6b,#5a4f8f)',
  'linear-gradient(135deg,#c2447a,#8e3fae)','linear-gradient(135deg,#3f6b8f,#5a3f8f)',
  'linear-gradient(135deg,#8f5f3f,#c2447a)','linear-gradient(135deg,#2f7f6b,#3f6b8f)'
];
function bannerFor(id){let h=0;for(const ch of String(id))h=(h*31+ch.charCodeAt(0))>>>0;return BANNER_GRADIENTS[h%BANNER_GRADIENTS.length]}

function timeAgo(iso){
  const then=new Date(iso),now=new Date(),secs=Math.max(0,Math.round((now-then)/1000));
  const mins=Math.round(secs/60),hrs=Math.round(mins/60),days=Math.round(hrs/24),weeks=Math.round(days/7),months=Math.round(days/30);
  if(secs<60)return'just now';
  if(mins<60)return mins+'m ago';
  if(hrs<24)return hrs+'h ago';
  if(days===1)return'1 day ago';
  if(days<7)return days+' days ago';
  if(weeks===1)return'1 week ago';
  if(weeks<5)return weeks+' weeks ago';
  return months<=1?'1 month ago':months+' months ago';
}

function joinPill(p){
  if(p.is_owner)return `<a class="team-pill" href="my-projects.html">Yours</a>`;
  if(p.is_member)return `<a class="team-pill" href="team-dashboard.html?id=${encodeURIComponent(p.id)}">Joined</a>`;
  if(p.invitation_status==='pending')return `<a class="team-pill" href="team-dashboard.html">Invited</a>`;
  if(p.request_status==='pending')return `<span class="team-pill is-disabled">Requested</span>`;
  if(p.request_status==='accepted')return `<span class="team-pill is-disabled">Joined</span>`;
  if(p.request_status==='rejected')return `<span class="team-pill is-disabled">Declined</span>`;
  if(p.status!=='Open')return `<span class="team-pill is-disabled">${esc(p.status)}</span>`;
  if(p.max_members&&p.team_size>=p.max_members)return `<span class="team-pill is-disabled">Full</span>`;
  return `<button type="button" class="team-pill request" data-id="${esc(p.id)}">Join</button>`;
}

function avatarStack(list){
  const shown=(list||[]).slice(0,3);
  const extra=(list||[]).length-shown.length;
  return `<div class="team-avatars">
    ${shown.map(a=>`<span class="team-avatar" title="${esc(a.name||'')}">${a.photo?`<img src="${esc(a.photo)}" alt="">`:esc((a.name||'?')[0].toUpperCase())}</span>`).join('')}
    ${extra>0?`<span class="team-avatar team-avatar-more">+${extra}</span>`:''}
  </div>`;
}

function teamCard(p,i){
  const tags=(p.skills||'').split(',').map(s=>s.trim()).filter(Boolean).slice(0,3);
  return `<article class="team-card" style="--i:${i%12}">
    <div class="team-card-banner" style="background:${bannerFor(p.id)}">
      ${joinPill(p)}
      ${avatarStack(p.member_avatars)}
    </div>
    <div class="team-card-body">
      <h3><a href="project.html?id=${encodeURIComponent(p.id)}">${esc(p.title)}</a></h3>
      <p>${esc(p.description||'No description yet.')}</p>
      ${tags.length?`<div class="team-card-tags">${tags.map(t=>`<span>${esc(t)}</span>`).join('')}</div>`:''}
      <div class="team-card-foot">
        <span>${p.team_size}${p.max_members?`/${p.max_members}`:''} members</span>
        <span>Created ${timeAgo(p.created_at)}</span>
      </div>
    </div>
  </article>`;
}

function params(){const p=new URLSearchParams;['q','category','skills','roles','status','availability'].forEach(k=>{if($(k).value.trim())p.set(k,$(k).value.trim())});p.set('page',page);return p}

async function load(reset=false){
  if(reset){page=0;$('list').innerHTML=PF.loading('Loading projects…')}
  try{
    const data=await api('/api/projects/discover?'+params());
    $('more').hidden=!data.has_more;
    $('list').innerHTML=(reset?'':$('list').innerHTML)+(data.projects.length?data.projects.map(teamCard).join(''):(reset?PF.empty('No teams found.','Try clearing a filter or searching for something broader.'):''));
    bindJoinButtons();
  }catch(error){
    if(reset)$('list').innerHTML=PF.failure(error,'projects');
    $('more').hidden=true;
  }
}

function bindJoinButtons(){
  document.querySelectorAll('.request').forEach(button=>button.onclick=async()=>{
    button.disabled=true;
    try{
      await api('/api/projects/'+button.dataset.id+'/request',{method:'POST'});
      button.textContent='Requested';button.classList.add('is-disabled');button.classList.remove('request');
    }catch(error){
      $('message').textContent=error.message;$('message').className='profile-message is-visible is-error';button.disabled=false;
    }
  });
}

async function loadPreview(gridId,extraParams){
  const grid=$(gridId);
  try{
    const qs=new URLSearchParams(extraParams||{});qs.set('page','0');
    const data=await api('/api/projects/discover?'+qs.toString());
    grid.innerHTML=data.projects.length?data.projects.slice(0,4).map(teamCard).join(''):'<p class="search-empty">Nothing here yet.</p>';
    bindJoinButtons();
  }catch(error){
    grid.innerHTML='<p class="search-empty">Could not load this right now.</p>';
  }
}

async function loadStats(){
  try{
    const d=await api('/api/teams/stats');
    $('statActive').textContent=d.stats.active_teams;
    $('statMembers').textContent=d.stats.total_members;
    $('statProjects').textContent=d.stats.projects_started;
    $('statNew').textContent=d.stats.new_today;
  }catch(error){
    ['statActive','statMembers','statProjects','statNew'].forEach(id=>$(id).textContent='—');
  }
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
  $('category').value=b.dataset.cat;
  load(true);
});

// ---- "View all" preview links ----
document.querySelectorAll('[data-view-all]').forEach(a=>a.addEventListener('click',e=>{
  e.preventDefault();
  if(a.dataset.viewAll==='open'){$('status').value='Open';load(true)}
  $('allResultsSection').scrollIntoView({behavior:'smooth',block:'start'});
}));

$('searchForm').addEventListener('submit',e=>{e.preventDefault();load(true)});
$('searchForm').oninput=PF.debounce(()=>load(true),300);
$('filtersPanel').oninput=PF.debounce(()=>load(true),300);
document.addEventListener('click',e=>{if(e.target.closest('[data-retry]'))load(true)});
$('more').onclick=()=>{page++;load()};

load(true);
loadPreview('featuredGrid',{});
loadPreview('openGrid',{status:'Open'});
loadStats();
