-- General event search; retains private-table RLS and all existing provider budgets.
begin;
alter table public.tix_teams add column if not exists search_aliases text[] not null default '{}';
alter table public.tix_teams add column if not exists search_regions text[] not null default '{}';
-- Editorial geographic/school associations, keyed to existing canonical provider IDs.
-- These do not assert event membership or home/away; imports preserve them.
update public.tix_teams set search_regions=array['WI'] where team_id in ('cbbwis','cfbwis','mlbmil','nbamil','nflgnb');
update public.tix_teams set search_aliases=array['Badgers','Wisconsin Badgers','UW Madison'] where team_id in ('cbbwis','cfbwis');
create index if not exists tix_team_events_home_region on public.tix_team_events(team_id,event_id) where is_home=true;

create or replace function public.tix_match_search_teams(p_query text default '',p_category text default null,p_region text default null,p_limit integer default 100)
returns table(team_id text,category text,label text,aliases text[],event_count bigint)
language plpgsql stable security definer set search_path='' as $$
begin
 return query execute $q$
 with q as(select public.tix_normalize_team(left(coalesce($1,''),100)) value),
 curated as materialized(select t.team_id from public.tix_teams t cross join q where q.value<>'' and exists(select 1 from unnest(t.search_aliases) a where public.tix_normalize_team(a)=q.value)),
 matched as materialized(
 select t.* from public.tix_teams t cross join q where
 ($2 is null or $2='all-sports' or t.category=$2) and q.value<>'' and (
 (exists(select 1 from curated) and t.team_id in(select c.team_id from curated c)) or
 (not exists(select 1 from curated) and (
 t.team_id=q.value or public.tix_normalize_team(t.label) like '%'||q.value||'%' or
 exists(select 1 from unnest(t.aliases||t.search_aliases) a where public.tix_normalize_team(a)=q.value or (length(q.value)>=3 and public.tix_normalize_team(a) like '%'||q.value||'%')) or
 ($3 is not null and ($3=any(t.search_regions) or exists(
 select 1 from public.tix_team_events te join public.tix_catalog c using(event_id)
 where te.team_id=t.team_id and te.is_home=true and c.state=$3))))))
 )
 select t.team_id,t.category,t.label,t.aliases||t.search_aliases,
 (select count(*) from public.tix_team_events te join public.tix_events_v c using(event_id) where te.team_id=t.team_id and c.event_date between current_date and current_date+365)
 from matched t order by t.label,t.team_id limit least(greatest(coalesce($4,100),0),1200)
 $q$ using p_query,p_category,p_region,p_limit;
end $$;

create or replace function public.tix_general_search(
 p_query text default '',p_category text default null,p_region text default null,
 p_place_state text default null,p_place_city text default null,p_date date default null,
 p_through date default null,p_max_cents integer default null,p_priced_since timestamptz default null,
 p_cheap boolean default false,p_offset integer default 0,p_limit integer default 13)
returns setof public.tix_events_v language plpgsql stable security definer set search_path='' as $$
declare term text:=public.tix_normalize_team(left(coalesce(p_query,''),100)); cat text:=nullif(p_category,''); curated_match boolean; team_ids text[]; families text[]; conflicts text[]; family_names text[]; family_slugs text[]; conflict_names text[]; conflict_slugs text[];
begin
 if term in ('concert','concerts') and cat is null then cat:='concert';term:=''; end if;
 if term in ('sports','all sports') and cat is null then cat:='all-sports';term:=''; end if;
 select exists(select 1 from public.tix_teams t,unnest(t.search_aliases) a where public.tix_normalize_team(a)=term) into curated_match;
 select coalesce(array_agg(t.team_id),'{}') into team_ids from public.tix_match_search_teams(term,cat,p_region,1200) t;
 select coalesce(array_agg(distinct value),'{}') into families from (
 select distinct on(t.team_id) public.tix_normalize_team(a) value from public.tix_teams t,unnest(t.search_aliases) a
 where t.team_id=any(team_ids) and length(a)>=3 order by t.team_id,length(a),a
 ) shortest_family_alias;
 with aliases as materialized(
  select t.team_id,public.tix_normalize_team(a) value from public.tix_teams t,unnest(t.aliases) a where not(t.team_id=any(team_ids))
 ), conflict_teams as materialized(
  select distinct a.team_id from aliases a where a.value=any(families) or exists(select 1 from unnest(families) f where a.value like '% '||f)
 ), names as (
  select a.value from aliases a where exists(select 1 from unnest(families) f where a.value like '% '||f)
  union select regexp_replace(public.tix_normalize_team(t.label),' (?:(?:men s|women s|mens|womens) )?(basketball|football|hockey|volleyball|wrestling)$','')
  from public.tix_teams t join conflict_teams c using(team_id)
 ) select coalesce(array_agg(distinct value),'{}') into conflicts from names where length(value)>=4;
 select coalesce(array_agg('%'||f||'%'),'{}'),coalesce(array_agg('%'||replace(f,' ','-')||'%'),'{}') into family_names,family_slugs from unnest(families) f;
 select coalesce(array_agg('%'||f||'%'),'{}'),coalesce(array_agg('%'||replace(f,' ','-')||'%'),'{}') into conflict_names,conflict_slugs from unnest(conflicts) f;
 return query execute $q$
 with membership as materialized(select distinct te.event_id from public.tix_team_events te where te.team_id=any($14)), matched as materialized(
 select c.* from public.tix_events_v c where
 c.event_date between current_date and current_date+365 and c.event_date between coalesce($6,current_date) and coalesce($6,least(coalesce($7,current_date+365),current_date+365))
 and ($2 is null or ($2='all-sports' and c.category in ('nfl-football','college-football','nba-basketball','college-basketball','mlb-baseball','nhl-hockey','mls-soccer','wnba','pwhl','sports')) or c.category=$2)
 and (case when $13 then (c.event_id in(select event_id from membership) or (coalesce(c.name,'') ilike any($15) or coalesce(c.slug,'') ilike any($16))) else ($1='' or c.name ilike '%'||$1||'%' or c.slug ilike '%'||replace($1,' ','-')||'%' or c.venue ilike '%'||$1||'%' or c.city ilike '%'||$1||'%' or c.state=$3 or c.event_id in(select event_id from membership) or (coalesce(c.name,'') ilike any($15) or coalesce(c.slug,'') ilike any($16))) end)
 and ($4 is null or c.state=$4) and ($5 is null or public.tix_normalize_team(c.city) like '%'||public.tix_normalize_team($5)||'%')
 and ($8 is null or c.min_total<=$8)
 and ($9 is null or (c.min_total is not null and c.price_checked_at>=$9))
)
 select c.* from matched c where (c.event_id in(select event_id from membership) or not(coalesce(c.name,'') ilike any($17) or coalesce(c.slug,'') ilike any($18)))
 order by case when $10 then c.min_total end nulls last,c.event_date,c.event_id
 limit least(greatest(coalesce($12,13),1),201) offset least(greatest(coalesce($11,0),0),100000)
 $q$ using term,cat,p_region,p_place_state,p_place_city,p_date,p_through,p_max_cents,p_priced_since,p_cheap,p_offset,p_limit,curated_match,team_ids,family_names,family_slugs,conflict_names,conflict_slugs;
end $$;
revoke all on function public.tix_match_search_teams(text,text,text,integer) from public;
revoke all on function public.tix_general_search(text,text,text,text,text,date,date,integer,timestamptz,boolean,integer,integer) from public;
grant execute on function public.tix_match_search_teams(text,text,text,integer), public.tix_general_search(text,text,text,text,text,date,date,integer,timestamptz,boolean,integer,integer) to anon,authenticated,service_role;
commit;
