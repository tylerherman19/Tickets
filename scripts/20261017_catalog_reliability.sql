-- Apply after 20261017_moved_events.sql. Additive and idempotent.
-- Provider identities are recorded from Gametime data, never guessed from a
-- mascot. Public RPCs return market data or aggregate health, never search
-- owners, saved watches, delivery addresses, provider tokens or raw errors.
-- This migration does not change guard budgets, clear suspensions or enable expiry.
begin;

create table if not exists public.tix_teams (
 team_id text primary key check(team_id ~ '^[a-z0-9]{2,40}$'),
 category text not null, label text not null check(length(label) between 1 and 180),
 path text not null unique check(path ~ '^(/[a-z0-9-]{1,80}){1,2}/performers/[a-z0-9]{2,40}$'),
 aliases text[] not null default '{}', discovered_at timestamptz not null default now(),
 updated_at timestamptz not null default now(), checked_at timestamptz,
 last_status text, failures integer not null default 0
);
create index if not exists tix_teams_category on public.tix_teams(category,team_id);
create table if not exists public.tix_team_events (
 team_id text not null references public.tix_teams(team_id) on delete cascade,
 event_id text not null references public.tix_catalog(event_id) on delete cascade,
 is_home boolean, checked_at timestamptz not null default now(), primary key(team_id,event_id)
);
create index if not exists tix_team_events_event on public.tix_team_events(event_id);
create table if not exists public.tix_team_demand (
 team_id text primary key references public.tix_teams(team_id) on delete cascade,
 requested_at timestamptz not null default now(), requested_count integer not null default 1,
 fulfilled_at timestamptz
);
create table if not exists public.tix_search_request_limits (
 owner_id uuid primary key references auth.users(id) on delete cascade,
 window_start timestamptz not null default now(), requests integer not null default 1
);
do $$ declare t text; begin
 foreach t in array array['tix_teams','tix_team_events','tix_team_demand','tix_search_request_limits'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;

create or replace function public.tix_normalize_team(p_text text)
returns text language sql immutable parallel safe set search_path='' as $$
 select trim(regexp_replace(lower(coalesce(p_text,'')),'[^a-z0-9]+',' ','g'));
$$;

-- Service-only import of bounded source-identified names and aliases. A path
-- must end in the exact provider ID; a caller cannot associate another team.
create or replace function public.tix_upsert_teams(p_rows jsonb)
returns integer language plpgsql security definer set search_path='' as $$
declare n integer;
begin
 if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>2000 then raise exception 'Invalid team rows'; end if;
 with input as (
  select distinct on (r.team_id) r.team_id,r.category,left(trim(r.label),180) label,r.path,
   array(select distinct left(trim(a),100) from unnest(r.aliases[1:20]) a where length(trim(a)) between 1 and 100) aliases
  from jsonb_to_recordset(p_rows) r(team_id text,category text,label text,path text,aliases text[])
  where r.team_id ~ '^[a-z0-9]{2,40}$' and r.category in ('nfl-football','nba-basketball','mlb-baseball','nhl-hockey','college-football','college-basketball','mls-soccer','wnba')
   and length(trim(r.label)) between 1 and 180 and r.path ~ '^(/[a-z0-9-]{1,80}){1,2}/performers/[a-z0-9]{2,40}$'
   and right(r.path,length(r.team_id)+1)='/'||r.team_id order by r.team_id
 )
 insert into public.tix_teams(team_id,category,label,path,aliases)
 select team_id,category,label,path,aliases from input
 on conflict(team_id) do update set category=excluded.category,label=excluded.label,path=excluded.path,aliases=excluded.aliases,updated_at=now();
 get diagnostics n=row_count;
 return n;
end $$;

-- Event membership comes only from a team's source page or the event's
-- explicit performer list. Home/away stays null unless source data says so.
create or replace function public.tix_link_team_events(p_team_id text,p_rows jsonb,p_checked boolean default false)
returns integer language plpgsql security definer set search_path='' as $$
declare n integer;
begin
 if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>2000 then raise exception 'Invalid team events'; end if;
 if not exists(select 1 from public.tix_teams where team_id=p_team_id) then return 0; end if;
 insert into public.tix_team_events(team_id,event_id,is_home)
 select p_team_id,r.event_id,r.is_home from jsonb_to_recordset(p_rows) r(event_id text,is_home boolean)
 join public.tix_catalog c using(event_id) where c.event_date between current_date and current_date+365
 and c.category=(select category from public.tix_teams where team_id=p_team_id)
 on conflict(team_id,event_id) do update set is_home=excluded.is_home,checked_at=now();
 get diagnostics n=row_count;
 if p_checked then
  update public.tix_teams set checked_at=now(),last_status='ok',failures=0 where team_id=p_team_id;
  update public.tix_team_demand set fulfilled_at=now() where team_id=p_team_id;
 end if;
 return n;
end $$;

create or replace function public.tix_team_check_failed(p_team_id text,p_status text)
returns void language sql security definer set search_path='' as $$
 update public.tix_teams set checked_at=now(),failures=failures+1,last_status=left(coalesce(p_status,'failed'),40) where team_id=p_team_id;
$$;

-- Empty queries serve the picker; exact names/aliases rank first. Partial
-- aliases require three characters. Ambiguous aliases remain distinct rows.
create or replace function public.tix_resolve_teams(p_query text default '',p_category text default null,p_limit integer default 12)
returns table(team_id text,category text,label text,aliases text[],event_count bigint)
language sql stable security definer set search_path='' as $$
 with q as(select public.tix_normalize_team(left(p_query,100)) value), ranked as (
  select t.*,case when q.value='' then 2 when t.team_id=q.value or public.tix_normalize_team(t.label)=q.value or exists(select 1 from unnest(t.aliases) a where public.tix_normalize_team(a)=q.value) then 0 else 1 end priority
  from public.tix_teams t cross join q where (p_category is null or t.category=p_category) and
   (q.value='' or t.team_id=q.value or public.tix_normalize_team(t.label) like '%'||q.value||'%' or
    exists(select 1 from unnest(t.aliases) a where public.tix_normalize_team(a)=q.value or (length(q.value)>=3 and public.tix_normalize_team(a) like '%'||q.value||'%')))
 )
 select r.team_id,r.category,r.label,r.aliases,(select count(*) from public.tix_team_events te join public.tix_events_v c using(event_id)
  where te.team_id=r.team_id and c.event_date between current_date and current_date+365)
 from ranked r order by r.priority,r.label,r.team_id limit least(greatest(p_limit,0),1200);
$$;

create or replace function public.tix_search_team_events(p_team_id text,p_limit integer default 200)
returns table(event_id text,category text,slug text,name text,event_date date,datetime_local text,venue_slug text,venue text,city text,state text,url text,min_total integer,last_seen timestamptz,price_checked_at timestamptz,discovery_attempt_at timestamptz,discovery_status text,is_home boolean)
language sql stable security definer set search_path='' as $$
 select c.event_id,c.category,c.slug,c.name,c.event_date,c.datetime_local,c.venue_slug,c.venue,c.city,c.state,c.url,c.min_total,c.last_seen,c.price_checked_at,c.discovery_attempt_at,c.discovery_status,te.is_home
 from public.tix_team_events te join public.tix_events_v c using(event_id)
 where te.team_id=p_team_id and c.event_date between current_date and current_date+365
 order by c.event_date,c.event_id limit least(greatest(p_limit,0),500);
$$;

-- A bounded demand queue, separate from personal history. Rate limiting is
-- per signed-in caller; demand counters and caller IDs are never public.
-- Existing provider back-off is respected, including redirects/suspensions.
create or replace function public.tix_prioritize_search(p_query text default '',p_category text default null,p_team_id text default null,p_event_ids text[] default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); chosen text[]; matched integer; n integer:=0; pages integer:=0; requests integer; ids text[]; team_room integer;
begin
 if uid is null then return jsonb_build_object('state','sign_in_required','teams',0,'events',0,'provider_pages',0); end if;
 if length(coalesce(p_query,''))>100 or cardinality(p_event_ids)>12 then raise exception 'Search request too large'; end if;
 -- Keep the same global-then-owner lock order as capture request paths.
 perform pg_advisory_xact_lock(72634112);
 perform pg_advisory_xact_lock(hashtext(uid::text));
 insert into public.tix_search_request_limits(owner_id) values(uid)
 on conflict(owner_id) do update set
  requests=case when public.tix_search_request_limits.window_start<now()-interval '1 minute' then 1 else public.tix_search_request_limits.requests+1 end,
  window_start=case when public.tix_search_request_limits.window_start<now()-interval '1 minute' then now() else public.tix_search_request_limits.window_start end
 returning tix_search_request_limits.requests into requests;
 if requests>10 then return jsonb_build_object('state','rate_limited','teams',0,'events',0,'provider_pages',0); end if;
 if p_team_id is not null then
  select array_agg(t.team_id) into chosen from public.tix_teams t where t.team_id=p_team_id and (p_category is null or t.category=p_category);
 elsif length(public.tix_normalize_team(p_query))>=2 then
  select array_agg(t.team_id) into chosen from public.tix_resolve_teams(p_query,p_category,5) t;
 end if;
 matched:=coalesce(cardinality(chosen),0);
 -- A broad/ambiguous query never fans out across many provider pages.
 if matched>4 then return jsonb_build_object('state','ambiguous','teams',matched,'events',0,'provider_pages',0); end if;
 select greatest(0,300-count(*))::integer into team_room from public.tix_team_demand where requested_at>now()-interval '24 hours' and (fulfilled_at is null or fulfilled_at<requested_at);
 insert into public.tix_team_demand(team_id)
 select c from (
  select c from unnest(coalesce(chosen,'{}')) c where exists(select 1 from public.tix_team_demand d where d.team_id=c and d.requested_at>now()-interval '24 hours' and (d.fulfilled_at is null or d.fulfilled_at<d.requested_at))
  union all
  (select c from unnest(coalesce(chosen,'{}')) c where not exists(select 1 from public.tix_team_demand d where d.team_id=c and d.requested_at>now()-interval '24 hours' and (d.fulfilled_at is null or d.fulfilled_at<d.requested_at)) order by c limit team_room)
 ) bounded
 on conflict(team_id) do update set requested_at=now(),requested_count=least(public.tix_team_demand.requested_count+1,1000000);
 get diagnostics pages=row_count;
 select array_agg(event_id) into ids from (
  select c.event_id from public.tix_events_v c where c.event_date between current_date and current_date+365 and
   (c.event_id=any(coalesce(p_event_ids,'{}')) or exists(select 1 from public.tix_team_events te where te.event_id=c.event_id and te.team_id=any(coalesce(chosen,'{}'))))
   and (c.price_checked_at is null or c.price_checked_at<now()-interval '15 minutes')
  order by c.event_id=any(coalesce(p_event_ids,'{}')) desc,c.event_date limit 24
 ) pending;
 -- At most 300 pending one-off requests across all callers.
 select greatest(0,300-count(*))::integer into n from public.tix_capture_jobs where detail_requested;
 insert into public.tix_capture_jobs(event_id,detail_requested,state,next_attempt_at)
 select eid,true,'queued',now() from unnest(coalesce(ids,'{}')) eid limit n
 on conflict(event_id) do update set detail_requested=true,
  next_attempt_at=case when public.tix_capture_jobs.reason is null then least(public.tix_capture_jobs.next_attempt_at,now()) else public.tix_capture_jobs.next_attempt_at end
 where public.tix_capture_jobs.state<>'checking';
 get diagnostics n=row_count;
 return jsonb_build_object('state',case when pages+n>0 then 'queued' else 'no_matches' end,'teams',matched,'events',n,'provider_pages',pages);
end $$;

-- Foreground team demand is processed before the background rotation by a
-- hosted worker, but every network request still uses the existing guard.
create or replace function public.tix_team_refresh_due(p_category text default null,p_limit integer default 12)
returns table(team_id text,category text,path text,requested_at timestamptz)
language sql stable security definer set search_path='' as $$
 select t.team_id,t.category,t.path,d.requested_at from public.tix_team_demand d join public.tix_teams t using(team_id)
 where (p_category is null or t.category=p_category) and d.requested_at>now()-interval '24 hours'
 and (d.fulfilled_at is null or d.fulfilled_at<d.requested_at) and
 (t.checked_at is null or t.checked_at<now()-interval '15 minutes') and
 (t.failures=0 or t.checked_at<now()-least(interval '7 days',interval '15 minutes'*power(2,least(t.failures,9))))
 order by d.requested_at desc,t.team_id limit least(greatest(p_limit,0),60);
$$;

-- Quantity prices are reconstructed from saved seller lots, never the
-- unqualified directory get-in price or an inferred divisible quantity.
create or replace function public.tix_search_quantity_prices(p_event_ids text[],p_qty integer)
returns table(event_id text,checked_at timestamptz,price_cents integer,basis text,listing_count bigint,coverage jsonb,state text)
language sql stable security definer set search_path='' as $$
 with events as (select c.event_id from public.tix_events_v c where c.event_id=any(p_event_ids[1:200]) and c.event_date between current_date and current_date+365),
 latest as (select e.event_id,o.id,o.checked_at,o.coverage,o.state from events e left join lateral(
  select * from public.tix_event_observations o where o.event_id=e.event_id and o.state in ('complete','partial','empty') order by o.checked_at desc limit 1
 ) o on true)
 select o.event_id,o.checked_at,price.price_cents,price.basis,coalesce(price.listings,0),coalesce(o.coverage,'{}'),coalesce(o.state,'unconfirmed') from latest o
 left join lateral(
  select l.price_cents,l.basis,count(*) over(partition by l.basis) listings from public.tix_listing_observations l
  where l.observation_id=o.id and p_qty between 1 and 8 and l.price_cents>0 and l.basis in ('fees_included_tax_reported','fees_included_tax_unknown') and
   (l.verified_quantity=p_qty or (p_qty=any(l.lots) and jsonb_typeof(l.seats)='array' and jsonb_array_length(l.seats)>=p_qty))
  order by l.price_cents,l.ordinal limit 1
 ) price on true;
$$;

-- One event, quantity, basis and selected section per series. Legacy get-in
-- series keep their explicit quantity/tax-unknown basis. Seller-lot series
-- are recomputed from exact saved listings, not mixed-basis by_qty summaries.
create or replace function public.tix_event_comparable_history(p_event_id text,p_qty integer default 0,p_basis text default 'provider_get_in_tax_quantity_unconfirmed',p_section text default null)
returns table(checked_at timestamptz,price_cents integer,basis text,qty integer,section text,listing_count bigint,state text)
language sql stable security definer set search_path='' as $$
 with samples as (
  select o.id,o.checked_at,o.min_total price_cents,o.get_in_basis basis,0 qty,null::text section,o.listing_count::bigint listing_count,o.state
  from public.tix_event_observations o where o.event_id=p_event_id and p_qty=0 and p_section is null and o.min_total>0 and o.get_in_basis=p_basis and o.state<>'failed'
  union all
  select o.id,o.checked_at,min(l.price_cents),p_basis,p_qty,p_section,count(*),o.state
  from public.tix_event_observations o join public.tix_listing_observations l on l.observation_id=o.id
  where o.event_id=p_event_id and p_qty between 1 and 8 and p_basis in ('fees_included_tax_reported','fees_included_tax_unknown') and l.basis=p_basis and l.price_cents>0
   and (p_section is null or l.section=p_section or l.section_group=p_section)
   and (l.verified_quantity=p_qty or (p_qty=any(l.lots) and jsonb_typeof(l.seats)='array' and jsonb_array_length(l.seats)>=p_qty))
   and o.state in ('complete','partial') group by o.id,o.checked_at,o.state
 ), hourly as (
  select distinct on(date_trunc('hour',s.checked_at)) s.* from samples s order by date_trunc('hour',s.checked_at) desc,s.checked_at desc,s.id desc limit 366
 ) select h.checked_at,h.price_cents,h.basis,h.qty,h.section,h.listing_count,h.state from hourly h order by h.checked_at;
$$;

create or replace function public.tix_catalog_health(p_category text default null)
returns jsonb language sql stable security definer set search_path='' as $$
 with events as (select * from public.tix_events_v where event_date between current_date and current_date+365 and (p_category is null or category=p_category)),
 totals as (select count(*) events,count(*) filter(where min_total>0) priced,count(*) filter(where min_total is null or min_total<=0) unpriced,
  count(*) filter(where min_total>0 and price_checked_at>now()-interval '24 hours') fresh,
  count(*) filter(where min_total>0 and (price_checked_at is null or price_checked_at<=now()-interval '24 hours')) stale,max(last_seen) last_catalog_at from events),
 teams as(select count(*) teams,count(*) filter(where checked_at is not null) teams_checked,count(*) filter(where failures>0) teams_failed from public.tix_teams where p_category is null or category=p_category),
 jobs as(select count(*) filter(where j.state='failed' or (j.state='checking' and not exists(select 1 from public.tix_capture_leases l where l.event_id=j.event_id and l.expires_at>now()))) failed_checks,
  count(*) filter(where j.detail_requested or j.state='checking') pending_checks from public.tix_capture_jobs j join events e using(event_id)),
 collector as(select updated_at last_collector_at,case when v->>'status'='error' then 'failed' when updated_at<now()-interval '2 hours' then 'stale' else 'fresh' end state from public.tix_state where k='collector_health')
 select jsonb_build_object('as_of',now(),'schema',20261017,'horizon_days',365,'freshness_hours',24,'collector_stale_minutes',120,'events',totals.events,'priced',totals.priced,'unpriced',totals.unpriced,'fresh',totals.fresh,'stale',totals.stale,
  'failed_checks',jobs.failed_checks,'pending_checks',jobs.pending_checks,'teams',teams.teams,'teams_checked',teams.teams_checked,'teams_failed',teams.teams_failed,
  'last_catalog_at',totals.last_catalog_at,'last_collector_at',(select last_collector_at from collector),'collector_state',coalesce((select state from collector),'unknown'),
  'provider_paused',coalesce((select not enabled or suspended_at is not null from public.tix_provider_guard where id),true),
  'categories',coalesce((select jsonb_agg(r order by r.category) from (select category,count(*) events,count(*) filter(where min_total>0) priced from events group by category) r),'[]'::jsonb))
 from totals cross join teams cross join jobs;
$$;

-- Each alert-history series keeps its own hourly sample. A simultaneous
-- check of several games/sections must not collapse to one arbitrary game.
create or replace function public.tix_alert_history(p_watch_id uuid,p_range text default '7d',p_version integer default null)
returns table(checked_at timestamptz,price_cents integer,criteria_version integer,
  event_id text,club text,qty integer,basis text,prefee_cents integer,
  sales_tax_cents integer,pre_tax_total_cents integer,deal text,hist jsonb,lots integer[])
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
  return query select distinct on (floor(extract(epoch from p.checked_at)/bucket_seconds),p.event_id,p.qty,p.club,p.basis)
    p.checked_at,p.price_cents,p.criteria_version,p.event_id,p.club,p.qty,p.basis,
    p.prefee_cents,p.sales_tax_cents,p.pre_tax_total_cents,p.deal,p.hist,p.lots from public.tix_prices p
    where p.watch_id=p_watch_id and p.criteria_version=version_number and p.checked_at>=since_at
    order by floor(extract(epoch from p.checked_at)/bucket_seconds),p.event_id,p.qty,p.club,p.basis,p.checked_at desc,p.id desc;
end;
$$;

-- Intentionally explicit grants. New definer helpers default to no access.
do $$ declare f record; begin
 for f in select p.oid::regprocedure signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and
 p.proname in ('tix_normalize_team','tix_upsert_teams','tix_link_team_events','tix_team_check_failed','tix_resolve_teams','tix_search_team_events','tix_prioritize_search','tix_team_refresh_due','tix_search_quantity_prices','tix_event_comparable_history','tix_catalog_health') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
  if f.proname in ('tix_resolve_teams','tix_search_team_events','tix_search_quantity_prices','tix_event_comparable_history','tix_catalog_health') then execute format('grant execute on function %s to anon,authenticated',f.signature); end if;
  if f.proname='tix_prioritize_search' then execute format('grant execute on function %s to authenticated',f.signature); end if;
 end loop;
end $$;
commit;
notify pgrst, 'reload schema';
