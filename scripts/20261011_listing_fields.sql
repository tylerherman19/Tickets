-- Apply after 20261007_hardening.sql, BEFORE merging/deploying Phase 2.
-- Nullable additions: legacy prices remain unknown; no guessed backfill.
-- RLS/policies and existing rows retained. No live execution in this PR.
begin;
alter table public.tix_prices add column if not exists prefee_cents integer;
alter table public.tix_prices add column if not exists sales_tax_cents integer;
alter table public.tix_prices add column if not exists pre_tax_total_cents integer;
alter table public.tix_prices add column if not exists deal text;
alter table public.tix_prices add column if not exists hist jsonb;
alter table public.tix_prices add column if not exists lots integer[];
alter table public.tix_prices add column if not exists basis text;
-- Retain the provider tier as supplied at delivery time; no ranking is inferred.
alter table public.tix_alerts add column if not exists deal text;
-- Public aggregate evidence only. Opaque provider history stays on owner-only prices.
alter table public.tix_event_market add column if not exists coverage jsonb;

create or replace view public.tix_alert_intelligence_v with (security_invoker=true) as
select w.id as watch_id,w.criteria_version,
  s.checked_at as last_checked_at,s.outcome as scan_outcome,s.detail as scan_detail,
  p.price_cents as current_price_cents,p.listing_url,p.event_label,p.club,
  p.checked_at as price_checked_at,
  (select min(x.price_cents) from public.tix_prices x where x.watch_id=w.id and x.criteria_version=w.criteria_version and x.basis=p.basis and x.event_id=p.event_id and x.club=p.club and x.qty=p.qty) as all_time_low_cents,
  (select min(x.price_cents) from public.tix_prices x where x.watch_id=w.id and x.criteria_version=w.criteria_version and x.basis=p.basis and x.event_id=p.event_id and x.club=p.club and x.qty=p.qty and x.checked_at>=now()-interval '7 days') as low_7d_cents,
  (select max(x.price_cents) from public.tix_prices x where x.watch_id=w.id and x.criteria_version=w.criteria_version and x.basis=p.basis and x.event_id=p.event_id and x.club=p.club and x.qty=p.qty and x.checked_at>=now()-interval '7 days') as high_7d_cents,
  (select x.price_cents from public.tix_prices x where x.watch_id=w.id and x.criteria_version=w.criteria_version and x.basis=p.basis and x.event_id=p.event_id and x.club=p.club and x.qty=p.qty and x.checked_at<=now()-interval '24 hours' order by x.checked_at desc limit 1) as price_24h_ago_cents
  ,p.prefee_cents,p.sales_tax_cents,p.pre_tax_total_cents,p.deal,p.hist,p.lots,p.basis,p.event_id as current_event_id
from public.tix_watches w
left join lateral (select * from public.tix_scans s where s.watch_id=w.id and s.criteria_version=w.criteria_version order by s.checked_at desc limit 1) s on true
left join lateral (select * from public.tix_prices p where p.watch_id=w.id and p.criteria_version=w.criteria_version and p.event_id=s.event_id and p.qty=w.qty and p.checked_at>=w.criteria_updated_at and p.basis in ('fees_included_tax_reported','fees_included_tax_unknown') and p.checked_at>=coalesce(s.checked_at,now()-interval '2 hours')-interval '1 second' order by p.price_cents,p.checked_at desc limit 1) p on s.outcome='ok';
grant select on public.tix_alert_intelligence_v to authenticated;

-- Return basis and nullable fields to historical readers. Replacement is atomic.
drop function if exists public.tix_alert_history(uuid,text,integer);
create or replace function public.tix_alert_history(p_watch_id uuid,p_range text default '7d',p_version integer default null)
returns table(checked_at timestamptz,price_cents integer,criteria_version integer,
  event_id text,club text,qty integer,basis text,prefee_cents integer,
  sales_tax_cents integer,pre_tax_total_cents integer,deal text,hist jsonb,lots integer[])
language plpgsql stable security invoker set search_path='' as $$
declare
  since_at timestamptz;
  bucket_seconds integer;
  version_number integer;
begin
  select w.criteria_version into version_number from public.tix_watches w
    where w.id=p_watch_id and w.owner_id=auth.uid();
  if version_number is null then raise exception 'Alert not found or not owned by you' using errcode='42501'; end if;
  version_number := coalesce(p_version,version_number);
  if p_range='24h' then since_at:=now()-interval '24 hours'; bucket_seconds:=900;
  elsif p_range='7d' then since_at:=now()-interval '7 days'; bucket_seconds:=3600;
  elsif p_range='30d' then since_at:=now()-interval '30 days'; bucket_seconds:=14400;
  elsif p_range='all' then
    since_at:='epoch'::timestamptz;
    select greatest(86400,ceil(extract(epoch from now()-min(p.checked_at))/240)::integer)
      into bucket_seconds from public.tix_prices p
      where p.watch_id=p_watch_id and p.criteria_version=version_number;
    bucket_seconds:=coalesce(bucket_seconds,86400);
  else raise exception 'Unsupported chart range'; end if;
  return query select distinct on (floor(extract(epoch from p.checked_at)/bucket_seconds))
    p.checked_at,p.price_cents,p.criteria_version,p.event_id,p.club,p.qty,p.basis,
    p.prefee_cents,p.sales_tax_cents,p.pre_tax_total_cents,p.deal,p.hist,p.lots from public.tix_prices p
    where p.watch_id=p_watch_id and p.criteria_version=version_number and p.checked_at>=since_at
    order by floor(extract(epoch from p.checked_at)/bucket_seconds),p.checked_at desc;
end;
$$;
revoke all on function public.tix_alert_history(uuid,text,integer) from public,anon;
grant execute on function public.tix_alert_history(uuid,text,integer) to authenticated;

commit;
