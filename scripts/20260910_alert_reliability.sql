-- Additive migration. No watch, price, alert, or unrelated project data is removed.
begin;
alter table public.tix_watches add column if not exists criteria_updated_at timestamptz not null default now();
create or replace function public.tix_mark_criteria_changed() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.kind is distinct from old.kind or new.match is distinct from old.match or new.clubs is distinct from old.clubs or new.qty is distinct from old.qty then
    new.criteria_updated_at = now();
  end if;
  return new;
end;
$$;
create or replace trigger tix_criteria_changed before update on public.tix_watches for each row execute function public.tix_mark_criteria_changed();
create table if not exists public.tix_scans (
  watch_id uuid not null references public.tix_watches(id) on delete cascade,
  event_id text not null,
  checked_at timestamptz not null default now(),
  outcome text not null check (outcome in ('ok','unavailable','failed')),
  primary key (watch_id,event_id)
);
alter table public.tix_scans enable row level security;
grant select on public.tix_scans to anon;
do $$ begin
 if not exists(select 1 from pg_policies where schemaname='public' and tablename='tix_scans' and policyname='public read ticket scan status') then
   create policy "public read ticket scan status" on public.tix_scans for select to anon using (true);
 end if;
 if not exists(select 1 from pg_policies where schemaname='public' and tablename='tix_state' and policyname='public read ticket health') then
   create policy "public read ticket health" on public.tix_state for select to anon using (k in ('collector_health','notification_health'));
 end if;
end $$;
commit;
-- Self-versus-self catalog slugs are season-pass products, not single games.
create or replace view public.tix_events_v with (security_invoker = true) as
select * from public.tix_catalog where coalesce(slug,'') !~ '^(.*)-vs-\1$'
and coalesce(name,'') !~* '(season tickets|season pass|parking only)';
grant select on public.tix_events_v to anon;
