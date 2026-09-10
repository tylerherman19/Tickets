-- Per-alert delivery destinations and one-time save confirmations.
-- Full phone numbers are unavailable to the public API.
begin;

create table if not exists public.tix_destinations (
  watch_id uuid primary key references public.tix_watches(id) on delete cascade,
  phone_digits text not null check (phone_digits ~ '^[2-9][0-9]{2}[2-9][0-9]{6}$'),
  provider text not null,
  updated_at timestamptz not null default now()
);

alter table public.tix_destinations drop constraint if exists tix_destinations_provider_check;
alter table public.tix_destinations add constraint tix_destinations_provider_check
  check (provider in ('tmobile','verizon','xfinity','uscellular'));

create table if not exists public.tix_confirmation_queue (
  watch_id uuid primary key references public.tix_watches(id) on delete cascade,
  event_label text not null,
  requested_at timestamptz not null default now(),
  attempts int not null default 0,
  sent_at timestamptz,
  last_error text
);

alter table public.tix_destinations enable row level security;
alter table public.tix_confirmation_queue enable row level security;
revoke all on public.tix_destinations from anon, authenticated;
revoke all on public.tix_confirmation_queue from anon, authenticated;

create or replace function public.tix_save_destination(
  p_watch_id uuid,
  p_phone text,
  p_provider text,
  p_confirmation_label text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  digits text;
  clean_label text;
begin
  if not exists (select 1 from public.tix_watches where id = p_watch_id) then
    raise exception 'This alert no longer exists.';
  end if;
  if p_provider not in ('tmobile','verizon','xfinity','uscellular') then
    raise exception 'Choose a supported cell provider.';
  end if;

  digits := regexp_replace(coalesce(p_phone,''), '[^0-9]', '', 'g');
  if length(digits) = 11 and left(digits,1) = '1' then
    digits := right(digits,10);
  end if;
  if digits !~ '^[2-9][0-9]{2}[2-9][0-9]{6}$' then
    raise exception 'Enter a valid 10-digit U.S. cell number.';
  end if;

  clean_label := left(trim(coalesce(p_confirmation_label,'')), 180);
  if clean_label = '' then
    select left(label,180) into clean_label from public.tix_watches where id = p_watch_id;
  end if;

  insert into public.tix_destinations (watch_id, phone_digits, provider, updated_at)
  values (p_watch_id, digits, p_provider, now())
  on conflict (watch_id) do update set
    phone_digits = excluded.phone_digits,
    provider = excluded.provider,
    updated_at = excluded.updated_at;

  insert into public.tix_confirmation_queue (watch_id, event_label, requested_at, attempts, sent_at, last_error)
  values (p_watch_id, clean_label, now(), 0, null, null)
  on conflict (watch_id) do update set
    event_label = excluded.event_label,
    requested_at = excluded.requested_at,
    attempts = 0,
    sent_at = null,
    last_error = null;

  return jsonb_build_object('configured', true, 'provider', p_provider);
end;
$$;

create or replace function public.tix_destination_meta(p_watch_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'configured', exists(select 1 from public.tix_destinations where watch_id = p_watch_id),
    'provider', (select provider from public.tix_destinations where watch_id = p_watch_id)
  );
$$;

revoke all on function public.tix_save_destination(uuid,text,text,text) from public;
revoke all on function public.tix_destination_meta(uuid) from public;
grant execute on function public.tix_save_destination(uuid,text,text,text) to anon;
grant execute on function public.tix_destination_meta(uuid) to anon;

commit;
