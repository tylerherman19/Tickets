-- Public discovery needs its own bounded scan lifecycle; catalog sitemap visits
-- are not evidence that a ticket price was checked.
begin;
alter table public.tix_catalog add column if not exists discovery_attempt_at timestamptz;
alter table public.tix_catalog add column if not exists discovery_status text;
alter table public.tix_catalog drop constraint if exists tix_catalog_discovery_status_check;
alter table public.tix_catalog add constraint tix_catalog_discovery_status_check
  check (discovery_status in ('ok','parser_failure','event_unavailable','http_failure'));
create index if not exists tix_catalog_discovery_due
  on public.tix_catalog(discovery_attempt_at,event_date,event_id);
create or replace view public.tix_events_v with (security_invoker=true) as
select * from public.tix_catalog where coalesce(slug,'') !~ '^(.*)-vs-\1$'
and coalesce(name,'') !~* '(season tickets|season pass|parking only)';

-- The public can read catalog prices, but only the collector service may ask
-- the database which event pages to fetch next. Round-robin by city so one
-- large market cannot consume the entire discovery budget.
create or replace function public.tix_discovery_due(p_from_days integer, p_to_days integer,
  p_limit integer)
returns setof public.tix_catalog language sql stable security invoker set search_path='' as $$
with city_activity as (
  select lower(coalesce(city,'')) city_key,state,max(discovery_attempt_at) last_attempt
  from public.tix_catalog
  group by lower(coalesce(city,'')),state
), ranked as (
  select c.*, row_number() over (
    partition by lower(coalesce(c.city,'')),c.state
    order by c.discovery_attempt_at asc nulls first,c.event_date,c.event_id
  ) as city_rank
  from public.tix_events_v c
  where c.event_date between current_date + greatest(p_from_days,0)
    and current_date + least(greatest(p_to_days,p_from_days),60)
    and (c.discovery_attempt_at is null or c.discovery_attempt_at < now()-interval '72 hours')
)
select r.event_id,r.category,r.slug,r.name,r.event_date,r.datetime_local,r.venue_slug,r.venue,
  r.city,r.state,r.url,r.min_total,r.last_seen,r.price_checked_at,r.discovery_attempt_at,r.discovery_status
from ranked r join city_activity a
  on a.city_key=lower(coalesce(r.city,'')) and a.state is not distinct from r.state
order by a.last_attempt asc nulls first,r.city_rank,r.event_date,r.event_id
limit least(greatest(p_limit,0),40);
$$;
revoke all on function public.tix_discovery_due(integer,integer,integer) from public,anon,authenticated;
grant execute on function public.tix_discovery_due(integer,integer,integer) to service_role;

-- Market samples are per event. The older venue-wide sample remains for
-- seat-group hints but must not be used as an event's exact-quantity price.
create table if not exists public.tix_event_market (
  event_id text primary key references public.tix_catalog(event_id) on delete cascade,
  checked_at timestamptz not null,
  by_qty jsonb not null default '{}'::jsonb,
  groups jsonb not null default '[]'::jsonb,
  listing_count integer not null default 0
);
alter table public.tix_event_market enable row level security;
grant select on public.tix_event_market to anon,authenticated;
create policy "public read event market" on public.tix_event_market
  for select to anon,authenticated using (true);
commit;
