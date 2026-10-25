-- Keep discovery sorts narrow and coverage aggregates small on the full catalog.
-- No history, watch state, provider limits or visibility rules are changed.
begin;
set local lock_timeout='5s';

-- Matching the public view predicate lets coverage use a small index-only
-- scan without re-evaluating visibility expressions for every catalog row.
create index if not exists tix_catalog_visible_coverage
 on public.tix_catalog(event_date,category)
 include(event_id,min_total,price_checked_at,last_seen)
 where coalesce(slug,'') !~ '^(.*)-vs-\1$'
 and coalesce(name,'') !~* '(season tickets|season pass|parking only)';

create or replace function public.tix_catalog_health(p_category text default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 execute $health$
 with categories as materialized (
  select category,count(*) events,count(*) filter(where min_total>0) priced,
   count(*) filter(where min_total is null or min_total<=0) unpriced,
   count(*) filter(where min_total>0 and price_checked_at>now()-interval '24 hours') fresh,
   count(*) filter(where min_total>0 and (price_checked_at is null or price_checked_at<=now()-interval '24 hours')) stale,
   max(last_seen) last_catalog_at
  from public.tix_events_v
  where event_date between current_date and current_date+365 and ($1 is null or category=$1)
  group by category
 ), totals as (
  select coalesce(sum(events),0)::bigint events,coalesce(sum(priced),0)::bigint priced,
   coalesce(sum(unpriced),0)::bigint unpriced,coalesce(sum(fresh),0)::bigint fresh,
   coalesce(sum(stale),0)::bigint stale,max(last_catalog_at) last_catalog_at from categories
 ), teams as (
  select count(*) teams,count(*) filter(where checked_at is not null) teams_checked,
   count(*) filter(where failures>0) teams_failed from public.tix_teams where $1 is null or category=$1
 ), relevant_jobs as materialized (
  select event_id,state,detail_requested from public.tix_capture_jobs
  where state in ('failed','checking') or detail_requested
 ), jobs as (
  select count(*) filter(where j.state='failed' or (j.state='checking' and not exists(
   select 1 from public.tix_capture_leases l where l.event_id=j.event_id and l.expires_at>now()))) failed_checks,
   count(*) filter(where j.detail_requested or j.state='checking') pending_checks
  from relevant_jobs j join public.tix_events_v e using(event_id)
  where e.event_date between current_date and current_date+365 and ($1 is null or e.category=$1)
 ), collector as (
  select updated_at last_collector_at,case when v->>'status'='error' then 'failed'
   when updated_at<now()-interval '2 hours' then 'stale' else 'fresh' end state
  from public.tix_state where k='collector_health'
 )
 select jsonb_build_object('as_of',now(),'schema',20261017,'horizon_days',365,'freshness_hours',24,
  'collector_stale_minutes',120,'events',totals.events,'priced',totals.priced,'unpriced',totals.unpriced,
  'fresh',totals.fresh,'stale',totals.stale,'failed_checks',jobs.failed_checks,'pending_checks',jobs.pending_checks,
  'teams',teams.teams,'teams_checked',teams.teams_checked,'teams_failed',teams.teams_failed,
  'last_catalog_at',totals.last_catalog_at,'last_collector_at',(select last_collector_at from collector),
  'collector_state',coalesce((select state from collector),'unknown'),
  'provider_paused',coalesce((select not enabled or suspended_at is not null from public.tix_provider_guard where id),true),
  'categories',coalesce((select jsonb_agg(jsonb_build_object('category',category,'events',events,'priced',priced)
   order by category) from categories),'[]'::jsonb)) from totals cross join teams cross join jobs
 $health$ into result using p_category;
 return result;
end;
$$;

create or replace function public.tix_discovery_due(p_from_days integer,p_to_days integer,p_limit integer)
returns setof public.tix_catalog language sql stable security invoker set search_path='' as $discovery$
 with city_activity as materialized (
  select lower(coalesce(city,'')) city_key,state is null state_null,coalesce(state,'') state_key,
   max(discovery_attempt_at) last_attempt
  from public.tix_catalog group by lower(coalesce(city,'')),state is null,coalesce(state,'')
 ), candidates as materialized (
  -- Names, URLs and other wide fields never enter the window/join sorts.
  select event_id,event_date,discovery_attempt_at,lower(coalesce(city,'')) city_key,
   state is null state_null,coalesce(state,'') state_key
  from public.tix_events_v
  where event_date between current_date+greatest(p_from_days,0)
   and current_date+least(greatest(p_to_days,p_from_days),60)
   and (discovery_attempt_at is null or discovery_attempt_at<now()-interval '72 hours')
   and (price_checked_at is null or price_checked_at<now()-interval '24 hours')
 ), ranked as (
  select *,row_number() over(partition by city_key,state_null,state_key
   order by discovery_attempt_at asc nulls first,event_date,event_id) city_rank from candidates
 ), chosen as materialized (
  -- Ordinary equality keys allow a hash join. Null and empty states remain
  -- distinct without an IS NOT DISTINCT FROM join across every city/row.
  select r.event_id,r.event_date,r.city_rank,a.last_attempt
  from ranked r join city_activity a using(city_key,state_null,state_key)
  order by a.last_attempt asc nulls first,r.city_rank,r.event_date,r.event_id
  limit least(greatest(p_limit,0),40)
 )
 select c.* from chosen q join public.tix_catalog c using(event_id)
 order by q.last_attempt asc nulls first,q.city_rank,q.event_date,q.event_id;
$discovery$;
revoke all on function public.tix_discovery_due(integer,integer,integer) from public,anon,authenticated;
grant execute on function public.tix_discovery_due(integer,integer,integer) to service_role;

insert into public.tix_schema_versions(version) values(20261029) on conflict do nothing;
commit;
notify pgrst, 'reload schema';
