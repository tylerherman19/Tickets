-- Email to the verified sign-in address is the default. Carrier email-to-text is optional.
-- Existing watches with a saved phone retain SMS. No watch, destination, or history is deleted.
begin;

alter table public.tix_watches add column if not exists email_enabled boolean not null default true;
do $$ begin
  if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='tix_watches' and column_name='sms_enabled') then
    alter table public.tix_watches add column sms_enabled boolean not null default false;
    update public.tix_watches w set sms_enabled=true
    where exists (select 1 from public.tix_destinations d where d.watch_id=w.id);
  end if;
end $$;

alter table public.tix_alerts add column if not exists channel text not null default 'sms';
alter table public.tix_alerts drop constraint if exists tix_alerts_channel_check;
alter table public.tix_alerts add constraint tix_alerts_channel_check check (channel in ('email','sms'));
create index if not exists tix_alerts_channel_dedup
  on public.tix_alerts(watch_id,criteria_version,event_id,club,channel,sent_at desc);

alter table public.tix_confirmation_queue add column if not exists email_enabled boolean not null default true;
alter table public.tix_confirmation_queue add column if not exists sms_enabled boolean not null default false;
alter table public.tix_confirmation_queue add column if not exists email_sent_at timestamptz;
do $$ begin
  if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='tix_confirmation_queue' and column_name='email_attempts') then
    alter table public.tix_confirmation_queue add column email_attempts integer not null default 0;
    update public.tix_confirmation_queue q set
      email_enabled=w.email_enabled, sms_enabled=w.sms_enabled,
      email_sent_at=case when q.requested_at < now()-interval '1 day' then q.sent_at else null end
    from public.tix_watches w where q.watch_id=w.id;
  end if;
end $$;
alter table public.tix_confirmation_queue add column if not exists email_last_error text;

-- The collector alone can resolve an owner's verified inbox. Browser roles cannot execute this RPC.
create or replace function public.tix_owner_email(p_watch_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select u.email from public.tix_watches w join auth.users u on u.id=w.owner_id
  where w.id=p_watch_id and u.email_confirmed_at is not null and w.email_enabled;
$$;
revoke all on function public.tix_owner_email(uuid) from public, anon, authenticated;
grant execute on function public.tix_owner_email(uuid) to service_role;

create or replace function public.tix_save_alert(p_watch jsonb, p_watch_id uuid default null,
  p_phone text default null, p_provider text default null, p_confirmation_label text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  saved public.tix_watches%rowtype;
  digits text;
  uid uuid := auth.uid();
  want_email boolean := coalesce((p_watch->>'email_enabled')::boolean,true);
  want_sms boolean := coalesce((p_watch->>'sms_enabled')::boolean,
    nullif(trim(coalesce(p_phone,'')),'') is not null or
    coalesce((select sms_enabled from public.tix_watches where id=p_watch_id),false));
begin
  if uid is null then raise exception 'Sign in to save alerts' using errcode='42501'; end if;
  if not want_email and not want_sms then raise exception 'Choose email or text delivery'; end if;
  if (p_watch->>'kind') not in ('event','team','date')
     or (p_watch->>'qty')::integer not between 1 and 8
     or (p_watch->>'threshold_cents')::integer not between 100 and 5000000
     or (p_watch->>'alert_style') not in ('first','repeat')
     or length(trim(coalesce(p_watch->>'label',''))) not between 1 and 140
     or jsonb_typeof(p_watch->'match') is distinct from 'object' then
    raise exception 'Invalid alert criteria';
  end if;
  if p_watch_id is null then
    insert into public.tix_watches(owner_id,label,kind,match,clubs,qty,threshold_cents,alert_style,active,email_enabled,sms_enabled)
    values(uid,trim(p_watch->>'label'),p_watch->>'kind',p_watch->'match',
      coalesce(array(select jsonb_array_elements_text(p_watch->'clubs')),'{}'::text[]),
      (p_watch->>'qty')::integer,(p_watch->>'threshold_cents')::integer,p_watch->>'alert_style',
      coalesce((p_watch->>'active')::boolean,true),want_email,want_sms) returning * into saved;
  else
    update public.tix_watches set label=trim(p_watch->>'label'),kind=p_watch->>'kind',
      match=p_watch->'match',clubs=coalesce(array(select jsonb_array_elements_text(p_watch->'clubs')),'{}'::text[]),
      qty=(p_watch->>'qty')::integer,threshold_cents=(p_watch->>'threshold_cents')::integer,
      alert_style=p_watch->>'alert_style',active=coalesce((p_watch->>'active')::boolean,true),
      email_enabled=want_email,sms_enabled=want_sms
    where id=p_watch_id and owner_id=uid returning * into saved;
    if saved.id is null then raise exception 'Alert not found or not owned by you' using errcode='42501'; end if;
  end if;
  if nullif(trim(coalesce(p_phone,'')),'') is not null then
    if p_provider not in ('tmobile','verizon','xfinity','uscellular') then raise exception 'Choose a supported cell provider'; end if;
    digits := regexp_replace(p_phone,'[^0-9]','','g');
    if length(digits)=11 and left(digits,1)='1' then digits:=right(digits,10); end if;
    if digits !~ '^[2-9][0-9]{2}[2-9][0-9]{6}$' then raise exception 'Enter a valid 10-digit U.S. cell number'; end if;
    insert into public.tix_destinations(watch_id,phone_digits,provider,updated_at)
    values(saved.id,digits,p_provider,now()) on conflict(watch_id) do update
      set phone_digits=excluded.phone_digits,provider=excluded.provider,updated_at=excluded.updated_at;
  end if;
  if want_sms and not exists(select 1 from public.tix_destinations where watch_id=saved.id) then
    raise exception 'Add a cell number for text delivery';
  end if;
  insert into public.tix_confirmation_queue
    (watch_id,event_label,requested_at,attempts,sent_at,last_error,email_enabled,sms_enabled,email_attempts,email_sent_at,email_last_error)
  values(saved.id,left(coalesce(nullif(trim(p_confirmation_label),''),saved.label),180),now(),0,null,null,want_email,want_sms,0,null,null)
  on conflict(watch_id) do update set event_label=excluded.event_label,requested_at=excluded.requested_at,
    attempts=0,sent_at=null,last_error=null,email_enabled=excluded.email_enabled,sms_enabled=excluded.sms_enabled,
    email_attempts=0,email_sent_at=null,email_last_error=null;
  return jsonb_build_object('id',saved.id,'criteria_version',saved.criteria_version);
end;
$$;
revoke all on function public.tix_save_alert(jsonb,uuid,text,text,text) from public, anon;
grant execute on function public.tix_save_alert(jsonb,uuid,text,text,text) to authenticated;

commit;
