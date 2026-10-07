-- Hardening pass. Apply after 20260928_signed_in_catalog.sql. Additive and idempotent:
-- no watch, price, alert or destination rows are deleted or rewritten.
begin;

-- 1. Browser writes to tix_watches. All criteria changes go through tix_save_alert,
--    which validates them; direct PATCHes may only pause/resume, archive/restore
--    (match.archived_at) or record a purchase. Owner, version, thresholds, quantity
--    and delivery flags can no longer be changed by a crafted request.
revoke update on public.tix_watches from authenticated;
grant update (active, purchased_at, purchase_price_cents, match) on public.tix_watches to authenticated;

-- 2. Server-side validation that also covers service-role and legacy writes.
--    NOT VALID keeps any historical row from blocking the migration while
--    enforcing the rules on every new insert/update.
alter table public.tix_watches drop constraint if exists tix_watches_qty_check;
alter table public.tix_watches add constraint tix_watches_qty_check check (qty between 1 and 8) not valid;
alter table public.tix_watches drop constraint if exists tix_watches_threshold_check;
alter table public.tix_watches add constraint tix_watches_threshold_check
  check (threshold_cents between 100 and 5000000) not valid;
alter table public.tix_watches drop constraint if exists tix_watches_purchase_price_check;
alter table public.tix_watches add constraint tix_watches_purchase_price_check
  check (purchase_price_cents is null or purchase_price_cents between 0 and 100000000) not valid;
alter table public.tix_watches drop constraint if exists tix_watches_label_check;
alter table public.tix_watches add constraint tix_watches_label_check
  check (length(btrim(label)) between 1 and 140) not valid;
alter table public.tix_watches drop constraint if exists tix_watches_kind_check;
alter table public.tix_watches add constraint tix_watches_kind_check check (kind in ('event','team','date')) not valid;
alter table public.tix_watches drop constraint if exists tix_watches_style_check;
alter table public.tix_watches add constraint tix_watches_style_check check (alert_style in ('first','repeat')) not valid;
alter table public.tix_watches drop constraint if exists tix_watches_match_check;
alter table public.tix_watches add constraint tix_watches_match_check check (
  jsonb_typeof(match) = 'object'
  and (match->'event_ids' is null or (jsonb_typeof(match->'event_ids') = 'array'
       and jsonb_array_length(match->'event_ids') <= 10))
  and pg_column_size(match) < 4096) not valid;

-- 3. Row timestamps.
alter table public.tix_watches add column if not exists updated_at timestamptz not null default now();
create or replace function public.tix_touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end;
$$;
drop trigger if exists tix_watches_touch on public.tix_watches;
create trigger tix_watches_touch before update on public.tix_watches
  for each row execute function public.tix_touch_updated_at();

-- 4. Audit log of every watch change: who (auth uid or service role), what, when.
--    Not readable from the browser; contains no phone numbers or email addresses.
create table if not exists public.tix_watch_audit (
  id bigint generated always as identity primary key,
  watch_id uuid not null,
  actor uuid,
  actor_role text,
  action text not null check (action in ('insert','update','delete')),
  changed jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index if not exists tix_watch_audit_watch on public.tix_watch_audit(watch_id, at desc);
alter table public.tix_watch_audit enable row level security;
revoke all on public.tix_watch_audit from public, anon, authenticated;

create or replace function public.tix_audit_watch() returns trigger
language plpgsql security definer set search_path = '' as $$
declare diff jsonb := '{}'::jsonb; k text;
begin
  if tg_op = 'UPDATE' then
    for k in select jsonb_object_keys(to_jsonb(new)) loop
      if k not in ('updated_at') and to_jsonb(new)->k is distinct from to_jsonb(old)->k then
        diff := diff || jsonb_build_object(k, jsonb_build_array(to_jsonb(old)->k, to_jsonb(new)->k));
      end if;
    end loop;
    if diff = '{}'::jsonb then return new; end if;
  end if;
  insert into public.tix_watch_audit(watch_id, actor, actor_role, action, changed)
  values (coalesce(new.id, old.id), auth.uid(), current_setting('request.jwt.claim.role', true),
          lower(tg_op), case when tg_op = 'UPDATE' then diff else '{}'::jsonb end);
  return coalesce(new, old);
end;
$$;
drop trigger if exists tix_watches_audit on public.tix_watches;
create trigger tix_watches_audit after insert or update or delete on public.tix_watches
  for each row execute function public.tix_audit_watch();

-- 5. Deleting an auth user removes their watches, and through existing cascades
--    their prices, alerts, scans, phone destinations and confirmation queue.
alter table public.tix_watches drop constraint if exists tix_watches_owner_id_fkey;
alter table public.tix_watches add constraint tix_watches_owner_id_fkey
  foreign key (owner_id) references auth.users(id) on delete cascade;

-- 6. Expiring a catalog event removes its change history too (the collector
--    still deletes it first, so either order works).
alter table public.tix_event_changes drop constraint if exists tix_event_changes_event_id_fkey;
alter table public.tix_event_changes add constraint tix_event_changes_event_id_fkey
  foreign key (event_id) references public.tix_catalog(event_id) on delete cascade;

-- 7. Indexes for the public search paths (category + date listing, cheapest-first,
--    case-insensitive name search).
create extension if not exists pg_trgm with schema extensions;
create index if not exists tix_catalog_category_date on public.tix_catalog(category, event_date, event_id);
create index if not exists tix_catalog_cheap on public.tix_catalog(event_date, min_total) where min_total is not null;
create index if not exists tix_catalog_name_trgm on public.tix_catalog using gin (name extensions.gin_trgm_ops);
create index if not exists tix_alerts_watch_sent on public.tix_alerts(watch_id, sent_at desc, id desc);

-- 8. Self-service account deletion (there is no support inbox). Removes the
--    caller's watches (cascading to prices, alerts, scans, destinations and the
--    confirmation queue) and then the auth user itself. Audit rows keep only the
--    watch id and action, with no personal data.
create or replace function public.tix_delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Sign in to delete your account' using errcode = '42501'; end if;
  delete from public.tix_watches where owner_id = uid;
  delete from auth.users where id = uid;
end;
$$;
revoke all on function public.tix_delete_my_account() from public, anon;
grant execute on function public.tix_delete_my_account() to authenticated;

commit;
