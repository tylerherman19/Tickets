-- Apply after 20261012_guarded_history.sql. Idempotent.
--
-- Turns guarded collection on at the owner-approved budget (5,000 provider
-- page requests per day) and makes a signed-in search price its results
-- immediately:
--  * Foreground work (searches, opened events, alerts, targeted sweeps) can use
--    the whole budget; background coverage (catalog, discovery) stops at
--    background_share of every window so a search is never starved.
--  * Several captures may run at once (max_concurrent); one lease per event.
--  * Background checks no longer fill the request queue (queue_full) and a
--    long browsing session no longer blocks tracking (tracking_limit).
--  * Opened events are tracked and re-checked on a cadence; search results are
--    priced once without being tracked.
--  * Team, artist and show pages price many events per request and add daily
--    get-in history for near-term events.
begin;

alter table public.tix_provider_guard drop constraint if exists tix_provider_guard_minute_limit_check;
alter table public.tix_provider_guard drop constraint if exists tix_provider_guard_hour_limit_check;
alter table public.tix_provider_guard drop constraint if exists tix_provider_guard_day_limit_check;
alter table public.tix_provider_guard add constraint tix_provider_guard_minute_limit_check check(minute_limit between 1 and 60);
alter table public.tix_provider_guard add constraint tix_provider_guard_hour_limit_check check(hour_limit between 1 and 1000);
alter table public.tix_provider_guard add constraint tix_provider_guard_day_limit_check check(day_limit between 1 and 10000);
alter table public.tix_provider_guard add column if not exists background_share numeric not null default 0.75;
alter table public.tix_provider_guard add column if not exists max_concurrent integer not null default 6;
alter table public.tix_provider_guard drop constraint if exists tix_provider_guard_background_share_check;
alter table public.tix_provider_guard add constraint tix_provider_guard_background_share_check check(background_share>0 and background_share<=1);
alter table public.tix_provider_guard drop constraint if exists tix_provider_guard_max_concurrent_check;
alter table public.tix_provider_guard add constraint tix_provider_guard_max_concurrent_check check(max_concurrent between 1 and 12);
-- Owner-approved release: 40/minute, 420/hour, 5,000/day. A suspension caused
-- by provider blocking is left untouched; only an operator clears it.
update public.tix_provider_guard set enabled=true,allow_catalog=true,canary_event_ids='{}',
 minute_limit=40,hour_limit=420,day_limit=5000 where id;

-- detail_requested now means "a one-off check was requested and is pending";
-- it is cleared when a capture is saved. Background checks never set it.
alter table public.tix_capture_jobs alter column detail_requested set default false;
update public.tix_capture_jobs set detail_requested=false where detail_requested;
create index if not exists tix_history_tracking_owner_time on public.tix_history_tracking(owner_id,created_at);

create or replace function public.tix_claim_capture(p_event_id text,p_source text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare g public.tix_provider_guard; token uuid; e public.tix_catalog; sample public.tix_event_observations; j public.tix_capture_jobs; active integer;
begin
 perform pg_advisory_xact_lock(72634112);
 select * into g from public.tix_provider_guard where id;
 if not coalesce(g.enabled,false) or g.suspended_at is not null then return jsonb_build_object('state','suspended','reason',coalesce(g.suspension_reason,'rollout_disabled')); end if;
 if p_source not in ('edge','collector','detail','catalog','discovery','tracked') then raise exception 'Invalid capture source'; end if;
 if p_event_id is null and not g.allow_catalog then return jsonb_build_object('state','queued','reason','catalog_disabled'); end if;
 if p_event_id is not null and cardinality(g.canary_event_ids)>0 and not(p_event_id=any(g.canary_event_ids)) then return jsonb_build_object('state','queued','reason','outside_canary'); end if;
 if p_event_id is not null then
  select * into e from public.tix_catalog where event_id=p_event_id;
  if e.event_id is null or e.event_date<current_date then return jsonb_build_object('state','expired'); end if;
  if e.event_date>current_date+365 then return jsonb_build_object('state','beyond_horizon'); end if;
  select * into j from public.tix_capture_jobs where event_id=p_event_id;
  select * into sample from public.tix_event_observations where event_id=p_event_id and state<>'failed' order by checked_at desc limit 1;
  -- A recent saved price answers a search or history check without another
  -- provider request. Alert checks and detail passes need listings, so only a
  -- recent complete/empty listing set satisfies them.
  if p_source in ('edge','discovery','tracked') and e.min_total>0 and e.price_checked_at>now()-interval '15 minutes' then
   update public.tix_capture_jobs set next_attempt_at=greatest(next_attempt_at,e.price_checked_at+interval '15 minutes') where event_id=p_event_id and not detail_requested;
   return jsonb_build_object('state','cached','min_total',e.min_total,'checked_at',e.price_checked_at,'observation_id',sample.id);
  end if;
  if sample.checked_at>now()-interval '15 minutes' and (p_source in ('edge','discovery','tracked') or sample.state in ('complete','empty')) then
   return jsonb_build_object('state','cached','min_total',coalesce(sample.min_total,e.min_total),'checked_at',sample.checked_at,'observation_id',sample.id);
  end if;
  -- Backoff after a failure or request limit applies to every source. The
  -- tracking cadence applies only to tracked history and discovery; alert
  -- checks keep their own cadence.
  if j.next_attempt_at>now() and p_source<>'catalog' and (j.reason is not null or p_source in ('tracked','discovery')) then
   return jsonb_build_object('state','queued','reason',coalesce(j.reason,'scheduled'),'next_attempt_at',j.next_attempt_at);
  end if;
 end if;
 update public.tix_capture_jobs set state='failed',reason='capture_timeout' where state='checking' and event_id in (select event_id from public.tix_capture_leases where expires_at<=now());
 delete from public.tix_capture_leases where expires_at<=now();
 delete from public.tix_provider_http where at<now()-interval '2 days';
 select count(*) into active from public.tix_capture_leases;
 if active>=g.max_concurrent or (p_event_id is not null and exists(select 1 from public.tix_capture_leases where event_id=p_event_id)) then
  return jsonb_build_object('state','queued','reason','provider_busy','next_attempt_at',now()+interval '5 seconds');
 end if;
 insert into public.tix_capture_leases(event_id,source,expires_at) values(p_event_id,p_source,now()+interval '60 seconds') returning tix_capture_leases.token into token;
 if p_event_id is not null then
  insert into public.tix_capture_jobs(event_id,state,last_attempt_at,detail_requested) values(p_event_id,'checking',now(),false)
  on conflict(event_id) do update set state='checking',last_attempt_at=now(),reason=null;
 end if;
 return jsonb_build_object('state','checking','token',token);
end $$;

-- Rolling windows across every source. Background sources stop at
-- background_share of each limit, leaving the rest for foreground work.
create or replace function public.tix_admit_provider_http(p_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare g public.tix_provider_guard; l public.tix_capture_leases; n1 integer;n2 integer;n3 integer; m1 integer;m2 integer;m3 integer; share numeric; wait_at timestamptz;
begin
 perform pg_advisory_xact_lock(72634112);
 select * into g from public.tix_provider_guard where id;
 select * into l from public.tix_capture_leases where token=p_token and expires_at>now();
 if l.token is null or not g.enabled or g.suspended_at is not null then return jsonb_build_object('allowed',false,'reason','suspended_or_lease_expired'); end if;
 share:=case when l.source in ('catalog','discovery') then g.background_share else 1 end;
 m1:=greatest(1,floor(g.minute_limit*share)::integer);m2:=greatest(1,floor(g.hour_limit*share)::integer);m3:=greatest(1,floor(g.day_limit*share)::integer);
 select count(*) filter(where at>now()-interval '1 minute'),count(*) filter(where at>now()-interval '1 hour'),count(*) into n1,n2,n3
 from public.tix_provider_http where at>now()-interval '1 day';
 if n1>=m1 or n2>=m2 or n3>=m3 then
  select max(reset_at) into wait_at from (
   select min(at)+interval '1 minute' reset_at from public.tix_provider_http where at>now()-interval '1 minute' and n1>=m1
   union all select min(at)+interval '1 hour' from public.tix_provider_http where at>now()-interval '1 hour' and n2>=m2
   union all select min(at)+interval '1 day' from public.tix_provider_http where at>now()-interval '1 day' and n3>=m3) x;
  update public.tix_capture_jobs set state='queued',reason='request_limit',next_attempt_at=wait_at+interval '1 second' where event_id=l.event_id;
  return jsonb_build_object('allowed',false,'reason','request_limit','next_attempt_at',wait_at+interval '1 second');
 end if;
 insert into public.tix_provider_http(lease_token,event_id,source) values(p_token,l.event_id,l.source);
 update public.tix_capture_leases set expires_at=now()+interval '60 seconds' where token=p_token;
 return jsonb_build_object('allowed',true);
end $$;

-- A request-limit release keeps the admission's short reset time so a search
-- can retry within the minute, instead of a 15-minute failure backoff.
create or replace function public.tix_release_capture(p_token uuid,p_reason text default null)
returns void language plpgsql security definer set search_path='' as $$
begin
 if p_reason='capture_failed' then
  insert into public.tix_event_observations(event_id,source,state,meta)
  select l.event_id,l.source,'failed',jsonb_build_object('reason',p_reason) from public.tix_capture_leases l
  join public.tix_catalog c on c.event_id=l.event_id where l.token=p_token;
 end if;
 update public.tix_capture_jobs set state=case when p_reason='request_limit' then 'queued' else 'failed' end,
  reason=coalesce(p_reason,'capture_interrupted'),
  next_attempt_at=case when p_reason='request_limit' then greatest(next_attempt_at,now()+interval '5 seconds') else greatest(next_attempt_at,now()+interval '15 minutes') end
 where state in ('checking','queued') and event_id=(select event_id from public.tix_capture_leases where token=p_token);
 delete from public.tix_capture_leases where token=p_token;
end $$;

create or replace function public.tix_save_capture(p_token uuid,p_capture jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare l public.tix_capture_leases; oid uuid; item jsonb; pos bigint; s text:=p_capture->>'state'; ts timestamptz:=now(); next_at timestamptz; raw jsonb; price integer:=(p_capture->>'min_total')::integer;
begin
 perform pg_advisory_xact_lock(72634112);
 select * into l from public.tix_capture_leases where token=p_token and expires_at>now();
 if l.event_id is null then raise exception 'Capture lease expired'; end if;
 if p_capture->'meta'->>'event_id' is distinct from l.event_id then raise exception 'Event ID mismatch'; end if;
 if s not in ('complete','partial','empty','metadata_only') then raise exception 'Invalid inventory state'; end if;
 if jsonb_typeof(p_capture->'listings')<>'array' or jsonb_array_length(p_capture->'listings')>10000 then raise exception 'Invalid listing array'; end if;
 insert into public.tix_event_observations(event_id,source,format,state,min_total,listing_count,meta,coverage,by_qty)
 values(l.event_id,l.source,p_capture->>'format',s,price,
 jsonb_array_length(p_capture->'listings'),p_capture->'meta',p_capture->'coverage',p_capture->'by_qty') returning id into oid;
 for item,pos in select value,ordinality from jsonb_array_elements(p_capture->'listings') with ordinality loop
  raw:=item->'provider';
  insert into public.tix_listing_observations(observation_id,ordinal,listing_id,price_cents,basis,prefee_cents,sales_tax_cents,pre_tax_total_cents,lots,seats,section_group,section,row_label,verified_quantity,provider)
  values(oid,pos,item->>'listing_id',(item->>'price_cents')::integer,item->>'basis',(item->>'prefee_cents')::integer,(item->>'sales_tax_cents')::integer,(item->>'pre_tax_total_cents')::integer,
  case when jsonb_typeof(item->'lots')='array' then array(select jsonb_array_elements_text(item->'lots')::integer) end,raw->'seats',item->>'section_group',item->>'section',item->>'row_label',(item->>'verified_quantity')::integer,raw);
 end loop;
 -- A metadata-only page without a get-in amount is not evidence of a new
 -- price: keep the saved price and its timestamp.
 if s='metadata_only' and price is null then
  update public.tix_catalog set discovery_attempt_at=ts where event_id=l.event_id;
 else
  update public.tix_catalog set price_checked_at=ts,discovery_attempt_at=ts,discovery_status=case when s='metadata_only' then 'metadata_only' else 'ok' end,
  min_total=price where event_id=l.event_id;
 end if;
 if s<>'metadata_only' then
  insert into public.tix_event_market(event_id,checked_at,by_qty,groups,listing_count,coverage)
  values(l.event_id,ts,p_capture->'by_qty',p_capture->'groups',jsonb_array_length(p_capture->'listings'),p_capture->'coverage')
  on conflict(event_id) do update set checked_at=excluded.checked_at,by_qty=excluded.by_qty,groups=excluded.groups,listing_count=excluded.listing_count,coverage=excluded.coverage;
 end if;
 -- Tracked history cadence: tighter close to the event, sparse far out.
 select ts+case when event_date<=current_date+2 then interval '15 minutes' when event_date<=current_date+14 then interval '1 hour'
  when event_date<=current_date+60 then interval '3 hours' else interval '12 hours' end into next_at from public.tix_catalog where event_id=l.event_id;
 update public.tix_capture_jobs set state=s,reason=null,detail_requested=false,next_attempt_at=next_at,last_attempt_at=ts where event_id=l.event_id;
 return oid;
end $$;

-- Opening an event tracks it for the signed-in owner. The most recently
-- opened 200 events stay tracked; older ones roll off instead of blocking.
create or replace function public.tix_request_capture(p_event_id text,p_details boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare e public.tix_catalog; j public.tix_capture_jobs; uid uuid:=auth.uid();
begin
 if uid is null then raise exception 'Sign in to refresh prices and save history' using errcode='42501'; end if;
 select * into e from public.tix_catalog where event_id=p_event_id;
 if e.event_id is null then return jsonb_build_object('state','failed','reason','event_not_found'); end if;
 if e.event_date<current_date then return jsonb_build_object('state','expired'); end if;
 if e.event_date>current_date+365 then return jsonb_build_object('state','beyond_horizon'); end if;
 perform pg_advisory_xact_lock(hashtext(uid::text));
 insert into public.tix_history_tracking(owner_id,event_id) values(uid,p_event_id)
 on conflict(owner_id,event_id) do update set created_at=now();
 delete from public.tix_history_tracking t where t.owner_id=uid and t.event_id in (
  select event_id from public.tix_history_tracking where owner_id=uid order by created_at desc offset 200);
 insert into public.tix_capture_jobs(event_id,detail_requested,state) values(p_event_id,coalesce(p_details,false),'queued')
 on conflict(event_id) do update set detail_requested=public.tix_capture_jobs.detail_requested or excluded.detail_requested;
 select * into j from public.tix_capture_jobs where event_id=p_event_id;
 return jsonb_build_object('state',j.state,'reason',j.reason,'next_attempt_at',j.next_attempt_at,'tracked',true);
end $$;

-- Fallback while the Edge route is unavailable: one pending check per event,
-- picked up by the next collector run. Never tracks the event.
create or replace function public.tix_request_price_check(p_event_id text)
returns boolean language plpgsql security definer set search_path='' as $$
declare changed integer;
begin
 if auth.uid() is null or p_event_id is null or p_event_id !~ '^[0-9a-f]{24}$' then return false; end if;
 if not exists(select 1 from public.tix_catalog where event_id=p_event_id and event_date between current_date and current_date+365) then return false; end if;
 if (select count(*) from public.tix_capture_jobs where detail_requested)>=300 then return false; end if;
 insert into public.tix_capture_jobs(event_id,detail_requested,state,next_attempt_at) values(p_event_id,true,'queued',now())
 on conflict(event_id) do update set detail_requested=true,next_attempt_at=least(public.tix_capture_jobs.next_attempt_at,now())
 where not public.tix_capture_jobs.detail_requested and public.tix_capture_jobs.state<>'checking';
 get diagnostics changed=row_count;
 return changed=1;
end $$;

-- Requested one-off checks first, then tracked events by due time.
create or replace function public.tix_capture_due(p_limit integer default 8)
returns setof public.tix_catalog language sql stable security invoker set search_path='' as $$
 select c.* from public.tix_catalog c join public.tix_capture_jobs j using(event_id)
 where c.event_date between current_date and current_date+365 and j.next_attempt_at<=now()
 and (j.detail_requested or exists(select 1 from public.tix_history_tracking t where t.event_id=c.event_id))
 order by j.detail_requested desc,j.next_attempt_at,c.event_date limit least(greatest(p_limit,0),60);
$$;

-- Discovery skips events that a team/artist page priced in the last day.
create or replace function public.tix_discovery_due(p_from_days integer, p_to_days integer, p_limit integer)
returns setof public.tix_catalog language sql stable security invoker set search_path='' as $$
with city_activity as (
  select lower(coalesce(city,'')) city_key,state,max(discovery_attempt_at) last_attempt
  from public.tix_catalog
  group by lower(coalesce(city,'')),state
), ranked as (
  select c.*, row_number() over (
    partition by lower(coalesce(c.city,'')),c.state
    order by c.discovery_attempt_at asc nulls first,c.event_date,c.event_id
  ) as city_rank
  from public.tix_events_v c
  where c.event_date between current_date + greatest(p_from_days,0)
    and current_date + least(greatest(p_to_days,p_from_days),60)
    and (c.discovery_attempt_at is null or c.discovery_attempt_at < now()-interval '72 hours')
    and (c.price_checked_at is null or c.price_checked_at < now()-interval '24 hours')
)
select r.event_id,r.category,r.slug,r.name,r.event_date,r.datetime_local,r.venue_slug,r.venue,
  r.city,r.state,r.url,r.min_total,r.last_seen,r.price_checked_at,r.discovery_attempt_at,r.discovery_status
from ranked r join city_activity a
  on a.city_key=lower(coalesce(r.city,'')) and a.state is not distinct from r.state
order by a.last_attempt asc nulls first,r.city_rank,r.event_date,r.event_id
limit least(greatest(p_limit,0),40);
$$;

-- Team, artist and show pages. Paths only; never personal data.
create table if not exists public.tix_performers (
 path text primary key check(path ~ '^(/[a-z0-9-]{1,80}){1,2}/performers/[a-z0-9]{2,40}$'),
 discovered_at timestamptz not null default now(), next_check_at timestamptz not null default now(),
 checked_at timestamptz, events integer, priced integer, failures integer not null default 0, last_status text
);
create index if not exists tix_performers_due on public.tix_performers(next_check_at,path);
alter table public.tix_performers enable row level security;
revoke all on public.tix_performers from public,anon,authenticated;
grant all on public.tix_performers to service_role;

create or replace function public.tix_note_performers(p_paths text[])
returns integer language plpgsql security definer set search_path='' as $$
declare room integer; n integer;
begin
 select 25000-count(*) into room from public.tix_performers;
 if room<=0 or p_paths is null then return 0; end if;
 insert into public.tix_performers(path)
 select distinct p from unnest(p_paths[1:200]) p
 where p ~ '^(/[a-z0-9-]{1,80}){1,2}/performers/[a-z0-9]{2,40}$' limit room
 on conflict do nothing;
 get diagnostics n=row_count;
 return n;
end $$;

-- Get-in prices read from a page that lists many events. Updates only events
-- already in the catalog. Adds at most one history point per event every 20
-- hours for events within 30 days or tracked by someone, to bound storage.
create or replace function public.tix_apply_get_in_prices(p_rows jsonb,p_source text default 'catalog')
returns jsonb language plpgsql security definer set search_path='' as $$
declare updated integer; recorded integer;
begin
 if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>2000 then raise exception 'Invalid price rows'; end if;
 if p_source not in ('catalog','discovery') then raise exception 'Invalid price source'; end if;
 with input as (
  select distinct on (x.event_id) x.event_id,x.min_total from jsonb_to_recordset(p_rows) as x(event_id text,min_total integer)
  where x.event_id ~ '^[0-9a-f]{24}$' and x.min_total between 1 and 100000000 order by x.event_id
 ), changed as (
  update public.tix_catalog c set min_total=i.min_total,price_checked_at=now(),discovery_status='metadata_only'
  from input i where c.event_id=i.event_id and c.event_date between current_date and current_date+365
  returning c.event_id,c.event_date,i.min_total
 ), history as (
  insert into public.tix_event_observations(event_id,source,format,state,min_total,listing_count,meta)
  select h.event_id,p_source,'directory','metadata_only',h.min_total,0,jsonb_build_object('event_id',h.event_id)
  from changed h
  where (h.event_date<=current_date+30 or exists(select 1 from public.tix_history_tracking t where t.event_id=h.event_id))
   and not exists(select 1 from public.tix_event_observations o where o.event_id=h.event_id and o.checked_at>now()-interval '20 hours')
  returning 1
 )
 select (select count(*) from changed),(select count(*) from history) into updated,recorded;
 return jsonb_build_object('updated',updated,'history',recorded);
end $$;

-- The optional browser detail worker serves events someone opened (tracked).
create or replace function public.tix_claim_detail_dispatch(p_event_id text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(72634112);
 if not exists(select 1 from public.tix_provider_guard where id and enabled and suspended_at is null) then return false; end if;
 if exists(select 1 from public.tix_capture_jobs where dispatched_at>now()-interval '1 minute') then return false; end if;
 update public.tix_capture_jobs set dispatched_at=now() where event_id=p_event_id and state in ('metadata_only','partial','queued','failed') and
 (dispatched_at is null or dispatched_at<now()-interval '15 minutes') and exists(select 1 from public.tix_history_tracking t where t.event_id=p_event_id);
 return found;
end $$;

-- Same public status as before, plus the schema version the collector checks.
create or replace function public.tix_event_capture_status(p_event_id text)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('state',case when j.state='checking' and not exists(select 1 from public.tix_capture_leases l where l.event_id=p_event_id and l.expires_at>now()) then 'failed' else coalesce(j.state,'not_checked') end,'reason',j.reason,'next_attempt_at',j.next_attempt_at,'last_attempt_at',j.last_attempt_at,
 'guard_enabled',g.enabled,'suspended',g.suspended_at is not null,'schema',20261016)
 from public.tix_provider_guard g left join public.tix_capture_jobs j on j.event_id=p_event_id where g.id;
$$;

do $$ declare f record; begin
 for f in select p.oid::regprocedure signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in ('tix_claim_capture','tix_admit_provider_http','tix_release_capture','tix_save_capture','tix_request_capture','tix_request_price_check','tix_capture_due','tix_discovery_due','tix_note_performers','tix_apply_get_in_prices','tix_claim_detail_dispatch','tix_event_capture_status') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
  if f.proname in ('tix_request_capture','tix_request_price_check') then execute format('grant execute on function %s to authenticated',f.signature); end if;
  if f.proname='tix_event_capture_status' then execute format('grant execute on function %s to anon,authenticated',f.signature); end if;
 end loop;
end $$;
commit;
