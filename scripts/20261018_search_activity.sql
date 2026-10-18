-- First-party submitted/opened search activity; no IP or visitor identifier.
begin;
create table if not exists public.tix_searches(
 id uuid primary key, owner_id uuid references auth.users(id) on delete cascade,
 searched_at timestamptz not null default now(), query text not null check(length(query) between 1 and 100),
 normalized_query text not null, filters jsonb not null default '{}',
 visible_results integer not null check(visible_results between 0 and 12), has_more boolean not null,
 outcome text not null check(outcome in ('results','no_results','failed')), source text not null check(source in ('submit','link'))
);
create index if not exists tix_searches_time on public.tix_searches(searched_at);
create table if not exists public.tix_search_log_limits(bucket text primary key, window_start timestamptz not null, requests integer not null);
alter table public.tix_searches enable row level security;
alter table public.tix_search_log_limits enable row level security;
revoke all on public.tix_searches,public.tix_search_log_limits from public,anon,authenticated;
grant all on public.tix_searches,public.tix_search_log_limits to service_role;
create or replace function public.tix_search_safe_text(p_text text) returns text
language sql immutable set search_path='' as $$
 select regexp_replace(regexp_replace(left(trim(regexp_replace(coalesce(p_text,''),'[[:space:]]+',' ','g')),100),
 '[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}','[email removed]','gi'),
 '[+]?[0-9][0-9 ()+.-]{7,}[0-9]','[number removed]','g')
$$;
revoke all on function public.tix_search_safe_text(text) from public,anon,authenticated;
create or replace function public.tix_record_search(p_search_id uuid,p_query text,p_filters jsonb default '{}',p_result_count integer default 0,p_has_more boolean default false,p_outcome text default 'no_results',p_source text default 'submit')
returns boolean language plpgsql security definer set search_path='' as $$
declare q text:=public.tix_search_safe_text(p_query); f jsonb:='{}'; k text; v text; b text; n integer; cap integer;
begin
 if p_search_id is null or q='' or length(coalesce(p_query,''))>100 or jsonb_typeof(p_filters) is distinct from 'object' or length(p_filters::text)>1000
 or p_result_count is null or p_result_count not between 0 and 12 or p_has_more is null
 or p_outcome is null or p_outcome not in ('results','no_results','failed') or p_source is null or p_source not in ('submit','link')
 or (p_outcome='results' and p_result_count=0) or (p_outcome<>'results' and p_result_count<>0) then return false; end if;
 for k,v in select * from jsonb_each_text(p_filters) loop
 if k not in ('category','place','date','within','quantity','max_price','team') then return false; end if;
 if k='place' then v:=left(public.tix_search_safe_text(v),60);
 elsif k in ('category','team') then if length(v)>80 or v !~ '^[a-zA-Z0-9_-]*$' then return false; end if;
 elsif k='date' then if v<>'' and v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return false; end if;
 elsif k='within' then if v not in ('','7','30','all') then return false; end if;
 elsif k='quantity' then if v !~ '^[0-8]$' then return false; end if;
 elsif k='max_price' then if v !~ '^[0-9]{0,5}$' then return false; end if;
 end if;
 if v is null then return false; end if;
 f:=f||jsonb_build_object(k,v);
 end loop;
 perform pg_advisory_xact_lock(72634119);
 delete from public.tix_searches where searched_at<now()-interval '90 days';
 delete from public.tix_search_log_limits where window_start<now()-interval '1 day';
 if exists(select 1 from public.tix_searches where id=p_search_id) then return false; end if;
 -- Shared anonymous/global limits bound abuse without collecting network identities.
 foreach b in array array['global',coalesce(auth.uid()::text,'anonymous')] loop
 cap:=case when b='global' then 600 when b='anonymous' then 300 else 30 end;
 insert into public.tix_search_log_limits values(b,date_trunc('minute',now()),1)
 on conflict(bucket) do update set requests=case when tix_search_log_limits.window_start=date_trunc('minute',now()) then tix_search_log_limits.requests+1 else 1 end,window_start=date_trunc('minute',now()) returning requests into n;
 if n>cap then return false; end if;
 end loop;
 insert into public.tix_searches values(p_search_id,auth.uid(),now(),q,lower(q),f,p_result_count,p_has_more,p_outcome,p_source);
 return true;
end $$;
revoke all on function public.tix_record_search(uuid,text,jsonb,integer,boolean,text,text) from public;
grant execute on function public.tix_record_search(uuid,text,jsonb,integer,boolean,text,text) to anon,authenticated;
create or replace function public.tix_admin_search_activity(p_days integer default 30)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; days integer:=case when p_days in(7,30,90) then p_days else 30 end;
begin
 if not public.tix_is_admin() then raise exception 'Administrator access required' using errcode='42501'; end if;
 delete from public.tix_searches where searched_at<now()-interval '90 days';
 with s as materialized(select * from public.tix_searches where searched_at>=((now() at time zone 'UTC')::date-days+1)::timestamp at time zone 'UTC'),
 terms as(select normalized_query query,count(*) searches,count(*) filter(where outcome='no_results') no_results,max(searched_at) last_searched from s group by normalized_query)
 select jsonb_build_object('days',days,'searches',(select count(*) from s),'distinct_terms',(select count(*) from terms),
 'no_results',(select count(*) from s where outcome='no_results'),'failed',(select count(*) from s where outcome='failed'),
 'signed_in',(select count(*) from s where owner_id is not null),'anonymous',(select count(*) from s where owner_id is null),
 'daily',(select jsonb_agg(d order by day) from(select g::date as day,count(s.id) filter(where outcome='results') results,count(s.id) filter(where outcome='no_results') no_results,count(s.id) filter(where outcome='failed') failed from generate_series((now() at time zone 'UTC')::date-days+1,(now() at time zone 'UTC')::date,interval '1 day') g left join s on (s.searched_at at time zone 'UTC')::date=g::date group by g) d),
 'popular',(select coalesce(jsonb_agg(t),'[]') from(select * from terms order by searches desc,query limit 20)t),
 'unmatched',(select coalesce(jsonb_agg(t),'[]') from(select * from terms where no_results>0 order by no_results desc,query limit 20)t),
 'recent',(select coalesce(jsonb_agg(t),'[]') from(select s.*,u.email owner_email from s left join auth.users u on u.id=s.owner_id order by searched_at desc,id limit 20)t)) into result;
 insert into public.tix_admin_audit(actor,action,dataset) values(auth.uid(),'read','search_activity');
 return result;
end $$;
revoke all on function public.tix_admin_search_activity(integer) from public,anon;
grant execute on function public.tix_admin_search_activity(integer) to authenticated;
create or replace function public.tix_admin_data(p_dataset text default 'watches',p_search text default '',p_offset integer default 0,p_limit integer default 50,p_snapshot timestamptz default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare source_sql text; order_sql text; result jsonb; rows_json jsonb; total bigint;
 needle text:=left(coalesce(p_search,''),150); skip integer:=greatest(0,coalesce(p_offset,0));
 take integer:=least(200,greatest(1,coalesce(p_limit,50))); snapshot_at timestamptz:=least(coalesce(p_snapshot,now()),now());
begin
 if not public.tix_is_admin() then raise exception 'Administrator access required' using errcode='42501'; end if;
 case p_dataset
 when 'searches' then source_sql:='select to_jsonb(t)||jsonb_build_object(''owner_email'',u.email) data,t.searched_at stamp,t.id::text key from public.tix_searches t left join auth.users u on u.id=t.owner_id where t.searched_at>=now()-interval ''90 days''';
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

-- Separate service-only cleanup; does not change marketplace/event retention.
create or replace function public.tix_prune_search_activity() returns integer
language plpgsql security definer set search_path='' as $$
declare n integer;
begin
 delete from public.tix_searches where searched_at<now()-interval '90 days';
 get diagnostics n=row_count;
 delete from public.tix_search_log_limits where window_start<now()-interval '1 day';
 return n;
end $$;
revoke all on function public.tix_prune_search_activity() from public,anon,authenticated;
grant execute on function public.tix_prune_search_activity() to service_role;
commit;
