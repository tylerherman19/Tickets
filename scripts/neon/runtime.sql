-- Only the verified identity selected by the backend is mirrored. This RPC
-- is never granted to browser roles and cannot create a managed login.
create table if not exists ticketline_internal.recovered_watches(
 id uuid primary key,owner_email text not null,criteria jsonb not null,claimed_by uuid references ticketline_auth.users(id),claimed_at timestamptz
);
revoke all on ticketline_internal.recovered_watches from public,anon,anonymous,authenticated,service_role;
create or replace function public.tix_sync_neon_user(p_user_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
 insert into ticketline_auth.users(id,email,email_confirmed_at,created_at,last_sign_in_at)
 select id,email,case when "emailVerified" then "createdAt" end,"createdAt",now()
 from neon_auth."user" where id=p_user_id
 on conflict(id) do update set email=excluded.email,email_confirmed_at=excluded.email_confirmed_at,last_sign_in_at=now();
 -- A verified mailbox is required. Older confirmations may not reflect the
 -- latest settings, so recovered watches remain paused until their owner reviews them.
 insert into public.tix_watches(id,owner_id,active,label,kind,match,qty,threshold_cents,alert_style,email_enabled,sms_enabled)
 select r.id,u.id,false,r.criteria->>'label','event',r.criteria->'match',(r.criteria->>'qty')::integer,(r.criteria->>'threshold_cents')::integer,'first',true,false
 from ticketline_internal.recovered_watches r join ticketline_auth.users u on lower(u.email)=lower(r.owner_email)
 where u.id=p_user_id and u.email_confirmed_at is not null and r.claimed_by is null
 on conflict(id) do nothing;
 update ticketline_internal.recovered_watches r set claimed_by=p_user_id,claimed_at=now()
 where r.claimed_by is null and exists(select 1 from public.tix_watches w where w.id=r.id and w.owner_id=p_user_id);
end
$$;
revoke all on function public.tix_sync_neon_user(uuid) from public,anon,anonymous,authenticated;
grant execute on function public.tix_sync_neon_user(uuid) to service_role;
grant anon to anonymous;
grant usage on schema public to anon,anonymous,authenticated,service_role;
-- Preserve the owner's already-enabled Ticketline retention policy. Only
-- redundant raw copies older than one day with verified rollups are removed.
update public.tix_storage_policy set listing_retention_enabled=true where id;
create or replace function public.tix_neon_capacity() returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('database_bytes',pg_database_size(current_database()),'provider_enabled',coalesce((select enabled from public.tix_provider_guard where id),false),'capture_headroom',pg_database_size(current_database())<650000000)
$$;
revoke all on function public.tix_neon_capacity() from public,anon,anonymous,authenticated;
grant execute on function public.tix_neon_capacity() to service_role;
