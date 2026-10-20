-- Keep general browsing from filling the selected-seat queue.
begin;
create or replace function public.tix_request_quote(p_actor text,p_anonymous boolean,p_event_ids text[],p_qty integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare n integer;g public.tix_provider_guard;eid text;
begin
 if p_actor is null or p_event_ids is null or p_qty is null or p_actor !~ '^[a-f0-9]{64}$' or p_anonymous is null or cardinality(p_event_ids) not between 1 and 12 or p_qty not between 0 and 8 then raise exception 'Invalid quote request'; end if;
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
 -- Zero is an advertised-price admission; it must not queue seat-detail work.
 if p_qty=0 then return jsonb_build_object('allowed',true);end if;
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


create or replace function public.tix_quick_due(p_limit integer default 3)
returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from (
 select c.event_id,c.url,j.detail_requested,j.requested_quantities,j.warm_quantities from public.tix_capture_jobs j join public.tix_events_v c using(event_id)
 where (j.detail_requested and cardinality(j.requested_quantities)>0 or j.requested_at_latest>now()-interval '1 day' and cardinality(j.warm_quantities)>0) and j.next_attempt_at<=now()
 and c.event_date between current_date and current_date+365
 and not exists(select 1 from public.tix_capture_leases l where l.event_id=j.event_id and l.expires_at>now())
 order by j.detail_requested desc,(j.requested_at_latest<now()-interval '2 minutes') desc,j.requested_at_latest desc,j.next_attempt_at limit least(greatest(p_limit,1),6)) x;
$$;
revoke all on function public.tix_quick_due(integer) from public,anon,authenticated;
grant execute on function public.tix_quick_due(integer) to service_role;
create or replace function public.tix_runtime_health() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('schema',20261022,'generated_at',now(),
 'overdue_alert_events',(select count(*) from public.tix_watch_events e join public.tix_watches w on w.id=e.watch_id join public.tix_events_v c using(event_id) left join public.tix_scans s on s.watch_id=w.id and s.event_id=e.event_id and s.criteria_version=w.criteria_version where w.active and w.purchased_at is null and coalesce(w.match->>'archived_at','')='' and e.criteria_version=w.criteria_version and c.event_date between current_date and current_date+365 and (s.last_success_at is null or s.last_success_at<now()-interval '30 minutes')),
 'unresolved_alerts',(select count(*) from public.tix_watches w where w.active and w.purchased_at is null and coalesce(w.match->>'archived_at','')='' and w.criteria_updated_at<now()-interval '30 minutes' and not exists(select 1 from public.tix_watch_events e join public.tix_events_v c using(event_id) where e.watch_id=w.id and e.criteria_version=w.criteria_version and c.event_date>=current_date)),
 'delivery_uncertain',(select count(*) from public.tix_delivery_outbox where state='uncertain' or state='sending' and lease_until<now()),
 'delivery_failed',(select count(*) from public.tix_delivery_outbox where state='failed'),
 'delivery_accepted_24h',(select count(*) from public.tix_delivery_outbox where state='accepted' and accepted_at>now()-interval '1 day'),
 'oldest_quote_wait_seconds',(select extract(epoch from now()-min(requested_at_latest))::integer from public.tix_capture_jobs where detail_requested and requested_at_latest>now()-interval '1 day'),
 'quote_worker',(select v from public.tix_state where k='quote_worker_health'),
 'backup',(select v from public.tix_state where k='backup_health'));
$$;
revoke all on function public.tix_runtime_health() from public,anon,authenticated;
grant execute on function public.tix_runtime_health() to service_role;

insert into public.tix_schema_versions(version) values(20261022) on conflict do nothing;
commit;
notify pgrst,'reload schema';
