-- ================================================================
-- 11c. TEAM DASHBOARD — tasks, activity feed, files
-- (This is the same block now folded into database-setup.sql — kept
-- here too as a small, easy-to-paste delta so you don't have to run
-- the whole file again.)
-- ================================================================
-- Needed by the policies below (delete-a-task / delete-a-file). Created
-- here with "or replace" so it's safe to run even if it already exists
-- from an earlier migration.
create or replace function public.owns_project(target_project uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.projects p
    where p.id = target_project and p.user_id = auth.uid()
  );
$$;
revoke all on function public.owns_project(uuid) from public;
grant execute on function public.owns_project(uuid) to authenticated;

-- True for the project owner OR anyone with an active (left_at is null)
-- project_members row — the same "is this person actually on the team"
-- check server.js makes in every team-dashboard route.
create or replace function public.is_team_member(target_project uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.projects p where p.id = target_project and p.user_id = auth.uid())
      or exists (select 1 from public.project_members m where m.project_id = target_project and m.user_id = auth.uid() and m.left_at is null);
$$;
revoke all on function public.is_team_member(uuid) from public;
grant execute on function public.is_team_member(uuid) to authenticated;

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null check (length(trim(title)) > 0),
  description text not null default '',
  phase text not null default 'Research & Planning' check (phase in ('Research & Planning', 'Design', 'Development', 'Testing', 'Launch')),
  status text not null default 'todo' check (status in ('todo', 'in_progress', 'done')),
  assignee_user_id uuid references public.profiles(user_id) on delete set null,
  created_by uuid not null references public.profiles(user_id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table public.tasks enable row level security;
drop policy if exists "Team members can view tasks"   on public.tasks;
drop policy if exists "Team members can create tasks"  on public.tasks;
drop policy if exists "Team members can update tasks"  on public.tasks;
drop policy if exists "Creator or owner can delete a task" on public.tasks;
create policy "Team members can view tasks" on public.tasks
  for select to authenticated using (public.is_team_member(project_id));
create policy "Team members can create tasks" on public.tasks
  for insert to authenticated with check (public.is_team_member(project_id) and auth.uid() = created_by);
create policy "Team members can update tasks" on public.tasks
  for update to authenticated using (public.is_team_member(project_id));
create policy "Creator or owner can delete a task" on public.tasks
  for delete to authenticated using (auth.uid() = created_by or public.owns_project(project_id));

create index if not exists idx_tasks_project on public.tasks (project_id, phase);

create table if not exists public.project_activity (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  actor_user_id uuid references public.profiles(user_id) on delete set null,
  type text not null check (type in ('member_joined', 'member_left', 'task_created', 'task_status_changed', 'task_completed', 'file_uploaded')),
  message text not null,
  created_at timestamptz not null default now()
);

alter table public.project_activity enable row level security;
drop policy if exists "Team members can view activity" on public.project_activity;
create policy "Team members can view activity" on public.project_activity
  for select to authenticated using (public.is_team_member(project_id));
-- Inserts always go through the service-role backend (an activity row is a
-- side effect of a real action, never posted directly by a client), so no
-- insert policy is needed for the authenticated role.

create index if not exists idx_project_activity_project on public.project_activity (project_id, created_at desc);

create table if not exists public.project_files (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  uploaded_by uuid not null references public.profiles(user_id) on delete cascade,
  name text not null,
  path text not null,
  size bigint not null default 0,
  content_type text not null default '',
  created_at timestamptz not null default now()
);

alter table public.project_files enable row level security;
drop policy if exists "Team members can view files"   on public.project_files;
drop policy if exists "Team members can add files"    on public.project_files;
drop policy if exists "Uploader or owner can delete a file" on public.project_files;
create policy "Team members can view files" on public.project_files
  for select to authenticated using (public.is_team_member(project_id));
create policy "Team members can add files" on public.project_files
  for insert to authenticated with check (public.is_team_member(project_id) and auth.uid() = uploaded_by);
create policy "Uploader or owner can delete a file" on public.project_files
  for delete to authenticated using (auth.uid() = uploaded_by or public.owns_project(project_id));

create index if not exists idx_project_files_project on public.project_files (project_id, created_at desc);

select 'Team dashboard tables are ready. Restart the backend (npm start).' as result;
