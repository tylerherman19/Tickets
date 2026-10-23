-- Match the collector's two-minute scheduling tolerance at admission too.
-- Interactive caches, provider limits and leases retain their existing rules.
begin;
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
  if sample.checked_at>now()-(case when p_source='collector' then interval '13 minutes' else interval '15 minutes' end) and (p_source in ('edge','discovery','tracked') or (sample.state in ('complete','empty') and not exists(select 1 from unnest(j.requested_quantities) q where not coalesce((sample.by_qty->q::text->>'low')::integer>0,false)))) then
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


insert into public.tix_schema_versions(version) values(20261028) on conflict do nothing;
commit;
notify pgrst, 'reload schema';
