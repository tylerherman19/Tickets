-- Ticketline administrators. Apply after 20261017_coverage_query.sql.
-- Membership is provisioned separately by the project owner, never by a browser RPC.
begin;
create table if not exists public.tix_admins (
 owner_id uuid primary key references auth.users(id) on delete cascade,
 created_at timestamptz not null default now()
);
alter table public.tix_admins enable row level security;
revoke all on public.tix_admins from public,anon,authenticated;
grant all on public.tix_admins to service_role;
create table if not exists public.tix_admin_audit (
 id bigint generated always as identity primary key,
 actor uuid references auth.users(id) on delete set null,
 action text not null, dataset text, record_id text,
 at timestamptz not null default now()
);
alter table public.tix_admin_audit enable row level security;
revoke all on public.tix_admin_audit from public,anon,authenticated;
grant all on public.tix_admin_audit to service_role;
grant usage,select on sequence public.tix_admin_audit_id_seq to service_role;

create or replace function public.tix_is_admin() returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.tix_admins a join auth.users u on u.id=a.owner_id
 where a.owner_id=auth.uid() and u.email_confirmed_at is not null)
$$;
revoke all on function public.tix_is_admin() from public,anon;
grant execute on function public.tix_is_admin() to authenticated;

create index if not exists tix_watch_audit_at on public.tix_watch_audit(at);
create index if not exists tix_alerts_sent_at on public.tix_alerts(sent_at);
create or replace function public.tix_admin_overview(p_days integer default 30) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; start_at timestamptz; days integer:=least(90,greatest(1,coalesce(p_days,30)));
begin
 if not public.tix_is_admin() then raise exception 'Administrator access required' using errcode='42501'; end if;
 start_at:=date_trunc('day',now() at time zone 'UTC') at time zone 'UTC'-(days-1)*interval '1 day';
 select jsonb_build_object(
 'generated_at',now(),'days',days,'timezone','UTC',
 'users',(select count(*) from auth.users),
 'signed_in_users',(select count(*) from auth.users where last_sign_in_at>=start_at),
 'users_with_alerts',(select count(distinct owner_id) from public.tix_watches),
 'active_alerts',(select count(*) from public.tix_watches where active and coalesce(match->>'archived_at','')='' and purchased_at is null),
 'paused_alerts',(select count(*) from public.tix_watches where not active and coalesce(match->>'archived_at','')='' and purchased_at is null),
 'archived_alerts',(select count(*) from public.tix_watches where coalesce(match->>'archived_at','')<>'' or purchased_at is not null),
 'email_alerts',(select count(*) from public.tix_watches where active and email_enabled and coalesce(match->>'archived_at','')='' and purchased_at is null),
 'sms_alerts',(select count(*) from public.tix_watches where active and sms_enabled and coalesce(match->>'archived_at','')='' and purchased_at is null),
 'history_follows',(select count(*) from public.tix_history_tracking),
 'deliveries',(select count(*) from public.tix_alerts where sent_at>=start_at and status='sent'),
 'failed_deliveries',(select count(*) from public.tix_alerts where sent_at>=start_at and status='failed'),
 'latest_check',(select max(checked_at) from public.tix_scans),
 'failed_latest_checks',(select count(*) from public.tix_scans where outcome in ('failed','parser_failure','http_failure')),
 'provider_requests_24h',(select count(*) from public.tix_provider_http where at>=now()-interval '24 hours'),
 'provider_guard',(select to_jsonb(g) from public.tix_provider_guard g where id),
 'daily',(select coalesce(jsonb_agg(to_jsonb(d) order by d.day),'[]') from (
 select s.day::date as day,
 (select count(*) from auth.users where created_at>=s.day and created_at<s.day+interval '1 day') signups,
 (select count(*) from public.tix_watch_audit where at>=s.day and at<s.day+interval '1 day' and action='insert') alerts_created,
 (select count(*) from public.tix_watch_audit where at>=s.day and at<s.day+interval '1 day' and action='update') alert_changes,
 (select count(*) from public.tix_alerts where sent_at>=s.day and sent_at<s.day+interval '1 day' and status='sent') sent,
 (select count(*) from public.tix_alerts where sent_at>=s.day and sent_at<s.day+interval '1 day' and status='failed') failed
 from generate_series(start_at,date_trunc('day',now() at time zone 'UTC') at time zone 'UTC',interval '1 day') s(day)) d),
 'popular_alerts',(select coalesce(jsonb_agg(to_jsonb(d)),'[]') from (
 select label,count(*) alerts,count(distinct owner_id) users from public.tix_watches
 where active and coalesce(match->>'archived_at','')='' and purchased_at is null group by label order by count(*) desc,label limit 15) d)
 ) into result;
 return result;
end $$;

-- Explicit allowlist: never arbitrary SQL, auth credentials, or unrelated project tables.
-- JSON rows preserve every business field; auth profiles use only approved columns.
create or replace function public.tix_admin_data(p_dataset text default 'watches',p_search text default '',p_offset integer default 0,p_limit integer default 50,p_snapshot timestamptz default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare source_sql text; order_sql text; result jsonb; rows_json jsonb; total bigint;
 needle text:=left(coalesce(p_search,''),150); skip integer:=greatest(0,coalesce(p_offset,0));
 take integer:=least(200,greatest(1,coalesce(p_limit,50))); snapshot_at timestamptz:=least(coalesce(p_snapshot,now()),now());
begin
 if not public.tix_is_admin() then raise exception 'Administrator access required' using errcode='42501'; end if;
 case p_dataset
 when 'users' then
 source_sql:='select jsonb_build_object(''id'',u.id,''email'',u.email,''email_confirmed_at'',u.email_confirmed_at,''created_at'',u.created_at,''last_sign_in_at'',u.last_sign_in_at,''alerts'',(select count(*) from public.tix_watches w where w.owner_id=u.id),''active_alerts'',(select count(*) from public.tix_watches w where w.owner_id=u.id and active and coalesce(match->>''archived_at'','''')='''' and purchased_at is null),''admin'',exists(select 1 from public.tix_admins a where a.owner_id=u.id)) data, u.created_at stamp,u.id::text key from auth.users u';
 when 'watches' then
 source_sql:='select to_jsonb(w)||jsonb_build_object(''owner_email'',u.email,''last_check'',(select max(checked_at) from public.tix_scans s where s.watch_id=w.id),''last_notification'',(select max(sent_at) from public.tix_alerts a where a.watch_id=w.id and a.status=''sent'')) data,w.created_at stamp,w.id::text key from public.tix_watches w left join auth.users u on u.id=w.owner_id';
 when 'destinations' then source_sql:='select to_jsonb(t) data,t.updated_at stamp,t.watch_id::text key from public.tix_destinations t';
 when 'confirmations' then source_sql:='select to_jsonb(t) data,t.requested_at stamp,t.watch_id::text key from public.tix_confirmation_queue t';
 when 'deliveries' then source_sql:='select to_jsonb(t)||jsonb_build_object(''owner_email'',u.email,''alert_label'',w.label) data,t.sent_at stamp,t.id::text key from public.tix_alerts t left join public.tix_watches w on w.id=t.watch_id left join auth.users u on u.id=w.owner_id';
 when 'scans' then source_sql:='select to_jsonb(t) data,t.checked_at stamp,t.watch_id::text||t.event_id key from public.tix_scans t';
 when 'prices' then source_sql:='select to_jsonb(t) data,t.checked_at stamp,t.id::text key from public.tix_prices t';
 when 'tracking' then source_sql:='select to_jsonb(t)||jsonb_build_object(''owner_email'',u.email) data,t.created_at stamp,t.owner_id::text||t.event_id key from public.tix_history_tracking t left join auth.users u on u.id=t.owner_id';
 when 'watch_audit' then source_sql:='select to_jsonb(t) data,t.at stamp,t.id::text key from public.tix_watch_audit t';
 when 'admin_audit' then source_sql:='select to_jsonb(t) data,t.at stamp,t.id::text key from public.tix_admin_audit t';
 when 'catalog' then source_sql:='select to_jsonb(t) data,t.last_seen stamp,t.event_id key from public.tix_catalog t';
 when 'teams' then source_sql:='select to_jsonb(t) data,coalesce(t.checked_at,''epoch''::timestamptz) stamp,t.team_id key from public.tix_teams t';
 when 'jobs' then source_sql:='select to_jsonb(t) data,t.requested_at stamp,t.event_id key from public.tix_capture_jobs t';
 when 'observations' then source_sql:='select to_jsonb(t) data,t.checked_at stamp,t.id::text key from public.tix_event_observations t';
 when 'listings' then source_sql:='select to_jsonb(t) data,o.checked_at stamp,t.observation_id::text||lpad(t.ordinal::text,10,''0'') key from public.tix_listing_observations t join public.tix_event_observations o on o.id=t.observation_id';
 when 'team_events' then source_sql:='select to_jsonb(t) data,t.checked_at stamp,t.team_id||t.event_id key from public.tix_team_events t';
 when 'team_demand' then source_sql:='select to_jsonb(t) data,t.requested_at stamp,t.team_id key from public.tix_team_demand t';
 when 'discovery_interest' then source_sql:='select to_jsonb(t) data,t.requested_at stamp,t.event_id key from public.tix_discovery_interest t';
 when 'search_limits' then source_sql:='select to_jsonb(t) data,t.window_start stamp,t.owner_id::text key from public.tix_search_request_limits t';
 when 'venue_clubs' then source_sql:='select to_jsonb(t) data,t.updated_at stamp,t.venue_slug key from public.tix_venue_clubs t';
 when 'event_changes' then source_sql:='select to_jsonb(t) data,t.detected_at stamp,t.id::text key from public.tix_event_changes t';
 when 'health' then source_sql:='select to_jsonb(t) data,t.updated_at stamp,t.k key from public.tix_state t where k in (''collector_health'',''notification_health'',''catalog_refreshed_at'')';
 when 'provider_requests' then source_sql:='select to_jsonb(t) data,t.at stamp,t.id::text key from public.tix_provider_http t';
 else raise exception 'Unknown admin dataset';
 end case;
 execute 'select count(*) from ('||source_sql||') s where stamp<=$1 and ($2='''' or strpos(lower(data::text),lower($2))>0)' into total using snapshot_at,needle;
 execute 'select coalesce(jsonb_agg(data order by stamp desc,key),''[]'') from (select * from ('||source_sql||') s where stamp<=$1 and ($2='''' or strpos(lower(data::text),lower($2))>0) order by stamp desc,key limit $3 offset $4) page'
 into rows_json using snapshot_at,needle,take,skip;
 insert into public.tix_admin_audit(actor,action,dataset) values(auth.uid(),'read',p_dataset);
 return jsonb_build_object('rows',rows_json,'total',total,'offset',skip,'limit',take,'snapshot',snapshot_at);
end $$;

-- Administrative alert management uses the same row constraints and audit trigger.
-- No impersonation, permission editor, arbitrary SQL, or hard-delete operation.
create or replace function public.tix_admin_update_alert(p_id uuid,p_patch jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare w public.tix_watches; k text;
begin
 if not public.tix_is_admin() then raise exception 'Administrator access required' using errcode='42501'; end if;
 if p_patch is null or jsonb_typeof(p_patch)<>'object' then raise exception 'Choose alert changes'; end if;
 for k in select jsonb_object_keys(p_patch) loop
 if k not in ('active','label','qty','threshold_cents','email_enabled','sms_enabled','alert_style','match','clubs','kind','purchased_at','purchase_price_cents') then raise exception 'Unsupported alert field'; end if;
 end loop;
 select * into w from public.tix_watches where id=p_id for update;
 if not found then raise exception 'Alert no longer exists'; end if;
 w:=jsonb_populate_record(w,p_patch);
 if w.sms_enabled and not exists(select 1 from public.tix_destinations where watch_id=p_id) then raise exception 'Configure a text destination before enabling texts'; end if;
 update public.tix_watches set active=w.active,label=w.label,qty=w.qty,threshold_cents=w.threshold_cents,
 email_enabled=w.email_enabled,sms_enabled=w.sms_enabled,alert_style=w.alert_style,match=w.match,clubs=w.clubs,
 kind=w.kind,purchased_at=w.purchased_at,purchase_price_cents=w.purchase_price_cents where id=p_id;
 insert into public.tix_admin_audit(actor,action,dataset,record_id) values(auth.uid(),'update','watches',p_id::text);
end $$;
revoke all on function public.tix_admin_overview(integer) from public,anon;
revoke all on function public.tix_admin_data(text,text,integer,integer,timestamptz) from public,anon;
revoke all on function public.tix_admin_update_alert(uuid,jsonb) from public,anon;
grant execute on function public.tix_admin_overview(integer),public.tix_admin_data(text,text,integer,integer,timestamptz),public.tix_admin_update_alert(uuid,jsonb) to authenticated;
commit;
