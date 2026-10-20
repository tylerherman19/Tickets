-- Durable delivery intent and per-alert progress. No external email is sent by SQL.
begin;
create table if not exists public.tix_delivery_outbox(
 id uuid primary key default gen_random_uuid(),watch_id uuid not null references public.tix_watches(id) on delete cascade,
 criteria_version integer not null,event_id text not null,club text not null,channel text not null check(channel in('email','sms')),
 kind text not null check(kind in('alert','confirmation')),confirmation_at timestamptz,
 state text not null check(state in('sending','accepted','failed','uncertain','cancelled')),attempts integer not null default 1,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),accepted_at timestamptz,
 lease uuid not null default gen_random_uuid(),lease_until timestamptz not null default now()+interval '2 minutes',
 payload jsonb not null default '{}',last_error text,provider text not null default 'gmail_smtp',provider_id text
);
create index if not exists tix_delivery_dedup on public.tix_delivery_outbox(watch_id,criteria_version,event_id,club,channel,kind,created_at desc);
create index if not exists tix_delivery_state on public.tix_delivery_outbox(state,updated_at);
alter table public.tix_delivery_outbox enable row level security;
revoke all on public.tix_delivery_outbox from public,anon,authenticated;
grant all on public.tix_delivery_outbox to service_role;
alter table public.tix_alerts add column if not exists delivery_id uuid references public.tix_delivery_outbox(id) on delete set null;
create unique index if not exists tix_alert_delivery_once on public.tix_alerts(delivery_id) where delivery_id is not null;

create or replace function public.tix_begin_delivery(p_watch_id uuid,p_version integer,p_event_id text,p_club text,p_channel text,p_kind text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.tix_watches;d public.tix_delivery_outbox;last_accepted timestamptz;requested timestamptz;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_watch_id::text,72634120));
 select * into w from public.tix_watches where id=p_watch_id;
 if w.id is null or not w.active or w.purchased_at is not null or coalesce(w.match->>'archived_at','')<>'' or w.criteria_version<>p_version or not (case p_channel when 'email' then w.email_enabled when 'sms' then w.sms_enabled else false end) then return jsonb_build_object('state','cancelled');end if;
 if p_kind not in('alert','confirmation') or p_event_id is null or p_club is null or p_payload is null then raise exception 'Invalid delivery';end if;
 if p_kind='confirmation' then
  requested:=(p_payload->>'requested_at')::timestamptz;
  if requested is null or not exists(select 1 from public.tix_confirmation_queue q where q.watch_id=w.id and q.requested_at=requested) then return jsonb_build_object('state','cancelled');end if;
 else
  if (p_payload->>'qty')::integer is distinct from w.qty or (p_payload->>'price_cents')::integer is null or (p_payload->>'price_cents')::integer not between 1 and w.threshold_cents or (p_payload->>'checked_at')::timestamptz is null or (p_payload->>'checked_at')::timestamptz<now()-interval '15 minutes' or (p_payload->>'checked_at')::timestamptz>now()+interval '1 minute' then return jsonb_build_object('state','cancelled');end if;
  select max(sent_at) into last_accepted from public.tix_alerts where watch_id=w.id and criteria_version=p_version and event_id=p_event_id and club=p_club and channel=p_channel and status='sent';
  if last_accepted is not null and (w.alert_style='first' or last_accepted>now()-interval '60 minutes') then return jsonb_build_object('state','already_accepted');end if;
 end if;
 select * into d from public.tix_delivery_outbox where watch_id=w.id and criteria_version=p_version and event_id=p_event_id and club=p_club and channel=p_channel and kind=p_kind and confirmation_at is not distinct from requested order by created_at desc limit 1 for update;
 if d.state='accepted' and (p_kind='confirmation' or w.alert_style='first' or d.accepted_at>now()-interval '60 minutes') then return jsonb_build_object('state','already_accepted');end if;
 if d.state='sending' and d.lease_until>now() then return jsonb_build_object('state','busy');end if;
 if d.state='sending' then
  update public.tix_delivery_outbox set state='uncertain',updated_at=now(),last_error='worker_stopped_before_acknowledgment' where id=d.id;
  return jsonb_build_object('state','uncertain');
 end if;
 if d.state='uncertain' then return jsonb_build_object('state','uncertain');end if;
 if d.state='failed' then
  if d.attempts>=5 or d.updated_at>now()-interval '5 minutes' then return jsonb_build_object('state','retry_later');end if;
  update public.tix_delivery_outbox set state='sending',attempts=attempts+1,lease=gen_random_uuid(),lease_until=now()+interval '2 minutes',updated_at=now(),payload=p_payload,last_error=null where id=d.id returning * into d;
 else
  insert into public.tix_delivery_outbox(watch_id,criteria_version,event_id,club,channel,kind,confirmation_at,state,payload) values(w.id,p_version,p_event_id,p_club,p_channel,p_kind,requested,'sending',p_payload) returning * into d;
 end if;
 return jsonb_build_object('state','sending','id',d.id,'lease',d.lease,'message_id','<ticketline.'||d.id::text||'@ticketline.local>');
end $$;
create or replace function public.tix_finish_delivery(p_id uuid,p_lease uuid,p_state text,p_error text default null,p_provider_id text default null)
returns void language plpgsql security definer set search_path='' as $$
declare d public.tix_delivery_outbox;
begin
 if p_state not in('accepted','failed','uncertain') then raise exception 'Invalid delivery state';end if;
 select * into d from public.tix_delivery_outbox where id=p_id and lease=p_lease for update;
 if d.id is null then raise exception 'Delivery lease mismatch';end if;
 if d.state='accepted' then return;end if;
 if d.state not in('sending','uncertain') or d.state='uncertain' and p_state<>'accepted' then raise exception 'Delivery no longer sending';end if;
 update public.tix_delivery_outbox set state=p_state,updated_at=now(),accepted_at=case when p_state='accepted' then now() end,last_error=left(p_error,120),provider_id=left(p_provider_id,200) where id=d.id;
 if p_state='accepted' and d.kind='alert' then
  insert into public.tix_alerts(watch_id,event_id,club,qty,price_cents,listing_id,listing_url,status,criteria_version,channel,deal,delivery_id)
  values(d.watch_id,d.event_id,d.club,(d.payload->>'qty')::integer,(d.payload->>'price_cents')::integer,d.payload->>'listing_id',d.payload->>'listing_url','sent',d.criteria_version,d.channel,d.payload->>'deal',d.id);
 elsif p_state='accepted' and d.kind='confirmation' then
  update public.tix_confirmation_queue set email_sent_at=case when d.channel='email' then now() else email_sent_at end,sent_at=case when d.channel='sms' then now() else sent_at end
  where watch_id=d.watch_id and requested_at=d.confirmation_at;
 end if;
end $$;
revoke all on function public.tix_begin_delivery(uuid,integer,text,text,text,text,jsonb),public.tix_finish_delivery(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.tix_begin_delivery(uuid,integer,text,text,text,text,jsonb),public.tix_finish_delivery(uuid,uuid,text,text,text) to service_role;

alter table public.tix_scans add column if not exists last_success_at timestamptz;
update public.tix_scans set last_success_at=checked_at where last_success_at is null and outcome in('ok','unavailable');
create or replace function public.tix_scan_success() returns trigger language plpgsql set search_path='' as $$
begin
 if new.outcome in('ok','unavailable') then new.last_success_at=new.checked_at;
 elsif TG_OP='UPDATE' and old.criteria_version=new.criteria_version then new.last_success_at=old.last_success_at;
 else new.last_success_at=null;end if;
 return new;
end $$;
create or replace trigger tix_scan_progress before insert or update on public.tix_scans for each row execute function public.tix_scan_success();
create table if not exists public.tix_watch_events(watch_id uuid not null references public.tix_watches(id) on delete cascade,event_id text not null,criteria_version integer not null,seen_at timestamptz not null default now(),primary key(watch_id,event_id));
alter table public.tix_watch_events enable row level security;
revoke all on public.tix_watch_events from public,anon,authenticated;
grant all on public.tix_watch_events to service_role;
create or replace function public.tix_runtime_health() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('schema',20261021,'generated_at',now(),
 'overdue_alert_events',(select count(*) from public.tix_watch_events e join public.tix_watches w on w.id=e.watch_id join public.tix_events_v c using(event_id) left join public.tix_scans s on s.watch_id=w.id and s.event_id=e.event_id and s.criteria_version=w.criteria_version where w.active and w.purchased_at is null and coalesce(w.match->>'archived_at','')='' and e.criteria_version=w.criteria_version and c.event_date between current_date and current_date+365 and (s.last_success_at is null or s.last_success_at<now()-interval '30 minutes')),
 'unresolved_alerts',(select count(*) from public.tix_watches w where w.active and w.purchased_at is null and coalesce(w.match->>'archived_at','')='' and w.criteria_updated_at<now()-interval '30 minutes' and not exists(select 1 from public.tix_watch_events e join public.tix_events_v c using(event_id) where e.watch_id=w.id and e.criteria_version=w.criteria_version and c.event_date>=current_date)),
 'delivery_uncertain',(select count(*) from public.tix_delivery_outbox where state='uncertain' or state='sending' and lease_until<now()),
 'delivery_failed',(select count(*) from public.tix_delivery_outbox where state='failed'),
 'delivery_accepted_24h',(select count(*) from public.tix_delivery_outbox where state='accepted' and accepted_at>now()-interval '1 day'),
 'oldest_quote_wait_seconds',(select extract(epoch from now()-min(requested_at_latest))::integer from public.tix_capture_jobs where detail_requested and requested_at_latest>now()-interval '1 day'),
 'quote_worker',(select v from public.tix_state where k='quote_worker_health'),
 'backup',(select v from public.tix_state where k='backup_health'));
$$;
revoke all on function public.tix_runtime_health() from public,anon,authenticated;
grant execute on function public.tix_runtime_health() to service_role;
create or replace function public.tix_admin_runtime_health() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not public.tix_is_admin() then raise exception 'Administrator access required' using errcode='42501';end if;
 return public.tix_runtime_health();
end $$;
revoke all on function public.tix_admin_runtime_health() from public,anon;
grant execute on function public.tix_admin_runtime_health() to authenticated;
create or replace function public.tix_admin_delivery_rows(p_search text default '',p_offset integer default 0,p_limit integer default 50,p_snapshot timestamptz default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare snap timestamptz:=coalesce(p_snapshot,now());result jsonb;
begin
 if not public.tix_is_admin() then raise exception 'Administrator access required' using errcode='42501';end if;
 select jsonb_build_object('snapshot',snap,'total',(select count(*) from public.tix_delivery_outbox d join public.tix_watches w on w.id=d.watch_id where d.created_at<=snap and (p_search='' or w.label ilike '%'||p_search||'%' or d.state=p_search)),
 'rows',(select coalesce(jsonb_agg(to_jsonb(x)),'[]') from(select d.*,w.label from public.tix_delivery_outbox d join public.tix_watches w on w.id=d.watch_id where d.created_at<=snap and (p_search='' or w.label ilike '%'||p_search||'%' or d.state=p_search) order by d.created_at desc,d.id limit least(greatest(p_limit,1),50) offset least(greatest(p_offset,0),100000)) x)) into result;
 insert into public.tix_admin_audit(actor,action,dataset) values(auth.uid(),'read','delivery_outbox');
 return result;
end $$;
revoke all on function public.tix_admin_delivery_rows(text,integer,integer,timestamptz) from public,anon;
grant execute on function public.tix_admin_delivery_rows(text,integer,integer,timestamptz) to authenticated;

-- One database snapshot of the state that cannot be rebuilt from ticket pages.
-- No sessions, passwords, unrelated app records, or authentication secrets.
create or replace function public.tix_backup_snapshot() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb:='{}';name text;rows jsonb;
begin
 foreach name in array array['tix_watches','tix_destinations','tix_confirmation_queue','tix_admins','tix_prices','tix_alerts','tix_scans','tix_watch_events','tix_delivery_outbox','tix_watch_audit','tix_admin_audit','tix_searches','tix_schema_versions'] loop
  execute format('select coalesce(jsonb_agg(to_jsonb(t)),''[]''::jsonb) from public.%I t',name) into rows;
  result:=result||jsonb_build_object(name,rows);
 end loop;
 return jsonb_build_object('format',1,'schema',20261021,'created_at',now(),'scope','ticketline_private_state','tables',result,
 'owner_references',(select coalesce(jsonb_agg(jsonb_build_object('id',u.id,'email',u.email,'email_confirmed_at',u.email_confirmed_at)),'[]') from auth.users u where exists(select 1 from public.tix_watches w where w.owner_id=u.id) or exists(select 1 from public.tix_admins a where a.owner_id=u.id)));
end $$;
revoke all on function public.tix_backup_snapshot() from public,anon,authenticated;
grant execute on function public.tix_backup_snapshot() to service_role;

insert into public.tix_schema_versions(version) values(20261021) on conflict do nothing;
commit;
notify pgrst,'reload schema';
