-- ================================================================
-- ProjectFinder — COMPLETE DATABASE SETUP / REPAIR
-- ================================================================
-- Run this ONCE in Supabase -> SQL Editor -> New query -> Run.
--
-- This one file replaces every other .sql file in this folder.
-- It is fully idempotent: safe on a brand-new project, and safe to
-- re-run on the database you already have. It never drops a table
-- that already has the right shape, so your data is preserved.
--
-- It creates / repairs:
--   profiles, projects, education, skills, user_skills,
--   project_members, user_settings, follows, notifications,
--   connection_requests, project_requests, project_invitations
-- ...plus every index, RLS policy and Storage policy the app needs.
-- ================================================================

-- ================================================================
-- 1. PROFILES  (identity foundation)
-- ================================================================
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  public_id text unique not null,          -- e.g. "PTF-7K29A" - the only id sent to browsers
  username text unique not null,           -- shown as @username
  name text not null,
  email text unique not null,
  bio text not null default '',
  education text not null default '',      -- legacy column, kept for compatibility
  role_title text not null default '',
  skills text not null default '',         -- legacy column, kept for compatibility
  linkedin text not null default '',
  github text not null default '',
  portfolio text not null default '',
  other_website text not null default '',
  photo text not null default '',
  rating numeric,
  created_at timestamptz not null default now()
);

-- Backfill any column an older install is missing.
alter table public.profiles add column if not exists other_website text not null default '';
alter table public.profiles add column if not exists role_title   text not null default '';
alter table public.profiles add column if not exists bio          text not null default '';
alter table public.profiles add column if not exists photo        text not null default '';
alter table public.profiles add column if not exists rating       numeric;
alter table public.profiles add column if not exists last_seen_at timestamptz;

-- An older migration added a CHECK constraint forcing public_id into the
-- "PTF-XXXXX" shape. New IDs are already generated in that shape in code
-- (see uniquePublicId() in server.js), but a handful of accounts created
-- before that scheme predate it and fail the check on every future update
-- to their row — not just to public_id, since Postgres re-validates CHECK
-- constraints against the whole row on any UPDATE. public_id is already
-- unique + not null above, which is all this table actually needs enforced
-- at the database level, so the stale constraint is dropped rather than
-- fixed to match: rewriting a user's permanent public ID to satisfy it
-- would break every link and reference to their profile that already
-- exists.
alter table public.profiles drop constraint if exists profiles_public_id_format;

alter table public.profiles enable row level security;

drop policy if exists "Users can view their own profile"   on public.profiles;
drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can view their own profile" on public.profiles
  for select to authenticated using (auth.uid() = user_id);
create policy "Users can update their own profile" on public.profiles
  for update to authenticated using (auth.uid() = user_id);

create index if not exists idx_profiles_username  on public.profiles (username);
create index if not exists idx_profiles_public_id on public.profiles (public_id);

-- ================================================================
-- 2. PROJECTS
-- ================================================================
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  title text not null,
  description text not null default '',
  skills text not null default '',
  category text not null default '',
  status text not null default 'Open',      -- 'Open' | 'In Progress' | 'On Hold' | 'Closed'
  roles_needed text not null default '',
  availability text not null default '',
  link text not null default '',
  max_members integer not null default 5,
  due_date date,
  progress smallint not null default 0,
  created_at timestamptz not null default now()
);

alter table public.projects add column if not exists max_members integer not null default 5;
alter table public.projects add column if not exists due_date   date;
alter table public.projects add column if not exists progress   smallint not null default 0;

-- Re-assert the range checks without failing if they are already there.
do $$ begin
  alter table public.projects drop constraint if exists projects_max_members_check;
  alter table public.projects add  constraint projects_max_members_check
    check (max_members between 1 and 100);
  alter table public.projects drop constraint if exists projects_progress_check;
  alter table public.projects add  constraint projects_progress_check
    check (progress between 0 and 100);
end $$;

-- The schema here gives public.projects zero triggers on purpose — the
-- owner's membership is implicit (see project_members below) and nothing
-- should auto-insert a project_members row for them. An earlier ad-hoc
-- fix attempt apparently added exactly such a trigger directly in the SQL
-- editor at some point; it is never defined in this file, and it now
-- fights migration-owner-membership-guard.sql's trigger (which correctly
-- rejects an owner ever getting a project_members row), so every new
-- project insert failed with "The project owner is already a participant
-- and must not have a project_members row." Drop whatever user-defined
-- trigger(s) exist here — by this schema's design there should be none.
do $$
declare r record;
begin
  for r in
    select tgname from pg_trigger
    where tgrelid = 'public.projects'::regclass and not tgisinternal
  loop
    raise notice 'Dropping stray trigger on public.projects: %', r.tgname;
    execute format('drop trigger %I on public.projects', r.tgname);
  end loop;
end $$;

alter table public.projects enable row level security;

drop policy if exists "Anyone can view projects"              on public.projects;
drop policy if exists "Users can insert their own projects"   on public.projects;
drop policy if exists "Users can update their own projects"   on public.projects;
drop policy if exists "Users can delete their own projects"   on public.projects;
create policy "Anyone can view projects" on public.projects
  for select using (true);
create policy "Users can insert their own projects" on public.projects
  for insert to authenticated with check (auth.uid() = user_id);
create policy "Users can update their own projects" on public.projects
  for update to authenticated using (auth.uid() = user_id);
create policy "Users can delete their own projects" on public.projects
  for delete to authenticated using (auth.uid() = user_id);

create index if not exists idx_projects_user_id on public.projects (user_id);
create index if not exists idx_projects_status  on public.projects (status, created_at desc);

-- ================================================================
-- 3. EDUCATION / SKILLS
-- ================================================================
create table if not exists public.education (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  institution text not null check (length(trim(institution)) > 0),
  degree_course text not null default '',
  field_of_study text not null default '',
  start_year smallint check (start_year is null or start_year between 1900 and 2200),
  end_year smallint check (end_year is null or end_year between 1900 and 2200),
  currently_studying boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_year is null or start_year is null or end_year >= start_year),
  check (not currently_studying or end_year is null)
);

create table if not exists public.skills (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  normalized_name text generated always as (lower(trim(name))) stored,
  created_at timestamptz not null default now(),
  unique (normalized_name),
  check (length(trim(name)) between 1 and 60)
);

create table if not exists public.user_skills (
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  skill_id uuid not null references public.skills(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, skill_id)
);

alter table public.education   enable row level security;
alter table public.skills      enable row level security;
alter table public.user_skills enable row level security;

drop policy if exists "Users can view their own education"        on public.education;
drop policy if exists "Users can add their own education"         on public.education;
drop policy if exists "Users can update their own education"      on public.education;
drop policy if exists "Users can delete their own education"      on public.education;
create policy "Users can view their own education" on public.education
  for select to authenticated using (auth.uid() = user_id);
create policy "Users can add their own education" on public.education
  for insert to authenticated with check (auth.uid() = user_id);
create policy "Users can update their own education" on public.education
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users can delete their own education" on public.education
  for delete to authenticated using (auth.uid() = user_id);

drop policy if exists "Authenticated users can browse skills" on public.skills;
drop policy if exists "Authenticated users can add skills"    on public.skills;
create policy "Authenticated users can browse skills" on public.skills
  for select to authenticated using (true);
create policy "Authenticated users can add skills" on public.skills
  for insert to authenticated with check (true);

drop policy if exists "Users can view their own skills"   on public.user_skills;
drop policy if exists "Users can add their own skills"    on public.user_skills;
drop policy if exists "Users can remove their own skills" on public.user_skills;
create policy "Users can view their own skills" on public.user_skills
  for select to authenticated using (auth.uid() = user_id);
create policy "Users can add their own skills" on public.user_skills
  for insert to authenticated with check (auth.uid() = user_id);
create policy "Users can remove their own skills" on public.user_skills
  for delete to authenticated using (auth.uid() = user_id);

create index if not exists idx_education_user_id   on public.education (user_id, start_year desc);
create index if not exists idx_user_skills_user_id on public.user_skills (user_id);

-- ================================================================
-- 4. PROJECT MEMBERS  (team rosters)
-- ================================================================
-- The project owner is a participant implicitly and has NO row here.
-- A row means a real additional collaborator. left_at is set instead
-- of deleting the row, so team history survives.
create table if not exists public.project_members (
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  role text not null default 'Member',
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  primary key (project_id, user_id),
  check (left_at is null or left_at >= joined_at)
);

alter table public.project_members enable row level security;

drop policy if exists "Users can view their own memberships" on public.project_members;
create policy "Users can view their own memberships" on public.project_members
  for select to authenticated using (
    auth.uid() = user_id
    or exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid())
  );

create index if not exists idx_project_members_user_id on public.project_members (user_id, left_at);
create index if not exists idx_project_members_project on public.project_members (project_id, left_at);

-- Clears out any row that violates "the owner has no project_members row"
-- (from before this guard existed) and any row left pointing at a project
-- or profile that no longer exists.
delete from public.project_members m
 using public.projects p
 where p.id = m.project_id
   and p.user_id = m.user_id;
delete from public.project_members m
 where not exists (select 1 from public.projects p where p.id = m.project_id)
    or not exists (select 1 from public.profiles f where f.user_id = m.user_id);

-- A pending join request or invitation naming someone already on the roster
-- (from before this guard existed) would be actionable but meaningless.
update public.project_requests r
   set status = 'cancelled', updated_at = now()
 where r.status = 'pending'
   and exists (select 1 from public.project_members m
               where m.project_id = r.project_id
                 and m.user_id = r.requester_user_id
                 and m.left_at is null);
update public.project_invitations i
   set status = 'cancelled', updated_at = now()
 where i.status = 'pending'
   and exists (select 1 from public.project_members m
               where m.project_id = i.project_id
                 and m.user_id = i.invitee_user_id
                 and m.left_at is null);

-- Enforces "the owner is implicit and never has a project_members row" at
-- the database level, not just in application code, so it holds even if a
-- future code path forgets to check.
create or replace function public.reject_owner_membership()
returns trigger
language plpgsql
as $$
begin
  if exists (select 1 from public.projects p
             where p.id = new.project_id and p.user_id = new.user_id) then
    raise exception 'The project owner is already a participant and must not have a project_members row';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_reject_owner_membership on public.project_members;
create trigger trg_reject_owner_membership
  before insert or update on public.project_members
  for each row execute function public.reject_owner_membership();

-- ================================================================
-- 5. USER SETTINGS
-- ================================================================
create table if not exists public.user_settings (
  user_id uuid primary key references public.profiles(user_id) on delete cascade,
  profile_visibility text not null default 'public'   check (profile_visibility in ('public', 'connections', 'private')),
  discoverability text not null default 'everyone'    check (discoverability in ('everyone', 'connections', 'nobody')),
  connection_requests text not null default 'everyone' check (connection_requests in ('everyone', 'connections', 'nobody')),
  show_email boolean not null default false,
  show_profile_details boolean not null default true,
  notify_new_followers boolean not null default true,
  notify_follow_activity boolean not null default true,
  notify_connection_requests boolean not null default true,
  notify_connection_accepted boolean not null default true,
  notify_team_invitations boolean not null default true,
  notify_project_requests boolean not null default true,
  notify_messages boolean not null default true,
  notify_system boolean not null default true,
  appearance text not null default 'system' check (appearance in ('light', 'dark', 'system')),
  updated_at timestamptz not null default now()
);

alter table public.user_settings enable row level security;

drop policy if exists "Users can view their own settings"   on public.user_settings;
drop policy if exists "Users can create their own settings" on public.user_settings;
drop policy if exists "Users can update their own settings" on public.user_settings;
create policy "Users can view their own settings" on public.user_settings
  for select to authenticated using (auth.uid() = user_id);
create policy "Users can create their own settings" on public.user_settings
  for insert to authenticated with check (auth.uid() = user_id);
create policy "Users can update their own settings" on public.user_settings
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ================================================================
-- 6. FOLLOWS
-- ================================================================
create table if not exists public.follows (
  id uuid primary key default gen_random_uuid(),
  follower_user_id uuid not null references public.profiles(user_id) on delete cascade,
  following_user_id uuid not null references public.profiles(user_id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (follower_user_id, following_user_id),
  check (follower_user_id <> following_user_id)
);

alter table public.follows enable row level security;

drop policy if exists "Users can view their own follows"   on public.follows;
drop policy if exists "Users can create their own follows" on public.follows;
drop policy if exists "Users can delete their own follows" on public.follows;
create policy "Users can view their own follows" on public.follows
  for select to authenticated using (auth.uid() = follower_user_id or auth.uid() = following_user_id);
create policy "Users can create their own follows" on public.follows
  for insert to authenticated with check (auth.uid() = follower_user_id and follower_user_id <> following_user_id);
create policy "Users can delete their own follows" on public.follows
  for delete to authenticated using (auth.uid() = follower_user_id);

create index if not exists idx_follows_follower  on public.follows (follower_user_id, created_at desc);
create index if not exists idx_follows_following on public.follows (following_user_id, created_at desc);

-- ================================================================
-- 7. CONNECTION REQUESTS
-- ================================================================
-- An old install may have a connection_requests table with different
-- column names. If sender_user_id is missing, the table is unusable by
-- this app, so it is rebuilt.
do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'connection_requests')
     and not exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'connection_requests'
               and column_name = 'sender_user_id')
  then
    raise notice 'Rebuilding incompatible connection_requests table...';
    drop table public.connection_requests cascade;
  end if;
end $$;

create table if not exists public.connection_requests (
  id uuid primary key default gen_random_uuid(),
  sender_user_id uuid not null references public.profiles(user_id) on delete cascade,
  receiver_user_id uuid not null references public.profiles(user_id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (sender_user_id <> receiver_user_id)
);

alter table public.connection_requests enable row level security;

drop policy if exists "Users can view their own connection requests"    on public.connection_requests;
drop policy if exists "Users can send their own connection requests"    on public.connection_requests;
drop policy if exists "Senders can cancel their own pending requests"   on public.connection_requests;
drop policy if exists "Recipients can respond to their own requests"    on public.connection_requests;
drop policy if exists "Users can remove their own accepted connections" on public.connection_requests;
create policy "Users can view their own connection requests" on public.connection_requests
  for select to authenticated using (auth.uid() = sender_user_id or auth.uid() = receiver_user_id);
create policy "Users can send their own connection requests" on public.connection_requests
  for insert to authenticated with check (auth.uid() = sender_user_id and sender_user_id <> receiver_user_id);
create policy "Senders can cancel their own pending requests" on public.connection_requests
  for update to authenticated using (auth.uid() = sender_user_id and status = 'pending')
  with check (auth.uid() = sender_user_id and status = 'cancelled');
create policy "Recipients can respond to their own requests" on public.connection_requests
  for update to authenticated using (auth.uid() = receiver_user_id and status = 'pending')
  with check (auth.uid() = receiver_user_id and status in ('accepted', 'rejected'));
create policy "Users can remove their own accepted connections" on public.connection_requests
  for update to authenticated using ((auth.uid() = sender_user_id or auth.uid() = receiver_user_id) and status = 'accepted')
  with check ((auth.uid() = sender_user_id or auth.uid() = receiver_user_id) and status = 'cancelled');

create index if not exists idx_connections_sender   on public.connection_requests (sender_user_id, status, created_at desc);
create index if not exists idx_connections_receiver on public.connection_requests (receiver_user_id, status, created_at desc);
-- Only ONE live row per pair: blocks duplicate requests in either direction.
drop index if exists public.idx_connection_pending_pair;
create unique index if not exists idx_connection_live_pair
  on public.connection_requests (least(sender_user_id, receiver_user_id), greatest(sender_user_id, receiver_user_id))
  where status in ('pending', 'accepted');

-- ================================================================
-- 8. PROJECT JOIN REQUESTS  (user -> project owner)
-- ================================================================
create table if not exists public.project_requests (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  requester_user_id uuid not null references public.profiles(user_id) on delete cascade,
  message text not null default '',
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, requester_user_id)
);

alter table public.project_requests add column if not exists message text not null default '';

alter table public.project_requests enable row level security;

drop policy if exists "Users can view their own project requests"      on public.project_requests;
drop policy if exists "Users can create their own project requests"    on public.project_requests;
drop policy if exists "Requesters can cancel their own project requests" on public.project_requests;
drop policy if exists "Owners can respond to project requests"         on public.project_requests;
create policy "Users can view their own project requests" on public.project_requests
  for select to authenticated using (
    auth.uid() = requester_user_id
    or exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid()));
create policy "Users can create their own project requests" on public.project_requests
  for insert to authenticated with check (auth.uid() = requester_user_id);
create policy "Requesters can cancel their own project requests" on public.project_requests
  for update to authenticated using (auth.uid() = requester_user_id and status = 'pending')
  with check (auth.uid() = requester_user_id and status = 'cancelled');
create policy "Owners can respond to project requests" on public.project_requests
  for update to authenticated using (
    exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid())
    and status = 'pending')
  with check (status in ('accepted', 'rejected'));

create index if not exists idx_project_requests_project   on public.project_requests (project_id, status, created_at desc);
create index if not exists idx_project_requests_requester on public.project_requests (requester_user_id, status, created_at desc);

-- ================================================================
-- 9. PROJECT INVITATIONS  (project owner -> user)   *** NEW ***
-- ================================================================
-- The mirror image of project_requests: the owner starts it, and the
-- invited member is the one who accepts or declines.
create table if not exists public.project_invitations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  inviter_user_id uuid not null references public.profiles(user_id) on delete cascade,
  invitee_user_id uuid not null references public.profiles(user_id) on delete cascade,
  role text not null default 'Member',
  message text not null default '',
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, invitee_user_id),
  check (inviter_user_id <> invitee_user_id)
);

alter table public.project_invitations enable row level security;

drop policy if exists "Members and owners can view invitations" on public.project_invitations;
drop policy if exists "Owners can send invitations"             on public.project_invitations;
drop policy if exists "Invitees can respond to invitations"     on public.project_invitations;
drop policy if exists "Owners can cancel invitations"           on public.project_invitations;
create policy "Members and owners can view invitations" on public.project_invitations
  for select to authenticated using (
    auth.uid() = invitee_user_id
    or exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid()));
create policy "Owners can send invitations" on public.project_invitations
  for insert to authenticated with check (
    auth.uid() = inviter_user_id
    and exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid()));
create policy "Invitees can respond to invitations" on public.project_invitations
  for update to authenticated using (auth.uid() = invitee_user_id and status = 'pending')
  with check (auth.uid() = invitee_user_id and status in ('accepted', 'declined'));
create policy "Owners can cancel invitations" on public.project_invitations
  for update to authenticated using (
    status = 'pending'
    and exists (select 1 from public.projects p where p.id = project_id and p.user_id = auth.uid()))
  with check (status = 'cancelled');

create index if not exists idx_project_invitations_invitee on public.project_invitations (invitee_user_id, status, created_at desc);
create index if not exists idx_project_invitations_project on public.project_invitations (project_id, status, created_at desc);

-- ================================================================
-- 9b. DEFENSE-IN-DEPTH RLS
-- ================================================================
-- The backend always queries through the service-role key, which bypasses
-- RLS — every real permission check happens in server.js. These policies
-- are a second, independent layer that holds even if a client ever queried
-- Supabase directly with a user's own key instead of through the app.
-- Placed here (not with their tables above) because they reference
-- project_requests and project_invitations, which must already exist.
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

drop policy if exists "Users can view their own memberships"       on public.project_members;
drop policy if exists "Members and owners can read the roster"     on public.project_members;
drop policy if exists "Membership is created by request or invite" on public.project_members;
drop policy if exists "Owner or the member can end a membership"   on public.project_members;
drop policy if exists "Owner or the member can delete a membership" on public.project_members;

create policy "Members and owners can read the roster" on public.project_members
  for select to authenticated
  using (auth.uid() = user_id or public.owns_project(project_id));

create policy "Membership is created by request or invite" on public.project_members
  for insert to authenticated
  with check (
    (
      public.owns_project(project_id)
      and exists (select 1 from public.project_requests r
                  where r.project_id = project_members.project_id
                    and r.requester_user_id = project_members.user_id
                    and r.status in ('pending', 'accepted'))
    )
    or
    (
      auth.uid() = user_id
      and exists (select 1 from public.project_invitations i
                  where i.project_id = project_members.project_id
                    and i.invitee_user_id = auth.uid()
                    and i.status in ('pending', 'accepted'))
    )
  );

create policy "Owner or the member can end a membership" on public.project_members
  for update to authenticated
  using (auth.uid() = user_id or public.owns_project(project_id))
  with check (auth.uid() = user_id or public.owns_project(project_id));

create policy "Owner or the member can delete a membership" on public.project_members
  for delete to authenticated
  using (auth.uid() = user_id or public.owns_project(project_id));

-- profiles started out visible only to their own owner (section 1), which
-- was correct for a table with no visibility settings yet. user_settings
-- (section 5) now carries that, so replace it with the real rule: hidden
-- only if the owner marked their profile private or undiscoverable.
drop policy if exists "Users can view their own profile"       on public.profiles;
drop policy if exists "Public profile columns are readable"    on public.profiles;
create policy "Public profile columns are readable" on public.profiles
  for select to authenticated
  using (
    auth.uid() = user_id
    or not exists (
      select 1 from public.user_settings s
      where s.user_id = profiles.user_id
        and (s.profile_visibility = 'private' or s.discoverability = 'nobody')
    )
  );

-- ================================================================
-- 10. NOTIFICATIONS
-- ================================================================
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_user_id uuid not null references public.profiles(user_id) on delete cascade,
  actor_user_id uuid references public.profiles(user_id) on delete cascade,
  follow_id uuid references public.follows(id) on delete cascade,
  type text not null,
  message text not null,
  link text not null default '',
  read_at timestamptz,
  created_at timestamptz not null default now()
);

-- Link columns for every notification source (added separately so an
-- existing notifications table gains whatever it is missing).
alter table public.notifications add column if not exists connection_request_id  uuid references public.connection_requests(id)  on delete cascade;
alter table public.notifications add column if not exists project_request_id     uuid references public.project_requests(id)     on delete cascade;
alter table public.notifications add column if not exists project_invitation_id  uuid references public.project_invitations(id)  on delete cascade;
alter table public.notifications add column if not exists link                   text not null default '';

-- An older install had `follow_id uuid unique`, which wrongly allowed only
-- one notification per follow row. Drop that constraint if it exists.
do $$ declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'public.notifications'::regclass and contype = 'u'
     and pg_get_constraintdef(oid) like '%follow_id%';
  if c is not null then execute format('alter table public.notifications drop constraint %I', c); end if;
end $$;

-- Widen the type check so every notification the app sends is allowed.
do $$ declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'public.notifications'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) like '%type%';
  if c is not null then execute format('alter table public.notifications drop constraint %I', c); end if;
  alter table public.notifications add constraint notifications_type_check check (type in (
    'follow',
    'connection_request', 'connection_accepted',
    'project_request', 'project_request_accepted', 'project_request_rejected',
    'team_invitation', 'team_invitation_accepted', 'team_invitation_declined',
    'team_member_removed', 'team_member_left',
    'message',
    'system'
  ));
end $$;

alter table public.notifications enable row level security;

drop policy if exists "Users can view their own notifications"   on public.notifications;
drop policy if exists "Users can update their own notifications" on public.notifications;
create policy "Users can view their own notifications" on public.notifications
  for select to authenticated using (auth.uid() = recipient_user_id);
create policy "Users can update their own notifications" on public.notifications
  for update to authenticated using (auth.uid() = recipient_user_id) with check (auth.uid() = recipient_user_id);

create index if not exists idx_notifications_recipient on public.notifications (recipient_user_id, created_at desc);
create index if not exists idx_notifications_unread    on public.notifications (recipient_user_id) where read_at is null;

-- ================================================================
-- 11. MESSAGING  (direct messages between connections)
-- ================================================================
-- One conversation per pair of users. dm_key is the two user ids sorted
-- and joined, so "find or create the conversation with this person" is a
-- single unique-constrained insert rather than a race-prone lookup.
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  dm_key text unique not null,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);

create table if not exists public.conversation_participants (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  last_read_at timestamptz,
  primary key (conversation_id, user_id)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_user_id uuid not null references public.profiles(user_id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  check (char_length(body) between 1 and 4000)
);

alter table public.conversations enable row level security;
alter table public.conversation_participants enable row level security;
alter table public.messages enable row level security;

drop policy if exists "Participants can view their conversations" on public.conversations;
create policy "Participants can view their conversations" on public.conversations
  for select to authenticated using (
    exists (select 1 from public.conversation_participants cp where cp.conversation_id = id and cp.user_id = auth.uid())
  );

drop policy if exists "Participants can view the participant list"  on public.conversation_participants;
drop policy if exists "Users can update their own read marker"      on public.conversation_participants;
create policy "Participants can view the participant list" on public.conversation_participants
  for select to authenticated using (
    exists (select 1 from public.conversation_participants me where me.conversation_id = conversation_id and me.user_id = auth.uid())
  );
create policy "Users can update their own read marker" on public.conversation_participants
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "Participants can view messages"  on public.messages;
drop policy if exists "Participants can send messages"  on public.messages;
create policy "Participants can view messages" on public.messages
  for select to authenticated using (
    exists (select 1 from public.conversation_participants cp where cp.conversation_id = conversation_id and cp.user_id = auth.uid())
  );
create policy "Participants can send messages" on public.messages
  for insert to authenticated with check (
    auth.uid() = sender_user_id
    and exists (select 1 from public.conversation_participants cp where cp.conversation_id = conversation_id and cp.user_id = auth.uid())
  );

create index if not exists idx_messages_conversation  on public.messages (conversation_id, created_at);
create index if not exists idx_conv_participants_user on public.conversation_participants (user_id);

-- ================================================================
-- 11b. SAVED MEMBERS  (the bookmark icon on a member card)
-- ================================================================
create table if not exists public.saved_members (
  user_id uuid not null references public.profiles(user_id) on delete cascade,
  saved_user_id uuid not null references public.profiles(user_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, saved_user_id),
  check (user_id <> saved_user_id)
);

alter table public.saved_members enable row level security;

drop policy if exists "Users can view their own saved members"   on public.saved_members;
drop policy if exists "Users can save a member"                  on public.saved_members;
drop policy if exists "Users can unsave a member"                on public.saved_members;
create policy "Users can view their own saved members" on public.saved_members
  for select to authenticated using (auth.uid() = user_id);
create policy "Users can save a member" on public.saved_members
  for insert to authenticated with check (auth.uid() = user_id);
create policy "Users can unsave a member" on public.saved_members
  for delete to authenticated using (auth.uid() = user_id);

create index if not exists idx_saved_members_user on public.saved_members (user_id);

-- ================================================================
-- 11c. TEAM DASHBOARD — tasks, activity feed, files
-- ================================================================
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

-- ================================================================
-- 12. STORAGE — "avatars" bucket policies
-- ================================================================
-- The bucket itself is created by the backend on startup
-- (server.js -> ensureAvatarBucket). These policies make Storage's own
-- row-level security match the app's rules.
do $$ begin
  drop policy if exists "Avatar images are publicly readable" on storage.objects;
  drop policy if exists "Users can upload their own avatar"   on storage.objects;
  drop policy if exists "Users can replace their own avatar"  on storage.objects;
  drop policy if exists "Users can delete their own avatar"   on storage.objects;

  create policy "Avatar images are publicly readable" on storage.objects
    for select using (bucket_id = 'avatars');
  create policy "Users can upload their own avatar" on storage.objects
    for insert to authenticated with check (bucket_id = 'avatars' and name = auth.uid()::text || '.jpg');
  create policy "Users can replace their own avatar" on storage.objects
    for update to authenticated using (bucket_id = 'avatars' and name = auth.uid()::text || '.jpg');
  create policy "Users can delete their own avatar" on storage.objects
    for delete to authenticated using (bucket_id = 'avatars' and name = auth.uid()::text || '.jpg');
exception when insufficient_privilege then
  raise notice 'Skipped storage policies (not enough privileges). Add them from Storage -> Policies if photo upload fails.';
end $$;

-- "team-files" (Team dashboard -> Files) is a *private* bucket, unlike
-- avatars: nothing in it is meant to be public. The browser never talks to
-- Storage directly for it — every upload/download/delete goes through the
-- backend's own service-role client, which already checks team membership
-- in server.js. A private bucket with no anon/authenticated policies at
-- all is simpler and just as secure as writing path-parsing RLS here, so
-- none is added. The bucket itself is created on startup
-- (server.js -> ensureTeamFilesBucket).

-- ================================================================
-- 13. BACKFILL — give every existing profile a settings row
-- ================================================================
insert into public.user_settings (user_id)
select p.user_id from public.profiles p
where not exists (select 1 from public.user_settings s where s.user_id = p.user_id);

select 'ProjectFinder database is ready. Restart the backend (npm start).' as result;
