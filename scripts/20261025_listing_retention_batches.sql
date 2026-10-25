-- Honor the existing owner-approved policy without sorting every raw listing.
begin;
create index if not exists tix_event_observations_retention_order
 on public.tix_event_observations(checked_at,id);
create or replace function public.tix_prune_listing_copies(p_execute boolean default false,p_limit integer default 5000)
returns jsonb language plpgsql security definer set search_path='' as $$
declare n integer;eligible bigint;
begin
 if p_execute is distinct from true then
  select count(*) into eligible from public.tix_listing_observations l
   join public.tix_event_observations o on o.id=l.observation_id
   where o.checked_at<now()-interval '1 day';
  return jsonb_build_object('eligible_rows',eligible,'enabled',(
   select listing_retention_enabled from public.tix_storage_policy where id));
 end if;
 if not coalesce((select listing_retention_enabled from public.tix_storage_policy where id),false)
  then raise exception 'Owner approval for listing retention is required';end if;
 if not pg_try_advisory_xact_lock(72634124) then
  return jsonb_build_object('deleted',0,'busy',true);end if;
 with observations as materialized (
  select o.id,o.checked_at from public.tix_event_observations o
  cross join lateral(select 1 from public.tix_listing_observations l
   where l.observation_id=o.id limit 1) present
  where o.checked_at<now()-interval '1 day'
  order by o.checked_at,o.id limit 32
 ), candidates as materialized (
  -- LIMIT inside the lateral lookup prevents a cached generic plan from
  -- hash-joining the entire 1GB+ raw table. Lock only the bounded candidates.
  select l.*,o.checked_at from observations o cross join lateral(
   select l.ctid tid,l.observation_id,l.ordinal,l.verified_quantity,l.lots,l.seats,
    l.price_cents,l.basis,l.section,l.section_group
   from public.tix_listing_observations l where l.observation_id=o.id
   order by l.ordinal limit 5000 for update of l skip locked
  ) l order by o.checked_at,l.observation_id,l.ordinal
  limit least(greatest(p_limit,256),5000)
 ), due as materialized (
  select l.tid from candidates l
  -- Keep every row whose quantity/section history has not been preserved.
  where not exists(
   select 1 from generate_series(1,8) q(qty)
   cross join lateral(select distinct x.section from(values(''::text),(l.section),(l.section_group)) x(section)
    where x.section is not null) a
   where (l.verified_quantity=q.qty or q.qty=any(l.lots) and jsonb_typeof(l.seats)='array' and jsonb_array_length(l.seats)>=q.qty)
   and l.price_cents>0 and l.basis in('fees_included_tax_reported','fees_included_tax_unknown')
   and not exists(select 1 from public.tix_listing_price_rollup r where r.observation_id=l.observation_id
    and r.qty=q.qty and r.basis=l.basis and r.section=a.section))
  order by l.checked_at,l.observation_id,l.ordinal
  limit least(greatest(p_limit,1),5000)
 )
 -- A TID array forces direct heap lookups for the locked rows, rather than
 -- letting DELETE choose another full-table join against the small batch.
 delete from public.tix_listing_observations l where l.ctid=any(array(select tid from due));
 get diagnostics n=row_count;
 return jsonb_build_object('deleted',n);
end $$;
revoke all on function public.tix_prune_listing_copies(boolean,integer) from public,anon,authenticated;
grant execute on function public.tix_prune_listing_copies(boolean,integer) to service_role;
insert into public.tix_schema_versions(version) values(20261030) on conflict do nothing;
commit;
notify pgrst, 'reload schema';
