-- Patch 1: attendance events now open/close sessions automatically; calmer default match threshold.
create or replace function app.apply_event() returns trigger
  language plpgsql security definer set search_path = public as $$
declare tz text; wd date; sid uuid;
begin
  select timezone into tz from companies where id = new.company_id;
  if new.kind = 'in' then
    wd := (new.occurred_at at time zone coalesce(tz,'Africa/Cairo'))::date;
    -- already inside (double punch or re-sync): ignore
    if exists (select 1 from attendance_sessions where employee_id = new.employee_id and check_out is null) then return new; end if;
    insert into attendance_sessions(company_id, employee_id, work_date, check_in)
      values (new.company_id, new.employee_id, wd, new.occurred_at);
  else
    select id into sid from attendance_sessions
     where employee_id = new.employee_id and check_out is null and check_in < new.occurred_at
     order by check_in desc limit 1;
    if sid is not null then
      update attendance_sessions set check_out = new.occurred_at,
             closed_by = case when new.source = 'face' then 'face' else 'admin' end
       where id = sid;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_apply_event on attendance_events;
create trigger trg_apply_event after insert on attendance_events
  for each row execute function app.apply_event();

alter table company_settings alter column min_match_score set default 0.55;
update company_settings set min_match_score = 0.55 where min_match_score = 0.60;

-- Idempotent kiosk requests (offline retries never create duplicates).
alter table advances       add column if not exists client_request_id uuid;
alter table leave_requests add column if not exists client_request_id uuid;
create unique index if not exists advances_client_req       on advances (company_id, client_request_id);
create unique index if not exists leave_requests_client_req on leave_requests (company_id, client_request_id);
