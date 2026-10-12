-- Apply after 20261011_listing_fields.sql. Staged disabled until release review.
begin;
create table if not exists public.tix_provider_guard (
 id boolean primary key default true check(id), enabled boolean not null default false,
 suspended_at timestamptz, suspension_reason text,
 canary_event_ids text[] not null default '{}',
 allow_catalog boolean not null default false,
 expiry_enabled boolean not null default false,
 minute_limit integer not null default 3 check(minute_limit between 1 and 10),
 hour_limit integer not null default 30 check(hour_limit between 1 and 200),
 day_limit integer not null default 100 check(day_limit between 1 and 1000)
);
insert into public.tix_provider_guard(id) values(true) on conflict do nothing;
create table if not exists public.tix_capture_jobs (
 event_id text primary key references public.tix_catalog(event_id) on delete cascade,
 requested_at timestamptz not null default now(), detail_requested boolean not null default true,
 state text not null default 'queued', reason text, next_attempt_at timestamptz not null default now(),
 last_attempt_at timestamptz, dispatched_at timestamptz
);
create table if not exists public.tix_history_tracking (
 owner_id uuid not null references auth.users(id) on delete cascade,
 event_id text not null references public.tix_catalog(event_id) on delete cascade,
 created_at timestamptz not null default now(), primary key(owner_id,event_id)
);
create table if not exists public.tix_capture_leases (
 token uuid primary key default gen_random_uuid(), event_id text,
 source text not null, expires_at timestamptz not null,
 started_at timestamptz not null default now()
);
create table if not exists public.tix_provider_http (
 id bigint generated always as identity primary key, lease_token uuid not null,
 event_id text, at timestamptz not null default now(), source text not null
);
create index if not exists tix_provider_http_at on public.tix_provider_http(at);
create table if not exists public.tix_event_observations (
 id uuid primary key default gen_random_uuid(), event_id text not null references public.tix_catalog(event_id) on delete cascade,
 checked_at timestamptz not null default now(), source text not null, format text,
 state text not null check(state in ('complete','partial','empty','metadata_only','failed')),
 min_total integer, get_in_basis text not null default 'provider_get_in_tax_quantity_unconfirmed',
 listing_count integer not null default 0, meta jsonb not null default '{}'::jsonb,
 coverage jsonb not null default '{}'::jsonb, by_qty jsonb not null default '{}'::jsonb
);
create index if not exists tix_event_observations_event_time on public.tix_event_observations(event_id,checked_at desc);
create table if not exists public.tix_listing_observations (
 observation_id uuid not null references public.tix_event_observations(id) on delete cascade,
 ordinal integer not null, listing_id text, price_cents integer, basis text,
 prefee_cents integer, sales_tax_cents integer, pre_tax_total_cents integer,
 lots integer[], seats jsonb, section_group text, section text, row_label text,
 verified_quantity integer, provider jsonb not null, primary key(observation_id,ordinal)
);
create index if not exists tix_history_tracking_event on public.tix_history_tracking(event_id);
create index if not exists tix_capture_jobs_due on public.tix_capture_jobs(next_attempt_at,requested_at);
-- Provider observations are public market data; personal tracking is owner-only.
alter table public.tix_history_tracking enable row level security;
drop policy if exists "own history tracking" on public.tix_history_tracking;
create policy "own history tracking" on public.tix_history_tracking for select to authenticated using(owner_id=(select auth.uid()));
revoke all on public.tix_history_tracking from public,anon,authenticated;
grant select on public.tix_history_tracking to authenticated;
do $$ declare t text; begin
 foreach t in array array['tix_provider_guard','tix_capture_jobs','tix_capture_leases','tix_provider_http','tix_event_observations','tix_listing_observations'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;
grant all on public.tix_history_tracking to service_role;
grant usage,select on sequence public.tix_provider_http_id_seq to service_role;

create or replace function public.tix_request_capture(p_event_id text,p_details boolean default true)
returns jsonb language plpgsql security definer set search_path='' as $$
declare e public.tix_catalog; j public.tix_capture_jobs; uid uuid:=auth.uid(); total integer;
begin
 if uid is null then raise exception 'Sign in to refresh prices and save history' using errcode='42501'; end if;
 select * into e from public.tix_catalog where event_id=p_event_id;
 if e.event_id is null then return jsonb_build_object('state','failed','reason','event_not_found'); end if;
 if e.event_date<current_date then return jsonb_build_object('state','expired'); end if;
 if e.event_date>current_date+365 then return jsonb_build_object('state','beyond_horizon'); end if;
 perform pg_advisory_xact_lock(72634112);
 perform pg_advisory_xact_lock(hashtext(uid::text));
 select count(*) into total from public.tix_history_tracking where owner_id=uid;
 if total>=100 and not exists(select 1 from public.tix_history_tracking where owner_id=uid and event_id=p_event_id) then
  return jsonb_build_object('state','failed','reason','tracking_limit');
 end if;
 if not exists(select 1 from public.tix_capture_jobs where event_id=p_event_id) and (select count(*) from public.tix_capture_jobs)>=500 then
  return jsonb_build_object('state','queued','reason','queue_full');
 end if;
 insert into public.tix_history_tracking(owner_id,event_id) values(uid,p_event_id) on conflict do nothing;
 insert into public.tix_capture_jobs(event_id,detail_requested) values(p_event_id,p_details)
 on conflict(event_id) do update set requested_at=now(),detail_requested=public.tix_capture_jobs.detail_requested or excluded.detail_requested
 where public.tix_capture_jobs.requested_at<now()-interval '1 minute';
 select * into j from public.tix_capture_jobs where event_id=p_event_id;
 return jsonb_build_object('state',j.state,'reason',j.reason,'next_attempt_at',j.next_attempt_at);
end $$;

create or replace function public.tix_claim_capture(p_event_id text,p_source text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare g public.tix_provider_guard; token uuid; e public.tix_catalog; sample public.tix_event_observations; j public.tix_capture_jobs;
begin
 perform pg_advisory_xact_lock(72634112);
 select * into g from public.tix_provider_guard where id;
 if not coalesce(g.enabled,false) or g.suspended_at is not null then return jsonb_build_object('state','suspended','reason',coalesce(g.suspension_reason,'rollout_disabled')); end if;
 if p_event_id is null and not g.allow_catalog then return jsonb_build_object('state','queued','reason','catalog_disabled'); end if;
 if p_event_id is not null and cardinality(g.canary_event_ids)>0 and not(p_event_id=any(g.canary_event_ids)) then return jsonb_build_object('state','queued','reason','outside_canary'); end if;
 if p_source not in ('edge','collector','detail','catalog') then raise exception 'Invalid capture source'; end if;
 if p_event_id is not null then
  select * into e from public.tix_catalog where event_id=p_event_id;
  if e.event_id is null or e.event_date<current_date then return jsonb_build_object('state','expired'); end if;
  if e.event_date>current_date+365 then return jsonb_build_object('state','beyond_horizon'); end if;
  select * into j from public.tix_capture_jobs where event_id=p_event_id;
  select * into sample from public.tix_event_observations where event_id=p_event_id order by checked_at desc limit 1;
  if sample.checked_at>now()-interval '15 minutes' and (p_source='edge' or sample.state in ('complete','empty') or not coalesce(j.detail_requested,false)) then
   return jsonb_build_object('state','cached','observation_id',sample.id);
  end if;
  if j.next_attempt_at>now() and p_source<>'catalog' and (p_source<>'edge' or j.reason is not null) then return jsonb_build_object('state','queued','reason',j.reason,'next_attempt_at',j.next_attempt_at); end if;
 end if;
 if exists(select 1 from public.tix_capture_leases where expires_at>now()) then return jsonb_build_object('state','queued','reason','provider_busy'); end if;
 update public.tix_capture_jobs set state='failed',reason='capture_timeout' where state='checking' and event_id in (select event_id from public.tix_capture_leases where expires_at<=now());
 delete from public.tix_capture_leases where expires_at<=now();
 insert into public.tix_capture_leases(event_id,source,expires_at) values(p_event_id,p_source,now()+interval '60 seconds') returning tix_capture_leases.token into token;
 if p_event_id is not null then
  insert into public.tix_capture_jobs(event_id,state,last_attempt_at) values(p_event_id,'checking',now())
  on conflict(event_id) do update set state='checking',last_attempt_at=now(),reason=null;
 end if;
 return jsonb_build_object('state','checking','token',token);
end $$;

-- Atomic rolling windows; every HTTP attempt requires admission, including
-- browser subresources and sitemap requests. Never refund failed attempts.
create or replace function public.tix_admit_provider_http(p_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare g public.tix_provider_guard; l public.tix_capture_leases; n1 integer;n2 integer;n3 integer; wait_at timestamptz;
begin
 perform pg_advisory_xact_lock(72634112);
 select * into g from public.tix_provider_guard where id;
 select * into l from public.tix_capture_leases where token=p_token and expires_at>now();
 if l.token is null or not g.enabled or g.suspended_at is not null then return jsonb_build_object('allowed',false,'reason','suspended_or_lease_expired'); end if;
 select count(*) filter(where at>now()-interval '1 minute'),count(*) filter(where at>now()-interval '1 hour'),count(*) into n1,n2,n3
 from public.tix_provider_http where at>now()-interval '1 day';
 if n1>=g.minute_limit or n2>=g.hour_limit or n3>=g.day_limit then
  select max(reset_at) into wait_at from (
   select min(at)+interval '1 minute' reset_at from public.tix_provider_http where at>now()-interval '1 minute' and n1>=g.minute_limit
   union all select min(at)+interval '1 hour' from public.tix_provider_http where at>now()-interval '1 hour' and n2>=g.hour_limit
   union all select min(at)+interval '1 day' from public.tix_provider_http where at>now()-interval '1 day' and n3>=g.day_limit) x;
  update public.tix_capture_jobs set state='queued',reason='request_limit',next_attempt_at=wait_at+interval '1 second' where event_id=l.event_id;
  return jsonb_build_object('allowed',false,'reason','request_limit','next_attempt_at',wait_at+interval '1 second');
 end if;
 insert into public.tix_provider_http(lease_token,event_id,source) values(p_token,l.event_id,l.source);
 update public.tix_capture_leases set expires_at=now()+interval '60 seconds' where token=p_token;
 return jsonb_build_object('allowed',true);
end $$;

create or replace function public.tix_suspend_provider(p_token uuid,p_reason text)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(72634112);
 if not exists(select 1 from public.tix_capture_leases where token=p_token) then raise exception 'Unknown lease'; end if;
 update public.tix_provider_guard set suspended_at=now(),suspension_reason=left(p_reason,160) where id;
 update public.tix_capture_jobs set state='failed',reason='provider_suspended' where state in ('queued','checking');
end $$;

create or replace function public.tix_release_capture(p_token uuid,p_reason text default null)
returns void language plpgsql security definer set search_path='' as $$
begin
 if p_reason='capture_failed' then
  insert into public.tix_event_observations(event_id,source,state,meta)
  select l.event_id,l.source,'failed',jsonb_build_object('reason',p_reason) from public.tix_capture_leases l
  join public.tix_catalog c on c.event_id=l.event_id where l.token=p_token;
 end if;
 update public.tix_capture_jobs set state=case when p_reason='request_limit' then 'queued' else 'failed' end,
  reason=coalesce(p_reason,'capture_interrupted'),next_attempt_at=greatest(next_attempt_at,now()+interval '15 minutes')
 where state='checking' and event_id=(select event_id from public.tix_capture_leases where token=p_token);
 delete from public.tix_capture_leases where token=p_token;
end $$;

create or replace function public.tix_save_capture(p_token uuid,p_capture jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare l public.tix_capture_leases; oid uuid; item jsonb; pos bigint; s text:=p_capture->>'state'; ts timestamptz:=now(); next_at timestamptz; raw jsonb;
begin
 perform pg_advisory_xact_lock(72634112);
 select * into l from public.tix_capture_leases where token=p_token and expires_at>now();
 if l.event_id is null then raise exception 'Capture lease expired'; end if;
 if p_capture->'meta'->>'event_id' is distinct from l.event_id then raise exception 'Event ID mismatch'; end if;
 if s not in ('complete','partial','empty','metadata_only') then raise exception 'Invalid inventory state'; end if;
 if jsonb_typeof(p_capture->'listings')<>'array' or jsonb_array_length(p_capture->'listings')>10000 then raise exception 'Invalid listing array'; end if;
 insert into public.tix_event_observations(event_id,source,format,state,min_total,listing_count,meta,coverage,by_qty)
 values(l.event_id,l.source,p_capture->>'format',s,(p_capture->>'min_total')::integer,
 jsonb_array_length(p_capture->'listings'),p_capture->'meta',p_capture->'coverage',p_capture->'by_qty') returning id into oid;
 for item,pos in select value,ordinality from jsonb_array_elements(p_capture->'listings') with ordinality loop
  raw:=item->'provider';
  insert into public.tix_listing_observations(observation_id,ordinal,listing_id,price_cents,basis,prefee_cents,sales_tax_cents,pre_tax_total_cents,lots,seats,section_group,section,row_label,verified_quantity,provider)
  values(oid,pos,item->>'listing_id',(item->>'price_cents')::integer,item->>'basis',(item->>'prefee_cents')::integer,(item->>'sales_tax_cents')::integer,(item->>'pre_tax_total_cents')::integer,
  case when jsonb_typeof(item->'lots')='array' then array(select jsonb_array_elements_text(item->'lots')::integer) end,raw->'seats',item->>'section_group',item->>'section',item->>'row_label',(item->>'verified_quantity')::integer,raw);
 end loop;
 update public.tix_catalog set price_checked_at=ts,discovery_attempt_at=ts,discovery_status=case when s='metadata_only' then 'metadata_only' else 'ok' end,
 min_total=(p_capture->>'min_total')::integer where event_id=l.event_id;
 if s<>'metadata_only' then
  insert into public.tix_event_market(event_id,checked_at,by_qty,groups,listing_count,coverage)
  values(l.event_id,ts,p_capture->'by_qty',p_capture->'groups',jsonb_array_length(p_capture->'listings'),p_capture->'coverage')
  on conflict(event_id) do update set checked_at=excluded.checked_at,by_qty=excluded.by_qty,groups=excluded.groups,listing_count=excluded.listing_count,coverage=excluded.coverage;
 end if;
 select ts+case when event_date<=current_date+7 then interval '15 minutes' when event_date<=current_date+30 then interval '1 hour' else interval '6 hours' end into next_at from public.tix_catalog where event_id=l.event_id;
 -- Permit one separately guarded detail pass after metadata-only fast results.
 if s='metadata_only' and l.source='edge' then next_at:=ts; end if;
 update public.tix_capture_jobs set state=s,reason=null,next_attempt_at=next_at,last_attempt_at=ts where event_id=l.event_id;
 return oid;
end $$;

create or replace function public.tix_finish_capture(p_token uuid,p_capture jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare oid uuid;
begin
 oid:=public.tix_save_capture(p_token,p_capture);
 delete from public.tix_capture_leases where token=p_token;
 return oid;
end $$;

-- No caller identities returned; only public market observations for this event.
create or replace function public.tix_event_capture_status(p_event_id text)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('state',case when j.state='checking' and not exists(select 1 from public.tix_capture_leases l where l.event_id=p_event_id and l.expires_at>now()) then 'failed' else coalesce(j.state,'not_checked') end,'reason',j.reason,'next_attempt_at',j.next_attempt_at,'last_attempt_at',j.last_attempt_at,
 'guard_enabled',g.enabled,'suspended',g.suspended_at is not null)
 from public.tix_provider_guard g left join public.tix_capture_jobs j on j.event_id=p_event_id where g.id;
$$;
create or replace function public.tix_event_price_history(p_event_id text,p_qty integer default 0,p_basis text default 'provider_get_in_tax_quantity_unconfirmed')
returns table(checked_at timestamptz,price_cents integer,basis text,qty integer,listing_count integer,state text)
language sql stable security definer set search_path='' as $$
 select * from (select distinct on (date_trunc('hour',o.checked_at)) o.checked_at,
 case when p_qty=0 then o.min_total else (o.by_qty->p_qty::text->>'low')::integer end,
 case when p_qty=0 then o.get_in_basis else o.by_qty->p_qty::text->>'basis' end,p_qty,o.listing_count,o.state
 from public.tix_event_observations o where o.event_id=p_event_id and
 ((p_qty=0 and o.min_total>0 and o.get_in_basis=p_basis) or
 (p_qty between 1 and 8 and o.by_qty->p_qty::text->>'basis'=p_basis and (o.by_qty->p_qty::text->>'low')::integer>0))
 order by date_trunc('hour',o.checked_at) desc,o.checked_at desc limit 366) recent order by checked_at;
$$;
create or replace function public.tix_event_listings(p_event_id text,p_qty integer default 2,p_offset integer default 0)
returns table(listing_id text,price_cents integer,basis text,prefee_cents integer,sales_tax_cents integer,pre_tax_total_cents integer,lots integer[],seats jsonb,section_group text,section text,row_label text,checked_at timestamptz,coverage jsonb)
language sql stable security definer set search_path='' as $$
 with latest as (select * from public.tix_event_observations where event_id=p_event_id and state in ('complete','partial','empty') order by checked_at desc limit 1)
 select l.listing_id,l.price_cents,l.basis,l.prefee_cents,l.sales_tax_cents,l.pre_tax_total_cents,l.lots,l.seats,l.section_group,l.section,l.row_label,o.checked_at,o.coverage
 from latest o join public.tix_listing_observations l on l.observation_id=o.id where p_qty between 1 and 8 and l.price_cents>0 and
 (l.verified_quantity=p_qty or (p_qty=any(l.lots) and jsonb_typeof(l.seats)='array' and jsonb_array_length(l.seats)>=p_qty))
 order by l.price_cents,l.ordinal limit 50 offset least(greatest(p_offset,0),10000);
$$;
create or replace function public.tix_capture_due(p_limit integer default 8)
returns setof public.tix_catalog language sql stable security invoker set search_path='' as $$
 select c.* from public.tix_catalog c join public.tix_capture_jobs j using(event_id)
 where c.event_date between current_date and current_date+365 and j.next_attempt_at<=now()
 and (exists(select 1 from public.tix_history_tracking t where t.event_id=c.event_id) or j.detail_requested)
 order by j.next_attempt_at,c.event_date limit least(greatest(p_limit,0),8);
$$;
create or replace function public.tix_claim_detail_dispatch(p_event_id text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(72634112);
 if not exists(select 1 from public.tix_provider_guard where id and enabled and suspended_at is null) then return false; end if;
 if exists(select 1 from public.tix_capture_jobs where dispatched_at>now()-interval '1 minute') then return false; end if;
 update public.tix_capture_jobs set dispatched_at=now() where event_id=p_event_id and detail_requested and state in ('metadata_only','partial','queued','failed') and
 (dispatched_at is null or dispatched_at<now()-interval '15 minutes');
 return found;
end $$;

-- Independent of sitemap success. Date-only events expire after their venue
-- calendar day has passed everywhere (UTC-12), never at a guessed start time.
create or replace function public.tix_expire_event_storage(p_limit integer default 100)
returns integer language plpgsql security definer set search_path='' as $$
declare ids text[]; n integer;
begin
 if not exists(select 1 from public.tix_provider_guard where id and expiry_enabled) then return 0; end if;
 perform pg_advisory_xact_lock(72634112);
 select array_agg(event_id) into ids from (select event_id from public.tix_catalog
 where event_date<(now() at time zone 'Etc/GMT+12')::date
 and not exists(select 1 from public.tix_capture_leases l where l.event_id=tix_catalog.event_id and l.expires_at>now())
 order by event_date limit least(greatest(p_limit,0),500) for update skip locked) x;
 delete from public.tix_provider_http where at<now()-interval '2 days';
 if ids is null then return 0; end if;
 delete from public.tix_prices where event_id=any(ids);
 delete from public.tix_alerts where event_id=any(ids);
 delete from public.tix_scans where event_id=any(ids);
 delete from public.tix_venue_clubs where sample_event_id=any(ids);
 delete from public.tix_event_changes where event_id=any(ids);
 delete from public.tix_catalog where event_id=any(ids); -- cascades observations, listings, jobs, tracking, interest and changes
 get diagnostics n=row_count;
 delete from public.tix_provider_http where at<now()-interval '2 days';
 return n;
end $$;

-- Replace the old anonymous scheduling write with an authenticated history-only
-- request. Existing anonymous browsing still reads prices; it cannot scrape.
create or replace function public.tix_request_price_check(p_event_id text)
returns boolean language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin result:=public.tix_request_capture(p_event_id,true); return result->>'state' not in ('expired','beyond_horizon','failed'); end $$;
revoke all on function public.tix_request_price_check(text) from public,anon;
grant execute on function public.tix_request_price_check(text) to authenticated;
create or replace function public.tix_requested_discovery(p_limit integer default 8)
returns setof public.tix_catalog language sql stable security invoker set search_path='' as $$
 select * from public.tix_capture_due(p_limit);
$$;
-- Grant only the explicitly intended RPC surfaces, never new definer defaults.
do $$ declare f record; begin
 for f in select p.oid::regprocedure signature,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in ('tix_request_capture','tix_claim_capture','tix_admit_provider_http','tix_suspend_provider','tix_release_capture','tix_finish_capture','tix_save_capture','tix_event_capture_status','tix_event_price_history','tix_event_listings','tix_capture_due','tix_claim_detail_dispatch','tix_expire_event_storage') loop
  execute format('revoke all on function %s from public,anon,authenticated',f.signature);
  execute format('grant execute on function %s to service_role',f.signature);
  if f.proname='tix_request_capture' then execute format('grant execute on function %s to authenticated',f.signature); end if;
  if f.proname in ('tix_event_capture_status','tix_event_price_history','tix_event_listings') then execute format('grant execute on function %s to anon,authenticated',f.signature); end if;
 end loop;
end $$;
commit;
