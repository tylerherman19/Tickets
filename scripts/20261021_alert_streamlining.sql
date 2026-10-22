-- Compact alerts, event-wide notification preferences and owner-only controls.
begin;
create or replace function public.tix_begin_delivery(p_watch_id uuid,p_version integer,p_event_id text,p_club text,p_channel text,p_kind text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.tix_watches;d public.tix_delivery_outbox;last_accepted timestamptz;requested timestamptz; mode text; lowest integer;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_watch_id::text,72634120));
 select * into w from public.tix_watches where id=p_watch_id;
 if w.id is null or not w.active or w.purchased_at is not null or coalesce(w.match->>'archived_at','')<>'' or w.criteria_version<>p_version or not (case p_channel when 'email' then w.email_enabled when 'sms' then w.sms_enabled else false end) then return jsonb_build_object('state','cancelled');end if;
 if p_kind not in('alert','confirmation') or p_event_id is null or p_club is null or p_payload is null then raise exception 'Invalid delivery';end if;
 mode:=coalesce(w.match->>'notification_mode','legacy');
 if p_kind='confirmation' then
  requested:=(p_payload->>'requested_at')::timestamptz;
  if requested is null or not exists(select 1 from public.tix_confirmation_queue q where q.watch_id=w.id and q.requested_at=requested) then return jsonb_build_object('state','cancelled');end if;
 else
  if (p_payload->>'qty')::integer is distinct from w.qty or (p_payload->>'price_cents')::integer is null or (p_payload->>'price_cents')::integer not between 1 and w.threshold_cents or (p_payload->>'checked_at')::timestamptz is null or (p_payload->>'checked_at')::timestamptz<now()-interval '15 minutes' or (p_payload->>'checked_at')::timestamptz>now()+interval '1 minute' then return jsonb_build_object('state','cancelled');end if;
  select max(sent_at) into last_accepted from public.tix_alerts where watch_id=w.id and criteria_version=p_version and event_id=p_event_id and (mode<>'legacy' or club=p_club) and channel=p_channel and status='sent';
  if last_accepted is not null and (mode='first_event' or w.alert_style='first' or last_accepted>now()-interval '60 minutes') then return jsonb_build_object('state','already_accepted');end if;
  if mode='drop' then
   select min(price_cents) into lowest from public.tix_alerts where watch_id=w.id and criteria_version=p_version and event_id=p_event_id and channel=p_channel and status='sent';
   if lowest is not null and (p_payload->>'price_cents')::integer>lowest-greatest(500,ceil(lowest*0.05)::integer) then return jsonb_build_object('state','already_accepted');end if;
  end if;
  if coalesce(w.match->'excluded_event_ids','[]'::jsonb) ? p_event_id then return jsonb_build_object('state','cancelled');end if;
 end if;
 select * into d from public.tix_delivery_outbox where watch_id=w.id and criteria_version=p_version and event_id=p_event_id and (p_kind='confirmation' or mode='legacy' and club=p_club or mode<>'legacy') and channel=p_channel and kind=p_kind and confirmation_at is not distinct from requested order by created_at desc limit 1 for update;
 if d.state='accepted' and (p_kind='confirmation' or mode='first_event' or w.alert_style='first' or d.accepted_at>now()-interval '60 minutes') then return jsonb_build_object('state','already_accepted');end if;
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
create or replace view public.tix_alert_intelligence_v with (security_invoker=true) as
select w.id as watch_id,w.criteria_version,
  s.checked_at as last_checked_at,s.outcome as scan_outcome,s.detail as scan_detail,
  p.price_cents as current_price_cents,p.listing_url,p.event_label,p.club,
  p.checked_at as price_checked_at,
  (select min(x.price_cents) from public.tix_prices x where x.watch_id=w.id and x.criteria_version=w.criteria_version and x.basis=p.basis and x.event_id=p.event_id and x.club=p.club and x.qty=p.qty) as all_time_low_cents,
  (select min(x.price_cents) from public.tix_prices x where x.watch_id=w.id and x.criteria_version=w.criteria_version and x.basis=p.basis and x.event_id=p.event_id and x.club=p.club and x.qty=p.qty and x.checked_at>=now()-interval '7 days') as low_7d_cents,
  (select max(x.price_cents) from public.tix_prices x where x.watch_id=w.id and x.criteria_version=w.criteria_version and x.basis=p.basis and x.event_id=p.event_id and x.club=p.club and x.qty=p.qty and x.checked_at>=now()-interval '7 days') as high_7d_cents,
  (select x.price_cents from public.tix_prices x where x.watch_id=w.id and x.criteria_version=w.criteria_version and x.basis=p.basis and x.event_id=p.event_id and x.club=p.club and x.qty=p.qty and x.checked_at<=now()-interval '24 hours' order by x.checked_at desc limit 1) as price_24h_ago_cents
  ,p.prefee_cents,p.sales_tax_cents,p.pre_tax_total_cents,p.deal,p.hist,p.lots,p.basis,p.event_id as current_event_id,
  (select max(x.last_success_at) from public.tix_scans x where x.watch_id=w.id and x.criteria_version=w.criteria_version) as last_success_at
from public.tix_watches w
left join lateral (select * from public.tix_scans s where s.watch_id=w.id and s.criteria_version=w.criteria_version order by s.checked_at desc limit 1) s on true
left join lateral (select * from public.tix_prices p where p.watch_id=w.id and p.criteria_version=w.criteria_version and p.event_id=s.event_id and p.qty=w.qty and p.checked_at>=w.criteria_updated_at and p.basis in ('fees_included_tax_reported','fees_included_tax_unknown') and p.checked_at>=coalesce(s.checked_at,now()-interval '2 hours')-interval '1 second' order by p.price_cents,p.checked_at desc limit 1) p on s.outcome='ok';
grant select on public.tix_alert_intelligence_v to authenticated;

create or replace function public.tix_runtime_health() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('schema',(select max(version) from public.tix_schema_versions),'generated_at',now(),
 'overdue_alert_events',(select count(*) from public.tix_watch_events e join public.tix_watches w on w.id=e.watch_id join public.tix_events_v c using(event_id) left join public.tix_scans s on s.watch_id=w.id and s.event_id=e.event_id and s.criteria_version=w.criteria_version where w.active and w.purchased_at is null and coalesce(w.match->>'archived_at','')='' and not (coalesce(w.match->'excluded_event_ids','[]'::jsonb) ? e.event_id) and e.criteria_version=w.criteria_version and c.event_date between current_date and current_date+365 and (s.last_success_at is null or s.last_success_at<now()-interval '30 minutes')),
 'unresolved_alerts',(select count(*) from public.tix_watches w where w.active and w.purchased_at is null and coalesce(w.match->>'archived_at','')='' and w.criteria_updated_at<now()-interval '30 minutes' and not exists(select 1 from public.tix_watch_events e join public.tix_events_v c using(event_id) where e.watch_id=w.id and not (coalesce(w.match->'excluded_event_ids','[]'::jsonb) ? e.event_id) and e.criteria_version=w.criteria_version and c.event_date>=current_date)),
 'delivery_uncertain',(select count(*) from public.tix_delivery_outbox where state='uncertain' or state='sending' and lease_until<now()),
 'delivery_failed',(select count(*) from public.tix_delivery_outbox where state='failed'),
 'delivery_accepted_24h',(select count(*) from public.tix_delivery_outbox where state='accepted' and accepted_at>now()-interval '1 day'),
 'oldest_quote_wait_seconds',(select extract(epoch from now()-min(requested_at_latest))::integer from public.tix_capture_jobs where detail_requested and requested_at_latest>now()-interval '1 day'),
 'quote_worker',(select v from public.tix_state where k='quote_worker_health'),
 'backup',(select v from public.tix_state where k='backup_health'));
$$;
revoke all on function public.tix_runtime_health() from public,anon,authenticated;
grant execute on function public.tix_runtime_health() to service_role;


-- Owner-only narrow edits; callers cannot overwrite other alert fields or another edit.
create or replace function public.tix_update_watch_controls(p_watch_id uuid,p_threshold_cents integer default null,p_excluded_event_ids jsonb default null,p_expected_version integer default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.tix_watches;
begin
 select * into w from public.tix_watches where id=p_watch_id and owner_id=auth.uid() for update;
 if w.id is null then raise exception 'Alert not found' using errcode='42501';end if;
 if p_expected_version is null or p_expected_version<>w.criteria_version then raise exception 'This alert changed. Refresh before editing.';end if;
 if p_threshold_cents is not null and p_threshold_cents not between 100 and 5000000 then raise exception 'Enter a target from $1 to $50,000';end if;
 if p_excluded_event_ids is not null then
  if w.kind<>'team' or jsonb_typeof(p_excluded_event_ids)<>'array' then raise exception 'Exclusions require a team alert';end if;
  if jsonb_array_length(p_excluded_event_ids)>100 or exists(select 1 from jsonb_array_elements(p_excluded_event_ids) v where jsonb_typeof(v)<>'string' or length(v#>>'{}') not between 1 and 40) then raise exception 'Invalid excluded games';end if;
 end if;
 update public.tix_watches set threshold_cents=coalesce(p_threshold_cents,threshold_cents),match=case when p_excluded_event_ids is null then match else jsonb_set(match,'{excluded_event_ids}',p_excluded_event_ids) end where id=w.id returning * into w;
 return to_jsonb(w);
end $$;
revoke all on function public.tix_update_watch_controls(uuid,integer,jsonb,integer) from public,anon;
grant execute on function public.tix_update_watch_controls(uuid,integer,jsonb,integer) to authenticated;

-- Tests reuse the private, idempotent confirmation outbox. No address is accepted from a client.
create or replace function public.tix_request_delivery_test(p_watch_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare w public.tix_watches;
begin
 select * into w from public.tix_watches where id=p_watch_id and owner_id=auth.uid() for update;
 if w.id is null or not w.active or w.purchased_at is not null or coalesce(w.match->>'archived_at','')<>'' then raise exception 'Choose an active alert you own' using errcode='42501';end if;
 if exists(select 1 from public.tix_confirmation_queue where watch_id=w.id and requested_at>now()-interval '10 minutes') then raise exception 'A confirmation or test was recently queued. Wait 10 minutes before testing again.';end if;
 insert into public.tix_confirmation_queue(watch_id,event_label,requested_at,attempts,sent_at,last_error,email_enabled,sms_enabled,email_attempts,email_sent_at,email_last_error)
 values(w.id,'__ticketline_delivery_test__',now(),0,null,null,w.email_enabled,w.sms_enabled,0,null,null)
 on conflict(watch_id) do update set event_label=excluded.event_label,requested_at=excluded.requested_at,attempts=0,sent_at=null,last_error=null,email_enabled=excluded.email_enabled,sms_enabled=excluded.sms_enabled,email_attempts=0,email_sent_at=null,email_last_error=null;
 return jsonb_build_object('state','queued');
end $$;
revoke all on function public.tix_request_delivery_test(uuid) from public,anon;
grant execute on function public.tix_request_delivery_test(uuid) to authenticated;

insert into public.tix_schema_versions(version) values(20261026) on conflict do nothing;
commit;
notify pgrst,'reload schema';
