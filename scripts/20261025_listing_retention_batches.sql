-- Honor the existing owner-approved policy without sorting every raw listing.
begin;
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
  where o.checked_at<now()-interval '1 day' and exists(
   select 1 from public.tix_listing_observations l where l.observation_id=o.id)
  order by o.checked_at,o.id limit 128
 ), due as materialized (
  select l.observation_id,l.ordinal from observations o
  join public.tix_listing_observations l on l.observation_id=o.id
  -- Keep every row whose quantity/section history has not been preserved.
  where not exists(
   select 1 from generate_series(1,8) q(qty)
   cross join lateral(select distinct x.section from(values(''::text),(l.section),(l.section_group)) x(section)
    where x.section is not null) a
   where (l.verified_quantity=q.qty or q.qty=any(l.lots) and jsonb_typeof(l.seats)='array' and jsonb_array_length(l.seats)>=q.qty)
   and l.price_cents>0 and l.basis in('fees_included_tax_reported','fees_included_tax_unknown')
   and not exists(select 1 from public.tix_listing_price_rollup r where r.observation_id=l.observation_id
    and r.qty=q.qty and r.basis=l.basis and r.section=a.section))
  order by o.checked_at,l.observation_id,l.ordinal
  limit least(greatest(p_limit,1),5000) for update of l skip locked
 )
 delete from public.tix_listing_observations l using due d
 where l.observation_id=d.observation_id and l.ordinal=d.ordinal;
 get diagnostics n=row_count;
 return jsonb_build_object('deleted',n);
end $$;
revoke all on function public.tix_prune_listing_copies(boolean,integer) from public,anon,authenticated;
grant execute on function public.tix_prune_listing_copies(boolean,integer) to service_role;
insert into public.tix_schema_versions(version) values(20261030) on conflict do nothing;
commit;
notify pgrst, 'reload schema';
