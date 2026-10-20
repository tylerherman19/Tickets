-- Runtime reliability, quick public quotes and requested-quantity warming.
-- Additive. Does not raise provider budgets, clear suspension or enable deletion.
begin;
create table if not exists public.tix_schema_versions(version integer primary key,applied_at timestamptz not null default now());
alter table public.tix_schema_versions enable row level security;
revoke all on public.tix_schema_versions from public,anon,authenticated;
grant select on public.tix_schema_versions to service_role;
alter table public.tix_capture_jobs add column if not exists requested_quantities integer[] not null default '{}';
alter table public.tix_capture_jobs add column if not exists warm_quantities integer[] not null default '{}';
alter table public.tix_capture_jobs add column if not exists requested_at_latest timestamptz;
alter table public.tix_capture_jobs add column if not exists detail_attempts integer not null default 0;
-- Quote age belongs to each seat count, not the latest unrelated check.
update public.tix_event_market m set by_qty=(select coalesce(jsonb_object_agg(key,value||jsonb_build_object('checked_at',m.checked_at)),'{}'::jsonb) from jsonb_each(m.by_qty)) where exists(select 1 from jsonb_each(m.by_qty) x where not x.value?'checked_at');
create table if not exists public.tix_quote_requests(actor text not null,anonymous boolean not null,at timestamptz not null default now(),cost integer not null check(cost between 1 and 12));
create index if not exists tix_quote_request_time on public.tix_quote_requests(at);
create index if not exists tix_quote_actor_time on public.tix_quote_requests(actor,at);
alter table public.tix_quote_requests enable row level security;
revoke all on public.tix_quote_requests from public,anon,authenticated;
grant all on public.tix_quote_requests to service_role;

create or replace function public.tix_public_quotes(p_event_ids text[],p_qty integer default 2)
returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('event_id',e.event_id,
  'state',case when coalesce((m.by_qty->p_qty::text->>'checked_at')::timestamptz,m.checked_at)>now()-interval '15 minutes' and (m.by_qty->p_qty::text->>'low')::integer>0 then 'complete'
   when m.checked_at>now()-interval '15 minutes' and coalesce((m.coverage->>'complete')::boolean,false) and coalesce((m.coverage->>'unknown_lots')::integer,0)=0 and coalesce((m.coverage->>'unknown_seats')::integer,0)=0 then 'unavailable'
   when e.price_checked_at>now()-interval '15 minutes' and e.min_total>0 then 'advertised' else 'queued' end,
  'min_total',case when e.price_checked_at>now()-interval '15 minutes' then e.min_total end,
  'checked_at',case when e.price_checked_at>now()-interval '15 minutes' then e.price_checked_at end,
  'market',case when m.checked_at>now()-interval '15 minutes' then jsonb_build_object('by_qty',m.by_qty,'checked_at',m.checked_at,'coverage',m.coverage) end,
  'next_attempt_at',j.next_attempt_at,'reason',j.reason)), '[]'::jsonb)
 from public.tix_events_v e left join public.tix_event_market m using(event_id) left join public.tix_capture_jobs j using(event_id)
 where e.event_id=any(p_event_ids) and cardinality(p_event_ids) between 1 and 12 and p_qty between 1 and 8
 and e.event_date between current_date and current_date+365;
$$;
revoke all on function public.tix_public_quotes(text[],integer) from public;
grant execute on function public.tix_public_quotes(text[],integer) to anon,authenticated,service_role;

create or replace function public.tix_request_quote(p_actor text,p_anonymous boolean,p_event_ids text[],p_qty integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare n integer;g public.tix_provider_guard;eid text;
begin
 if p_actor is null or p_event_ids is null or p_qty is null or p_actor !~ '^[a-f0-9]{64}$' or p_anonymous is null or cardinality(p_event_ids) not between 1 and 12 or p_qty not between 1 and 8 then raise exception 'Invalid quote request'; end if;
 perform pg_advisory_xact_lock(72634114);
 select * into g from public.tix_provider_guard where id;
 if not coalesce(g.enabled,false) or g.suspended_at is not null then return jsonb_build_object('allowed',false,'reason','provider_suspended');end if;
 select count(*) into n from public.tix_quote_requests where actor=p_actor and at>now()-interval '1 minute';
 if n>=(case when p_anonymous then 6 else 15 end) or (select coalesce(sum(cost),0) from public.tix_quote_requests where actor=p_actor and at>now()-interval '1 day')>=(case when p_anonymous then 120 else 500 end) then
  return jsonb_build_object('allowed',false,'reason','caller_limit','next_attempt_at',now()+interval '1 minute');end if;
 -- Shared anonymous ceiling remains effective even if a caller changes addresses.
 if p_anonymous and (select coalesce(sum(cost),0) from public.tix_quote_requests where anonymous and at>now()-interval '1 day')>=greatest(1,floor(g.day_limit*0.20)) then
  return jsonb_build_object('allowed',false,'reason','public_limit','next_attempt_at',now()+interval '15 minutes');end if;
 if exists(select 1 from unnest(p_event_ids) x where x !~ '^[a-f0-9]{24}$' or not exists(select 1 from public.tix_events_v e where e.event_id=x and e.event_date between current_date and current_date+365)) then raise exception 'Invalid catalog event';end if;
 delete from public.tix_quote_requests where at<now()-interval '1 day';
 insert into public.tix_quote_requests(actor,anonymous,cost) values(p_actor,p_anonymous,cardinality(p_event_ids));
 foreach eid in array p_event_ids loop
  insert into public.tix_capture_jobs(event_id,detail_requested,requested_quantities,warm_quantities,requested_at_latest,state,next_attempt_at)
  values(eid,true,array[p_qty],array[p_qty],now(),'queued',now())
  on conflict(event_id) do update set detail_requested=true,requested_at_latest=now(),
   warm_quantities=array(select distinct x from unnest(public.tix_capture_jobs.warm_quantities||array[p_qty]) x order by x),
   requested_quantities=array(select distinct x from unnest(public.tix_capture_jobs.requested_quantities||array[p_qty]) x order by x),
   detail_attempts=case when public.tix_capture_jobs.requested_at_latest<now()-interval '15 minutes' then 0 else public.tix_capture_jobs.detail_attempts end,
   next_attempt_at=case when public.tix_capture_jobs.reason is null or public.tix_capture_jobs.reason='details_unavailable' then least(public.tix_capture_jobs.next_attempt_at,now()) else public.tix_capture_jobs.next_attempt_at end;
 end loop;
 return jsonb_build_object('allowed',true);
end $$;
revoke all on function public.tix_request_quote(text,boolean,text[],integer) from public,anon,authenticated;
grant execute on function public.tix_request_quote(text,boolean,text[],integer) to service_role;


create or replace function public.tix_claim_capture(p_event_id text,p_source text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare g public.tix_provider_guard; token uuid; e public.tix_catalog; sample public.tix_event_observations; j public.tix_capture_jobs; active integer;
begin
 perform pg_advisory_xact_lock(72634112);
 select * into g from public.tix_provider_guard where id;
 if not coalesce(g.enabled,false) or g.suspended_at is not null then return jsonb_build_object('state','suspended','reason',coalesce(g.suspension_reason,'rollout_disabled')); end if;
 if p_source not in ('edge','interactive','warm','collector','detail','catalog','discovery','tracked') then raise exception 'Invalid capture source'; end if;
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
  if sample.checked_at>now()-interval '15 minutes' and (p_source in ('edge','discovery','tracked') or (sample.state in ('complete','empty') and not exists(select 1 from unnest(j.requested_quantities) q where not coalesce((sample.by_qty->q::text->>'low')::integer>0,false)))) then
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
 if active>=(case when p_source in ('catalog','discovery','tracked','collector','warm') then greatest(1,g.max_concurrent-2) else g.max_concurrent end) or (p_event_id is not null and exists(select 1 from public.tix_capture_leases where event_id=p_event_id)) then
  return jsonb_build_object('state','queued','reason','provider_busy','next_attempt_at',now()+interval '5 seconds');
 end if;
 insert into public.tix_capture_leases(event_id,source,expires_at) values(p_event_id,p_source,now()+interval '60 seconds') returning tix_capture_leases.token into token;
 if p_event_id is not null then
  insert into public.tix_capture_jobs(event_id,state,last_attempt_at,detail_requested) values(p_event_id,'checking',now(),false)
  on conflict(event_id) do update set state='checking',last_attempt_at=now(),reason=null;
 end if;
 return jsonb_build_object('state','checking','token',token);
end $$;

create or replace function public.tix_admit_provider_http(p_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare g public.tix_provider_guard; l public.tix_capture_leases; n1 integer;n2 integer;n3 integer; m1 integer;m2 integer;m3 integer; share numeric; wait_at timestamptz;
begin
 perform pg_advisory_xact_lock(72634112);
 select * into g from public.tix_provider_guard where id;
 select * into l from public.tix_capture_leases where token=p_token and expires_at>now();
 if l.token is null or not g.enabled or g.suspended_at is not null then return jsonb_build_object('allowed',false,'reason','suspended_or_lease_expired'); end if;
 share:=case when l.source in ('catalog','discovery') then least(g.background_share,0.55) when l.source in ('tracked','collector','warm') then 0.85 else 1 end;
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

create or replace function public.tix_save_capture(p_token uuid,p_capture jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare l public.tix_capture_leases; oid uuid; item jsonb; pos bigint; s text:=p_capture->>'state'; ts timestamptz:=now(); next_at timestamptz; raw jsonb; qty_rows jsonb; pending integer[]; pending_attempts integer; old_event public.tix_catalog; price integer:=(p_capture->>'min_total')::integer;
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
 select * into old_event from public.tix_catalog where event_id=l.event_id;
 -- A metadata-only page without a get-in amount is not evidence of a new
 -- price: keep the saved price and its timestamp.
 if s<>'empty' and price is null then
  update public.tix_catalog set discovery_attempt_at=ts where event_id=l.event_id;
 else
  update public.tix_catalog set price_checked_at=ts,discovery_attempt_at=ts,discovery_status=case when s='metadata_only' then 'metadata_only' else 'ok' end,
  min_total=price where event_id=l.event_id;
 end if;
 select coalesce(jsonb_object_agg(key,value||jsonb_build_object('checked_at',ts)),'{}'::jsonb) into qty_rows from jsonb_each(coalesce(p_capture->'by_qty','{}'::jsonb));
 if s<>'metadata_only' then
  insert into public.tix_event_market(event_id,checked_at,by_qty,groups,listing_count,coverage)
  values(l.event_id,ts,qty_rows,p_capture->'groups',jsonb_array_length(p_capture->'listings'),p_capture->'coverage')
  on conflict(event_id) do update set checked_at=excluded.checked_at,by_qty=case when s='partial' then (select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) from jsonb_each(public.tix_event_market.by_qty) x where coalesce((value->>'checked_at')::timestamptz,public.tix_event_market.checked_at)>ts-interval '15 minutes')||excluded.by_qty else excluded.by_qty end,groups=excluded.groups,listing_count=excluded.listing_count,coverage=excluded.coverage;
 end if;
 -- Catalog metadata, change history and market evidence share this transaction.
 if nullif(p_capture->'meta'->>'datetime_local','') is not null and old_event.datetime_local is not null and old_event.datetime_local is distinct from p_capture->'meta'->>'datetime_local' then
  insert into public.tix_event_changes(event_id,field,old_value,new_value,detected_at) values(l.event_id,'datetime_local',old_event.datetime_local,p_capture->'meta'->>'datetime_local',ts);
 end if;
 if nullif(p_capture->'meta'->>'venue','') is not null and old_event.venue is not null and old_event.venue is distinct from p_capture->'meta'->>'venue' then
  insert into public.tix_event_changes(event_id,field,old_value,new_value,detected_at) values(l.event_id,'venue',old_event.venue,p_capture->'meta'->>'venue',ts);
 end if;
 update public.tix_catalog set name=coalesce(nullif(p_capture->'meta'->>'name',''),name),
  datetime_local=coalesce(nullif(p_capture->'meta'->>'datetime_local',''),datetime_local),
  event_date=case when p_capture->'meta'->>'datetime_local' ~ '^\d{4}-\d{2}-\d{2}T' then left(p_capture->'meta'->>'datetime_local',10)::date else event_date end,
  venue=coalesce(nullif(p_capture->'meta'->>'venue',''),venue),last_seen=ts where event_id=l.event_id;
 if s<>'metadata_only' and jsonb_array_length(coalesce(p_capture->'groups','[]'::jsonb))>0 and old_event.venue_slug is not null then
  insert into public.tix_venue_clubs(venue_slug,venue,clubs,sample_event_id,updated_at)
  values(old_event.venue_slug,coalesce(p_capture->'meta'->>'venue',old_event.venue),p_capture->'groups',l.event_id,ts)
  on conflict(venue_slug) do update set clubs=excluded.clubs,sample_event_id=excluded.sample_event_id,updated_at=excluded.updated_at;
 end if;
 select array(select q from unnest(j.requested_quantities) q where not coalesce((p_capture->'coverage'->>'complete')::boolean,false) and not coalesce((p_capture->'by_qty'->q::text->>'low')::integer>0,false)),
  j.detail_attempts+case when l.source='detail' then 1 else 0 end into pending,pending_attempts from public.tix_capture_jobs j where j.event_id=l.event_id;
 select ts+case when exists(select 1 from public.tix_capture_jobs j where j.event_id=l.event_id and j.requested_at_latest>ts-interval '1 day') or exists(select 1 from public.tix_history_tracking t where t.event_id=l.event_id and t.created_at>ts-interval '1 day') then interval '15 minutes'
  when event_date<=current_date+14 then interval '1 hour' else interval '3 hours' end into next_at from public.tix_catalog where event_id=l.event_id;
 update public.tix_capture_jobs set state=s,reason=case when cardinality(pending)>0 and pending_attempts>=3 then 'details_unavailable' end,
  requested_quantities=coalesce(pending,'{}'),detail_attempts=coalesce(pending_attempts,0),detail_requested=cardinality(coalesce(pending,'{}'))>0,
  next_attempt_at=case when cardinality(pending)>0 then ts+case when pending_attempts>=3 then interval '15 minutes' when l.source='detail' then interval '15 seconds' else interval '0 seconds' end else next_at end,last_attempt_at=ts where event_id=l.event_id;
 return oid;
end $$;


-- Warm-worker selection. The lease still atomically decides which worker owns it.
create or replace function public.tix_quick_due(p_limit integer default 3)
returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from (
 select c.event_id,c.url,j.detail_requested,j.requested_quantities,j.warm_quantities from public.tix_capture_jobs j join public.tix_events_v c using(event_id)
 where (j.detail_requested and cardinality(j.requested_quantities)>0 or j.requested_at_latest>now()-interval '1 day' and cardinality(j.warm_quantities)>0) and j.next_attempt_at<=now()
 and c.event_date between current_date and current_date+365
 and not exists(select 1 from public.tix_capture_leases l where l.event_id=j.event_id and l.expires_at>now())
 order by j.detail_requested desc,j.next_attempt_at,j.requested_at_latest desc limit least(greatest(p_limit,1),6)) x;
$$;
revoke all on function public.tix_quick_due(integer) from public,anon,authenticated;
grant execute on function public.tix_quick_due(integer) to service_role;
create or replace function public.tix_capture_due(p_limit integer default 8)
returns setof public.tix_catalog language sql stable security invoker set search_path='' as $$
 select c.* from public.tix_catalog c join public.tix_capture_jobs j using(event_id)
 where c.event_date between current_date and current_date+365 and j.next_attempt_at<=now()
 and (j.detail_requested or j.requested_at_latest>now()-interval '1 day' or exists(select 1 from public.tix_history_tracking t where t.event_id=c.event_id and t.created_at>now()-interval '7 days'))
 and not exists(select 1 from public.tix_capture_leases l where l.event_id=j.event_id and l.expires_at>now())
 order by j.detail_requested desc,j.next_attempt_at,c.event_date limit least(greatest(p_limit,0),60);
$$;
create or replace function public.tix_touch_quotes(p_event_ids text[],p_qty integer)
returns void language plpgsql security definer set search_path='' as $$
begin
 if cardinality(p_event_ids) not between 1 and 12 or p_qty not between 1 and 8 then return;end if;
 insert into public.tix_capture_jobs(event_id,warm_quantities,requested_at_latest,detail_requested,next_attempt_at)
 select e.event_id,array[p_qty],now(),false,now()+interval '15 minutes' from public.tix_events_v e
 where e.event_id=any(p_event_ids) and e.event_date between current_date and current_date+365 and (select count(*) from public.tix_capture_jobs)<5000
 on conflict(event_id) do update set requested_at_latest=now(),warm_quantities=array(select distinct x from unnest(public.tix_capture_jobs.warm_quantities||array[p_qty]) x order by x)
 where public.tix_capture_jobs.requested_at_latest is null or public.tix_capture_jobs.requested_at_latest<now()-interval '1 minute' or not(p_qty=any(public.tix_capture_jobs.warm_quantities));
end $$;
revoke all on function public.tix_touch_quotes(text[],integer) from public,anon,authenticated;
grant execute on function public.tix_touch_quotes(text[],integer) to service_role;
insert into public.tix_schema_versions(version) values(20261020) on conflict do nothing;
commit;
notify pgrst,'reload schema';
