-- Preserve price history separately from bulky individual listing copies.
-- Creating this schema does not enable or perform deletion.
begin;
create table if not exists public.tix_listing_price_rollup(
 observation_id uuid not null references public.tix_event_observations(id) on delete cascade,
 qty integer not null check(qty between 1 and 8),basis text not null,section text not null default '',
 low integer not null check(low>0),listing_count bigint not null,primary key(observation_id,qty,basis,section)
);
alter table public.tix_listing_price_rollup enable row level security;
drop policy if exists "public listing price history" on public.tix_listing_price_rollup;
create policy "public listing price history" on public.tix_listing_price_rollup for select to anon,authenticated using(true);
grant select on public.tix_listing_price_rollup to anon,authenticated;
grant all on public.tix_listing_price_rollup to service_role;
create or replace function public.tix_rollup_prices(p_observation uuid default null) returns void language sql security definer set search_path='' as $$
 insert into public.tix_listing_price_rollup(observation_id,qty,basis,section,low,listing_count)
 select l.observation_id,q.qty,l.basis,area.section,min(l.price_cents),count(*)
 from public.tix_listing_observations l cross join generate_series(1,8) q(qty)
 cross join lateral(select distinct x.section from (values(''::text),(l.section),(l.section_group)) x(section) where x.section is not null) area
 where (p_observation is null or l.observation_id=p_observation) and l.price_cents>0 and l.basis in('fees_included_tax_reported','fees_included_tax_unknown')
 and (l.verified_quantity=q.qty or q.qty=any(l.lots) and jsonb_typeof(l.seats)='array' and jsonb_array_length(l.seats)>=q.qty)
 group by l.observation_id,q.qty,l.basis,area.section
 on conflict(observation_id,qty,basis,section) do update set low=excluded.low,listing_count=excluded.listing_count;
$$;
revoke all on function public.tix_rollup_prices(uuid) from public,anon,authenticated;
grant execute on function public.tix_rollup_prices(uuid) to service_role;
select public.tix_rollup_prices(null);

create or replace function public.tix_event_comparable_history(p_event_id text,p_qty integer default 0,p_basis text default 'provider_get_in_tax_quantity_unconfirmed',p_section text default null)
returns table(checked_at timestamptz,price_cents integer,basis text,qty integer,section text,listing_count bigint,state text)
language sql stable security definer set search_path='' as $$
 with samples as (
  select o.id,o.checked_at,o.min_total price_cents,o.get_in_basis basis,0 qty,null::text section,o.listing_count::bigint listing_count,o.state
  from public.tix_event_observations o where o.event_id=p_event_id and p_qty=0 and p_section is null and o.min_total>0 and o.get_in_basis=p_basis and o.state<>'failed'
  union all
  select o.id,o.checked_at,r.low,r.basis,r.qty,p_section,r.listing_count,o.state
  from public.tix_event_observations o join public.tix_listing_price_rollup r on r.observation_id=o.id
  where o.event_id=p_event_id and p_qty between 1 and 8 and r.qty=p_qty and r.basis=p_basis and r.section=coalesce(p_section,'') and o.state in('complete','partial')
 ), hourly as(select distinct on(date_trunc('hour',s.checked_at)) s.* from samples s order by date_trunc('hour',s.checked_at) desc,s.checked_at desc,s.id desc limit 366)
 select h.checked_at,h.price_cents,h.basis,h.qty,h.section,h.listing_count,h.state from hourly h order by h.checked_at;
$$;
create table if not exists public.tix_storage_policy(id boolean primary key default true check(id),listing_retention_enabled boolean not null default false);
insert into public.tix_storage_policy(id) values(true) on conflict do nothing;
alter table public.tix_storage_policy enable row level security;
revoke all on public.tix_storage_policy from public,anon,authenticated;
grant all on public.tix_storage_policy to service_role;

create or replace function public.tix_prune_listing_copies(p_execute boolean default false,p_limit integer default 5000)
returns jsonb language plpgsql security definer set search_path='' as $$
declare n integer;eligible bigint;
begin
 if p_execute is distinct from true then
  select count(*) into eligible from public.tix_listing_observations l join public.tix_event_observations o on o.id=l.observation_id where o.checked_at<now()-interval '1 day';
  return jsonb_build_object('eligible_rows',eligible,'enabled',(select listing_retention_enabled from public.tix_storage_policy where id));
 end if;
 if not coalesce((select listing_retention_enabled from public.tix_storage_policy where id),false) then raise exception 'Owner approval for listing retention is required';end if;
 if not pg_try_advisory_xact_lock(72634124) then return jsonb_build_object('deleted',0,'busy',true);end if;
 -- Rollups must exist before any raw detail is removed, including section history.
 -- Metadata-only observations and explicit empty inventories have no raw rows.
 with due as(select l.observation_id,l.ordinal from public.tix_listing_observations l join public.tix_event_observations o on o.id=l.observation_id
 where o.checked_at<now()-interval '1 day'
 and not exists(select 1 from generate_series(1,8) q(qty) cross join lateral(select distinct x.section from(values(''::text),(l.section),(l.section_group)) x(section) where x.section is not null) a
  where (l.verified_quantity=q.qty or q.qty=any(l.lots) and jsonb_typeof(l.seats)='array' and jsonb_array_length(l.seats)>=q.qty)
  and l.price_cents>0 and l.basis in('fees_included_tax_reported','fees_included_tax_unknown')
  and not exists(select 1 from public.tix_listing_price_rollup r where r.observation_id=l.observation_id and r.qty=q.qty and r.basis=l.basis and r.section=a.section))
 order by o.checked_at,l.observation_id,l.ordinal limit least(greatest(p_limit,1),10000) for update of l skip locked)
 delete from public.tix_listing_observations l using due d where l.observation_id=d.observation_id and l.ordinal=d.ordinal;
 get diagnostics n=row_count;
 return jsonb_build_object('deleted',n);
end $$;
revoke all on function public.tix_prune_listing_copies(boolean,integer) from public,anon,authenticated;
grant execute on function public.tix_prune_listing_copies(boolean,integer) to service_role;

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
 perform public.tix_rollup_prices(oid);
 return oid;
end $$;


insert into public.tix_schema_versions(version) values(20261024) on conflict do nothing;
commit;
notify pgrst,'reload schema';
