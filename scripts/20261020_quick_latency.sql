-- Supply fresh metadata to the warm worker to avoid a duplicate HTTP request.
begin;
create or replace function public.tix_quick_due(p_limit integer default 3)
returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) from (
 select c.*,j.detail_requested,j.requested_quantities,j.warm_quantities from public.tix_capture_jobs j join public.tix_events_v c using(event_id)
 where (j.detail_requested and cardinality(j.requested_quantities)>0 or j.requested_at_latest>now()-interval '1 day' and cardinality(j.warm_quantities)>0) and j.next_attempt_at<=now()
 and c.event_date between current_date and current_date+365
 and not exists(select 1 from public.tix_capture_leases l where l.event_id=j.event_id and l.expires_at>now())
 order by j.detail_requested desc,(j.requested_at_latest<now()-interval '2 minutes') desc,j.requested_at_latest desc,j.next_attempt_at limit least(greatest(p_limit,1),6)) x;
$$;
revoke all on function public.tix_quick_due(integer) from public,anon,authenticated;
grant execute on function public.tix_quick_due(integer) to service_role;
insert into public.tix_schema_versions(version) values(20261023) on conflict do nothing;
commit;
notify pgrst,'reload schema';
