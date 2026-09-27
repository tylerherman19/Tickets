-- Apply after the 20260910 migrations. Existing rows and destinations are retained.
-- Legacy watches remain active for the service collector until an administrator
-- assigns their owner_id after that person has signed in to Ticketline.
begin;

alter table public.tix_watches add column if not exists owner_id uuid references auth.users(id);
alter table public.tix_watches add column if not exists criteria_version integer not null default 1;
alter table public.tix_watches add column if not exists purchased_at timestamptz;
alter table public.tix_watches add column if not exists purchase_price_cents integer;
create index if not exists tix_watches_owner on public.tix_watches(owner_id, created_at desc);
alter table public.tix_prices add column if not exists criteria_version integer not null default 1;
alter table public.tix_alerts add column if not exists criteria_version integer not null default 1;
alter table public.tix_scans add column if not exists criteria_version integer not null default 1;
alter table public.tix_scans add column if not exists detail jsonb not null default '{}'::jsonb;
alter table public.tix_scans drop constraint if exists tix_scans_outcome_check;
alter table public.tix_scans add constraint tix_scans_outcome_check
  check (outcome in ('ok','unavailable','parser_failure','http_failure','event_unavailable','failed'));
create index if not exists tix_prices_version_time on public.tix_prices(watch_id,criteria_version,checked_at desc);
create index if not exists tix_alerts_version_dedup on public.tix_alerts(watch_id,criteria_version,event_id,club,sent_at desc);

create or replace function public.tix_mark_criteria_changed() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.kind is distinct from old.kind or new.match is distinct from old.match
     or new.clubs is distinct from old.clubs or new.qty is distinct from old.qty
     or new.threshold_cents is distinct from old.threshold_cents
     or new.alert_style is distinct from old.alert_style then
    new.criteria_version := old.criteria_version + 1;
    new.criteria_updated_at := now();
  else
    new.criteria_version := old.criteria_version;
    new.criteria_updated_at := old.criteria_updated_at;
  end if;
  return new;
end;
$$;

-- Remove anonymous watch access before exposing the new authenticated policies.
drop policy if exists "anon manages watches" on public.tix_watches;
drop policy if exists "public read prices" on public.tix_prices;
drop policy if exists "public read alerts" on public.tix_alerts;
drop policy if exists "public read ticket scan status" on public.tix_scans;
drop policy if exists "public read ticket health" on public.tix_state;
revoke all on public.tix_watches, public.tix_prices, public.tix_alerts, public.tix_scans from public, anon;
revoke all on public.tix_state from public, anon, authenticated;
grant select, update on public.tix_watches to authenticated;
grant select on public.tix_prices, public.tix_alerts, public.tix_scans to authenticated;
grant select on public.tix_state to authenticated;
create policy "owners read watches" on public.tix_watches for select to authenticated
 using (owner_id = (select auth.uid()));
create policy "owners update watches" on public.tix_watches for update to authenticated
 using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "owners read prices" on public.tix_prices for select to authenticated
 using (exists (select 1 from public.tix_watches w where w.id = watch_id and w.owner_id = (select auth.uid())));
create policy "owners read alerts" on public.tix_alerts for select to authenticated
 using (exists (select 1 from public.tix_watches w where w.id = watch_id and w.owner_id = (select auth.uid())));
create policy "owners read scans" on public.tix_scans for select to authenticated
 using (exists (select 1 from public.tix_watches w where w.id = watch_id and w.owner_id = (select auth.uid())));
create policy "signed in read health" on public.tix_state for select to authenticated
 using (k in ('collector_health','notification_health'));

-- The older destination RPCs accepted any watch UUID. Revoke them even though
-- their definitions are left in place for migration auditability.
revoke all on function public.tix_save_destination(uuid,text,text,text) from public, anon, authenticated;
revoke all on function public.tix_destination_meta(uuid) from public, anon, authenticated;

create or replace function public.tix_destination_meta(p_watch_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if (select owner_id from public.tix_watches where id = p_watch_id) is distinct from auth.uid()
     or auth.uid() is null then
    raise exception 'Alert not found or not owned by you' using errcode = '42501';
  end if;
  return (select jsonb_build_object('configured', d.watch_id is not null, 'provider', d.provider)
          from public.tix_watches w left join public.tix_destinations d on d.watch_id = w.id
          where w.id = p_watch_id);
end;
$$;
grant execute on function public.tix_destination_meta(uuid) to authenticated;

-- One RPC transaction owns watch, version bump, destination, and confirmation.
create or replace function public.tix_save_alert(p_watch jsonb, p_watch_id uuid default null,
  p_phone text default null, p_provider text default null, p_confirmation_label text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  saved public.tix_watches%rowtype;
  digits text;
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Sign in to save alerts' using errcode = '42501'; end if;
  if (p_watch->>'kind') not in ('event','team','date')
     or (p_watch->>'qty')::integer not between 1 and 8
     or (p_watch->>'threshold_cents')::integer not between 100 and 5000000
     or (p_watch->>'alert_style') not in ('first','repeat')
     or length(trim(coalesce(p_watch->>'label',''))) not between 1 and 140
     or jsonb_typeof(p_watch->'match') is distinct from 'object' then
    raise exception 'Invalid alert criteria';
  end if;
  if p_watch_id is null then
    insert into public.tix_watches(owner_id,label,kind,match,clubs,qty,threshold_cents,alert_style,active)
    values (uid, trim(p_watch->>'label'),p_watch->>'kind',p_watch->'match',
      coalesce(array(select jsonb_array_elements_text(p_watch->'clubs')),'{}'::text[]),
      (p_watch->>'qty')::integer,(p_watch->>'threshold_cents')::integer,
      p_watch->>'alert_style',coalesce((p_watch->>'active')::boolean,true)) returning * into saved;
  else
    update public.tix_watches set label=trim(p_watch->>'label'),kind=p_watch->>'kind',
      match=p_watch->'match',clubs=coalesce(array(select jsonb_array_elements_text(p_watch->'clubs')),'{}'::text[]),
      qty=(p_watch->>'qty')::integer,threshold_cents=(p_watch->>'threshold_cents')::integer,
      alert_style=p_watch->>'alert_style',active=coalesce((p_watch->>'active')::boolean,true)
    where id=p_watch_id and owner_id=uid returning * into saved;
    if saved.id is null then raise exception 'Alert not found or not owned by you' using errcode='42501'; end if;
  end if;
  if nullif(trim(coalesce(p_phone,'')),'') is not null then
    if p_provider not in ('tmobile','verizon','xfinity','uscellular') then
      raise exception 'Choose a supported cell provider';
    end if;
    digits := regexp_replace(p_phone,'[^0-9]','','g');
    if length(digits)=11 and left(digits,1)='1' then digits:=right(digits,10); end if;
    if digits !~ '^[2-9][0-9]{2}[2-9][0-9]{6}$' then
      raise exception 'Enter a valid 10-digit U.S. cell number';
    end if;
    insert into public.tix_destinations(watch_id,phone_digits,provider,updated_at)
    values(saved.id,digits,p_provider,now()) on conflict(watch_id) do update
      set phone_digits=excluded.phone_digits,provider=excluded.provider,updated_at=excluded.updated_at;
    insert into public.tix_confirmation_queue(watch_id,event_label,requested_at,attempts,sent_at,last_error)
    values(saved.id,left(coalesce(nullif(trim(p_confirmation_label),''),saved.label),180),now(),0,null,null)
    on conflict(watch_id) do update set event_label=excluded.event_label,requested_at=excluded.requested_at,
      attempts=0,sent_at=null,last_error=null;
  elsif not exists(select 1 from public.tix_destinations where watch_id=saved.id) then
    raise exception 'Add a notification destination';
  end if;
  return jsonb_build_object('id',saved.id,'criteria_version',saved.criteria_version);
end;
$$;
revoke all on function public.tix_save_alert(jsonb,uuid,text,text,text) from public, anon;
grant execute on function public.tix_save_alert(jsonb,uuid,text,text,text) to authenticated;

-- Security-invoker view respects watch ownership through RLS. All aggregates
-- are scoped to the current criteria_version; older observations remain stored.
create or replace view public.tix_alert_intelligence_v with (security_invoker=true) as
select w.id as watch_id,w.criteria_version,
  s.checked_at as last_checked_at,s.outcome as scan_outcome,s.detail as scan_detail,
  p.price_cents as current_price_cents,p.listing_url,p.event_label,p.club,
  p.checked_at as price_checked_at,
  (select min(x.price_cents) from public.tix_prices x where x.watch_id=w.id and x.criteria_version=w.criteria_version) as all_time_low_cents,
  (select min(x.price_cents) from public.tix_prices x where x.watch_id=w.id and x.criteria_version=w.criteria_version and x.checked_at>=now()-interval '7 days') as low_7d_cents,
  (select max(x.price_cents) from public.tix_prices x where x.watch_id=w.id and x.criteria_version=w.criteria_version and x.checked_at>=now()-interval '7 days') as high_7d_cents,
  (select x.price_cents from public.tix_prices x where x.watch_id=w.id and x.criteria_version=w.criteria_version and x.checked_at<=now()-interval '24 hours' order by x.checked_at desc limit 1) as price_24h_ago_cents
from public.tix_watches w
left join lateral (select * from public.tix_scans s where s.watch_id=w.id and s.criteria_version=w.criteria_version order by s.checked_at desc limit 1) s on true
left join lateral (select * from public.tix_prices p where p.watch_id=w.id and p.criteria_version=w.criteria_version and p.checked_at>=coalesce(s.checked_at,now()-interval '2 hours')-interval '1 second' order by p.price_cents,p.checked_at desc limit 1) p on s.outcome='ok';
grant select on public.tix_alert_intelligence_v to authenticated;

create table if not exists public.tix_event_changes (
  id bigint generated always as identity primary key,
  event_id text not null references public.tix_catalog(event_id),
  detected_at timestamptz not null default now(),
  field text not null check (field in ('datetime_local','event_date','venue')),
  old_value text,
  new_value text
);
create index if not exists tix_event_changes_event on public.tix_event_changes(event_id,detected_at desc);
alter table public.tix_event_changes enable row level security;
revoke all on public.tix_event_changes from public,anon;
grant select on public.tix_event_changes to authenticated;
create policy "signed in read public event changes" on public.tix_event_changes
  for select to authenticated using (true);

create or replace function public.tix_alert_history(p_watch_id uuid,p_range text default '7d',p_version integer default null)
returns table(checked_at timestamptz,price_cents integer,criteria_version integer)
language plpgsql stable security invoker set search_path='' as $$
declare
  since_at timestamptz;
  bucket_seconds integer;
  version_number integer;
begin
  select w.criteria_version into version_number from public.tix_watches w
    where w.id=p_watch_id and w.owner_id=auth.uid();
  if version_number is null then raise exception 'Alert not found or not owned by you' using errcode='42501'; end if;
  version_number := coalesce(p_version,version_number);
  if p_range='24h' then since_at:=now()-interval '24 hours'; bucket_seconds:=900;
  elsif p_range='7d' then since_at:=now()-interval '7 days'; bucket_seconds:=3600;
  elsif p_range='30d' then since_at:=now()-interval '30 days'; bucket_seconds:=14400;
  elsif p_range='all' then
    since_at:='epoch'::timestamptz;
    select greatest(86400,ceil(extract(epoch from now()-min(p.checked_at))/240)::integer)
      into bucket_seconds from public.tix_prices p
      where p.watch_id=p_watch_id and p.criteria_version=version_number;
    bucket_seconds:=coalesce(bucket_seconds,86400);
  else raise exception 'Unsupported chart range'; end if;
  return query select distinct on (floor(extract(epoch from p.checked_at)/bucket_seconds))
    p.checked_at,p.price_cents,p.criteria_version from public.tix_prices p
    where p.watch_id=p_watch_id and p.criteria_version=version_number and p.checked_at>=since_at
    order by floor(extract(epoch from p.checked_at)/bucket_seconds),p.checked_at desc;
end;
$$;
revoke all on function public.tix_alert_history(uuid,text,integer) from public,anon;
grant execute on function public.tix_alert_history(uuid,text,integer) to authenticated;

commit;
