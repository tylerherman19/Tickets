-- Supabase compatibility for a NEW, isolated Ticketline Neon database only.
do $$ begin
 if not exists(select 1 from pg_roles where rolname='anon') then create role anon;end if;
 if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated;end if;
 if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role;end if;
end $$;
create schema if not exists ticketline_auth;
create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;
create table if not exists ticketline_auth.users(
 id uuid primary key,email text,email_confirmed_at timestamptz,created_at timestamptz not null default now(),last_sign_in_at timestamptz
);
alter table ticketline_auth.users enable row level security;
revoke all on ticketline_auth.users from public,anon,authenticated;
create or replace function ticketline_auth.uid() returns uuid language sql stable set search_path='' as $$
 select nullif(coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub',current_setting('request.jwt.claim.sub',true)),'')::uuid
$$;
grant usage on schema ticketline_auth to anon,authenticated,service_role;
grant execute on function ticketline_auth.uid() to anon,authenticated,service_role;
-- Match Supabase's initial privileges; the reviewed migrations below revoke
-- privileged access and apply their original RLS policies before API exposure.
alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
alter default privileges in schema public grant all on sequences to anon,authenticated,service_role;
create schema if not exists ticketline_internal;
revoke all on schema ticketline_internal from public,anon,authenticated,service_role;
create table if not exists ticketline_internal.migrations(filename text primary key,sha256 text not null,applied_at timestamptz not null default now());
