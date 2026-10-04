-- Patch 2: company-creation codes + platform-owner console.
-- Creating a company now needs a one-time code issued by the platform owner.

create function app.gen_invite_code() returns text language plpgsql as $$
declare c text; i int; chars constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
begin
  loop
    c := '';
    for i in 1..8 loop c := c || substr(chars, 1 + floor(random()*length(chars))::int, 1); end loop;
    c := 'MGZ-' || substr(c,1,4) || '-' || substr(c,5,4);
    exit when not exists (select 1 from public.company_invites where code = c);
  end loop;
  return c;
end $$;

create table if not exists company_invites (
  code        text primary key,
  label       text not null default '',          -- who it is for
  created_at  timestamptz not null default now(),
  revoked     boolean not null default false,
  used_by     uuid references auth.users(id) on delete set null,
  used_at     timestamptz,
  company_id  uuid references companies(id) on delete set null
);
alter table company_invites alter column code set default app.gen_invite_code();
alter table company_invites enable row level security;
drop policy if exists ci_platform on company_invites;
create policy ci_platform on company_invites for all
  using (app.is_platform_owner()) with check (app.is_platform_owner());

-- Replaces the 2-argument version: a valid unused code is required.
drop function if exists public.create_company(text, text);
create function public.create_company(p_company_name text, p_full_name text, p_invite text) returns uuid
  language plpgsql security definer set search_path = public as $$
declare cid uuid; inv company_invites%rowtype;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if exists (select 1 from profiles where id = auth.uid()) then
    raise exception 'this account already belongs to a company';
  end if;
  if length(trim(coalesce(p_company_name,''))) < 2 then raise exception 'company name required'; end if;
  select * into inv from company_invites where code = upper(trim(coalesce(p_invite,''))) for update;
  if not found or inv.revoked then raise exception 'invalid creation code'; end if;
  if inv.used_at is not null then raise exception 'creation code already used'; end if;
  insert into companies(name) values (trim(p_company_name)) returning id into cid;
  insert into profiles(id, company_id, role, full_name, can_approve_leave, can_approve_advance)
    values (auth.uid(), cid, 'owner', trim(p_full_name), true, true);
  update company_invites set used_by = auth.uid(), used_at = now(), company_id = cid where code = inv.code;
  return cid;
end $$;

-- Platform owner: issue / revoke codes, see every company.
create function public.platform_create_invite(p_label text) returns text
  language plpgsql security definer set search_path = public as $$
declare c text;
begin
  if not app.is_platform_owner() then raise exception 'not allowed'; end if;
  insert into company_invites(code, label) values (app.gen_invite_code(), trim(coalesce(p_label,''))) returning code into c;
  return c;
end $$;

create function public.platform_revoke_invite(p_code text) returns void
  language plpgsql security definer set search_path = public as $$
begin
  if not app.is_platform_owner() then raise exception 'not allowed'; end if;
  update company_invites set revoked = true where code = p_code and used_at is null;
end $$;

create function public.platform_overview() returns jsonb
  language plpgsql stable security definer set search_path = public as $$
begin
  if not app.is_platform_owner() then raise exception 'not allowed'; end if;
  return jsonb_build_object(
    'companies', coalesce((select jsonb_agg(x order by x->>'created_at' desc) from (
        select jsonb_build_object(
          'id', c.id, 'name', c.name, 'code', c.code, 'created_at', c.created_at,
          'owner', (select full_name from profiles p where p.company_id = c.id and p.role = 'owner' limit 1),
          'employees', (select count(*) from employees e where e.company_id = c.id and e.active),
          'with_face', (select count(distinct t.employee_id) from face_templates t where t.company_id = c.id),
          'last_punch', (select max(occurred_at) from attendance_events a where a.company_id = c.id)) x
        from companies c) s), '[]'::jsonb),
    'invites', coalesce((select jsonb_agg(to_jsonb(i) order by i.created_at desc) from company_invites i), '[]'::jsonb));
end $$;

revoke all on function public.create_company(text,text,text), public.platform_create_invite(text),
  public.platform_revoke_invite(text), public.platform_overview() from public;
grant execute on function public.create_company(text,text,text), public.platform_create_invite(text),
  public.platform_revoke_invite(text), public.platform_overview() to authenticated;

-- One-time: make YOUR separate account the platform owner (replace the email, run once).
-- insert into profiles(id, company_id, role, full_name)
--   select id, null, 'platform_owner', 'صاحب المنصة' from auth.users where email = 'PUT-YOUR-EMAIL-HERE';
