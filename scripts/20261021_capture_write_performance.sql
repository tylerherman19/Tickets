-- Keep capture writes bounded to the current observation. No retention or
-- provider-budget changes. Apply after storage policy version 20261024.
begin;
create or replace function public.tix_rollup_prices(p_observation uuid default null)
returns void language plpgsql security definer set search_path='' as $$
begin
 -- Separate the explicit backfill from the hot path so a cached generic plan
 -- cannot scan every saved listing while a capture holds the provider lock.
 if p_observation is null then
 insert into public.tix_listing_price_rollup(observation_id,qty,basis,section,low,listing_count)
 select l.observation_id,q.qty,l.basis,area.section,min(l.price_cents),count(*)
 from public.tix_listing_observations l cross join generate_series(1,8) q(qty)
 cross join lateral(select distinct x.section from (values(''::text),(l.section),(l.section_group)) x(section) where x.section is not null) area
 where l.price_cents>0 and l.basis in('fees_included_tax_reported','fees_included_tax_unknown')
 and (l.verified_quantity=q.qty or q.qty=any(l.lots) and jsonb_typeof(l.seats)='array' and jsonb_array_length(l.seats)>=q.qty)
 group by l.observation_id,q.qty,l.basis,area.section
 on conflict(observation_id,qty,basis,section) do update set low=excluded.low,listing_count=excluded.listing_count;
 else
 insert into public.tix_listing_price_rollup(observation_id,qty,basis,section,low,listing_count)
 select l.observation_id,q.qty,l.basis,area.section,min(l.price_cents),count(*)
 from public.tix_listing_observations l cross join generate_series(1,8) q(qty)
 cross join lateral(select distinct x.section from (values(''::text),(l.section),(l.section_group)) x(section) where x.section is not null) area
 where l.observation_id=p_observation and l.price_cents>0 and l.basis in('fees_included_tax_reported','fees_included_tax_unknown')
 and (l.verified_quantity=q.qty or q.qty=any(l.lots) and jsonb_typeof(l.seats)='array' and jsonb_array_length(l.seats)>=q.qty)
 group by l.observation_id,q.qty,l.basis,area.section
 on conflict(observation_id,qty,basis,section) do update set low=excluded.low,listing_count=excluded.listing_count;
 end if;
end $$;

create or replace function public.tix_save_capture(p_token uuid,p_capture jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare l public.tix_capture_leases; oid uuid; s text:=p_capture->>'state'; ts timestamptz:=now(); next_at timestamptz; qty_rows jsonb; pending integer[]; pending_attempts integer; old_event public.tix_catalog; price integer:=(p_capture->>'min_total')::integer;
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
 -- Persist the listing batch in one statement rather than invoking one INSERT
 -- and its foreign-key checks for every card under the shared capture lock.
 insert into public.tix_listing_observations(observation_id,ordinal,listing_id,price_cents,basis,prefee_cents,sales_tax_cents,pre_tax_total_cents,lots,seats,section_group,section,row_label,verified_quantity,provider)
 select oid,pos,item->>'listing_id',(item->>'price_cents')::integer,item->>'basis',
  (item->>'prefee_cents')::integer,(item->>'sales_tax_cents')::integer,(item->>'pre_tax_total_cents')::integer,
  case when jsonb_typeof(item->'lots')='array' then array(select jsonb_array_elements_text(item->'lots')::integer) end,
  item->'provider'->'seats',item->>'section_group',item->>'section',item->>'row_label',(item->>'verified_quantity')::integer,item->'provider'
 from jsonb_array_elements(p_capture->'listings') with ordinality as batch(item,pos);
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
insert into public.tix_schema_versions(version) values(20261025) on conflict do nothing;
commit;
notify pgrst,'reload schema';
