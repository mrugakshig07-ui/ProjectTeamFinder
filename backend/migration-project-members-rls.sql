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

alter table public.project_members enable row level security;

drop policy if exists "Users can view their own memberships"     on public.project_members;
drop policy if exists "Members and owners can read the roster"   on public.project_members;
drop policy if exists "Membership is created by request or invite" on public.project_members;
drop policy if exists "Owner or the member can end a membership" on public.project_members;
drop policy if exists "Owner or the member can delete a membership" on public.project_members;

create policy "Members and owners can read the roster" on public.project_members
  for select to authenticated
  using (
    auth.uid() = user_id
    or public.owns_project(project_id)
  );

create policy "Membership is created by request or invite" on public.project_members
  for insert to authenticated
  with check (
    (
      public.owns_project(project_id)
      and exists (
        select 1 from public.project_requests r
        where r.project_id = project_members.project_id
          and r.requester_user_id = project_members.user_id
          and r.status in ('pending', 'accepted')
      )
    )
    or
    (
      auth.uid() = user_id
      and exists (
        select 1 from public.project_invitations i
        where i.project_id = project_members.project_id
          and i.invitee_user_id = auth.uid()
          and i.status in ('pending', 'accepted')
      )
    )
  );

create policy "Owner or the member can end a membership" on public.project_members
  for update to authenticated
  using (
    auth.uid() = user_id
    or public.owns_project(project_id)
  )
  with check (
    auth.uid() = user_id
    or public.owns_project(project_id)
  );

create policy "Owner or the member can delete a membership" on public.project_members
  for delete to authenticated
  using (
    auth.uid() = user_id
    or public.owns_project(project_id)
  );

drop policy if exists "Owners can respond to project requests" on public.project_requests;
create policy "Owners can respond to project requests" on public.project_requests
  for update to authenticated
  using (public.owns_project(project_id) and status = 'pending')
  with check (public.owns_project(project_id) and status in ('accepted', 'rejected'));

drop policy if exists "Owners can send invitations"   on public.project_invitations;
drop policy if exists "Owners can cancel invitations" on public.project_invitations;
create policy "Owners can send invitations" on public.project_invitations
  for insert to authenticated
  with check (auth.uid() = inviter_user_id and public.owns_project(project_id));
create policy "Owners can cancel invitations" on public.project_invitations
  for update to authenticated
  using (public.owns_project(project_id) and status = 'pending')
  with check (status = 'cancelled');

drop policy if exists "Public profile columns are readable" on public.profiles;
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

select 'project_members RLS installed. Writes now require ownership or an invitation.' as result;
