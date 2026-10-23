-- Scan visible catalog rows once, then hash-join the materialized event IDs.
-- Avoid repeating expensive visibility predicates for every capture job.
begin;

create or replace function public.tix_catalog_health(p_category text default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 -- Plan for the actual category. A generic SQL-function plan badly
 -- underestimates the all-category catalog and takes over twelve seconds.
 execute $health$
 with events as materialized (select event_id,category,min_total,price_checked_at,last_seen from public.tix_events_v where event_date between current_date and current_date+365 and ($1 is null or category=$1)),
 totals as (select count(*) events,count(*) filter(where min_total>0) priced,count(*) filter(where min_total is null or min_total<=0) unpriced,
  count(*) filter(where min_total>0 and price_checked_at>now()-interval '24 hours') fresh,
  count(*) filter(where min_total>0 and (price_checked_at is null or price_checked_at<=now()-interval '24 hours')) stale,max(last_seen) last_catalog_at from events),
 teams as(select count(*) teams,count(*) filter(where checked_at is not null) teams_checked,count(*) filter(where failures>0) teams_failed from public.tix_teams where $1 is null or category=$1),
 jobs as(select count(*) filter(where j.state='failed' or (j.state='checking' and not exists(select 1 from public.tix_capture_leases l where l.event_id=j.event_id and l.expires_at>now()))) failed_checks,
  count(*) filter(where j.detail_requested or j.state='checking') pending_checks from public.tix_capture_jobs j join events e using(event_id)),
 collector as(select updated_at last_collector_at,case when v->>'status'='error' then 'failed' when updated_at<now()-interval '2 hours' then 'stale' else 'fresh' end state from public.tix_state where k='collector_health')
 select jsonb_build_object('as_of',now(),'schema',20261017,'horizon_days',365,'freshness_hours',24,'collector_stale_minutes',120,'events',totals.events,'priced',totals.priced,'unpriced',totals.unpriced,'fresh',totals.fresh,'stale',totals.stale,
  'failed_checks',jobs.failed_checks,'pending_checks',jobs.pending_checks,'teams',teams.teams,'teams_checked',teams.teams_checked,'teams_failed',teams.teams_failed,
  'last_catalog_at',totals.last_catalog_at,'last_collector_at',(select last_collector_at from collector),'collector_state',coalesce((select state from collector),'unknown'),
  'provider_paused',coalesce((select not enabled or suspended_at is not null from public.tix_provider_guard where id),true),
  'categories',coalesce((select jsonb_agg(r order by r.category) from (select category,count(*) events,count(*) filter(where min_total>0) priced from events group by category) r),'[]'::jsonb))
 from totals cross join teams cross join jobs
 $health$ into result using p_category;
 return result;
end;
$$;

create or replace function public.tix_runtime_health() returns jsonb language sql stable security definer set search_path='' as $$
 with overdue as materialized (select md5(w.id::text||':'||e.event_id||':'||w.criteria_version::text) key,s.last_success_at from public.tix_watch_events e join public.tix_watches w on w.id=e.watch_id join public.tix_events_v c using(event_id) left join public.tix_scans s on s.watch_id=w.id and s.event_id=e.event_id and s.criteria_version=w.criteria_version where w.active and w.purchased_at is null and coalesce(w.match->>'archived_at','')='' and not (coalesce(w.match->'excluded_event_ids','[]'::jsonb) ? e.event_id) and e.criteria_version=w.criteria_version and c.event_date between current_date and current_date+365 and (s.last_success_at is null or s.last_success_at<now()-interval '30 minutes'))
 select jsonb_build_object('schema',(select max(version) from public.tix_schema_versions),'generated_at',now(),
 'overdue_alert_events',(select count(*) from overdue),
 'overdue_alert_progress',(select coalesce(jsonb_object_agg(key,last_success_at),'{}'::jsonb) from overdue),
 'unresolved_alerts',(select count(*) from public.tix_watches w where w.active and w.purchased_at is null and coalesce(w.match->>'archived_at','')='' and w.criteria_updated_at<now()-interval '30 minutes' and not exists(select 1 from public.tix_watch_events e join public.tix_events_v c using(event_id) where e.watch_id=w.id and not (coalesce(w.match->'excluded_event_ids','[]'::jsonb) ? e.event_id) and e.criteria_version=w.criteria_version and c.event_date>=current_date)),
 'delivery_uncertain',(select count(*) from public.tix_delivery_outbox where state='uncertain' or state='sending' and lease_until<now()),
 'delivery_failed',(select count(*) from public.tix_delivery_outbox where state='failed'),
 'delivery_accepted_24h',(select count(*) from public.tix_delivery_outbox where state='accepted' and accepted_at>now()-interval '1 day'),
 'oldest_quote_wait_seconds',(select extract(epoch from now()-min(requested_at_latest))::integer from public.tix_capture_jobs where detail_requested and requested_at_latest>now()-interval '1 day'),
 'quote_worker',(select v from public.tix_state where k='quote_worker_health'),
 'backup',(select v from public.tix_state where k='backup_health'));
$$;
revoke all on function public.tix_runtime_health() from public,anon,authenticated;
grant execute on function public.tix_runtime_health() to service_role;



insert into public.tix_schema_versions(version) values(20261027) on conflict do nothing;
commit;
notify pgrst, 'reload schema';
