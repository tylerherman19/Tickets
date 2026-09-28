-- Let a public search request a bounded, near-term price check without giving
-- anonymous visitors write access to the catalog or collector tables.
begin;

create table if not exists public.tix_discovery_interest (
  event_id text primary key references public.tix_catalog(event_id) on delete cascade,
  requested_at timestamptz not null default now()
);
create index if not exists tix_discovery_interest_recent
  on public.tix_discovery_interest(requested_at desc);
alter table public.tix_discovery_interest enable row level security;
revoke all on public.tix_discovery_interest from anon,authenticated;

create or replace function public.tix_request_price_check(p_event_id text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare changed integer;
begin
  if p_event_id is null or p_event_id !~ '^[0-9a-f]{24}$' then return false; end if;
  if not exists (
    select 1 from public.tix_events_v e
    where e.event_id=p_event_id
      and e.event_date between current_date and current_date + 30
  ) then return false; end if;
  insert into public.tix_discovery_interest(event_id,requested_at)
  values (p_event_id,now())
  on conflict (event_id) do update set requested_at=excluded.requested_at
    where public.tix_discovery_interest.requested_at < now()-interval '15 minutes';
  get diagnostics changed = row_count;
  return changed=1;
end;
$$;
revoke all on function public.tix_request_price_check(text) from public,anon,authenticated;
grant execute on function public.tix_request_price_check(text) to anon,authenticated;

create or replace function public.tix_requested_discovery(p_limit integer default 8)
returns setof public.tix_catalog language sql stable security invoker set search_path = '' as $$
  select c.* from public.tix_catalog c
  join public.tix_discovery_interest i on i.event_id=c.event_id
  where c.event_date between current_date and current_date + 30
    and i.requested_at > coalesce(c.discovery_attempt_at,'epoch'::timestamptz)
  order by i.requested_at desc,c.event_date,c.event_id
  limit least(greatest(p_limit,0),8);
$$;
revoke all on function public.tix_requested_discovery(integer) from public,anon,authenticated;
grant execute on function public.tix_requested_discovery(integer) to service_role;

commit;
