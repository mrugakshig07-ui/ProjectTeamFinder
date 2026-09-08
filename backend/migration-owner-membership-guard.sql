delete from public.project_members m
 using public.projects p
 where p.id = m.project_id
   and p.user_id = m.user_id;

delete from public.project_members m
 where not exists (select 1 from public.projects p where p.id = m.project_id)
    or not exists (select 1 from public.profiles f where f.user_id = m.user_id);

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

select 'Stale rows cleaned and owner-membership guard installed.' as result;
