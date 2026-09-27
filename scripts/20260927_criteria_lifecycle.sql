-- Archiving is a status change, not a new buying configuration.
begin;
alter table public.tix_catalog add column if not exists price_checked_at timestamptz;
create or replace view public.tix_events_v with (security_invoker=true) as
select * from public.tix_catalog where coalesce(slug,'') !~ '^(.*)-vs-\1$'
and coalesce(name,'') !~* '(season tickets|season pass|parking only)';
create or replace function public.tix_mark_criteria_changed() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.kind is distinct from old.kind
     or (new.match - 'archived_at') is distinct from (old.match - 'archived_at')
     or new.clubs is distinct from old.clubs or new.qty is distinct from old.qty
     or new.threshold_cents is distinct from old.threshold_cents
     or new.alert_style is distinct from old.alert_style then
    new.criteria_version := old.criteria_version + 1;
    new.criteria_updated_at := now();
  else
    new.criteria_version := old.criteria_version;
    new.criteria_updated_at := old.criteria_updated_at;
  end if;
  return new;
end;
$$;
commit;
