-- Keep coverage below public API timeouts on the full catalog.
-- Materialize only required fields. Join the small job set directly to the
-- indexed catalog instead of the unindexed, parameter-estimated CTE.
-- Existing market visibility predicates, grants and provider limits remain.
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
  count(*) filter(where j.detail_requested or j.state='checking') pending_checks from public.tix_capture_jobs j join public.tix_events_v e using(event_id)
  where e.event_date between current_date and current_date+365 and ($1 is null or e.category=$1)),
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

commit;
notify pgrst, 'reload schema';
