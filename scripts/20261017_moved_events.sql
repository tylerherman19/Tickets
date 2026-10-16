-- Apply after 20261016_fast_search.sql. Idempotent.
--
-- Moved event pages. Gametime sometimes answers a saved event link with a
-- redirect (for example after a date change). Redirects are never followed:
--  * A redirect to the same event's page on gametime.co saves the new link and
--    the event can be re-checked right away with it.
--  * Anything else (another site, another event, no link), or an event that
--    keeps moving without a successful check, backs off: 6 hours, then
--    doubling up to 7 days, so searches stop spending requests on it.
--  * A new link from the sitemap refresh clears that back-off.
-- Request limits, provider blocking and the budget are unchanged.
begin;

alter table public.tix_capture_jobs add column if not exists redirects integer not null default 0;
alter table public.tix_capture_jobs add column if not exists redirected_at timestamptz;

create or replace function public.tix_note_redirect(p_token uuid,p_location text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare l public.tix_capture_leases; e public.tix_catalog; j public.tix_capture_jobs; target text; n integer; next_at timestamptz;
begin
 perform pg_advisory_xact_lock(72634112);
 select * into l from public.tix_capture_leases where token=p_token and expires_at>now();
 if l.event_id is null then raise exception 'Capture lease expired'; end if;
 select * into e from public.tix_catalog where event_id=l.event_id;
 select * into j from public.tix_capture_jobs where event_id=l.event_id;
 -- Only an absolute https://gametime.co link to this same event.
 target:=case when length(p_location)<=500 and p_location ~ '^https://gametime\.co(/[A-Za-z0-9._~%-]+)+$'
  and p_location !~ '/\.\.?(/|$)' and right(p_location,length(l.event_id)+8)='/events/'||l.event_id
  and p_location is distinct from e.url then p_location end;
 -- Redirects since the last event page that was actually read form one streak.
 n:=case when j.redirected_at is not null and not exists(select 1 from public.tix_event_observations o
  where o.event_id=l.event_id and o.state<>'failed' and o.format is distinct from 'directory' and o.checked_at>j.redirected_at)
  then coalesce(j.redirects,0)+1 else 1 end;
 if target is not null and n<=2 then
  update public.tix_catalog set url=target where event_id=l.event_id;
  update public.tix_capture_jobs set state='queued',reason='url_moved',next_attempt_at=now(),redirects=n,redirected_at=now()
  where event_id=l.event_id;
  delete from public.tix_capture_leases where token=p_token;
  return jsonb_build_object('state','queued','reason','url_moved','next_attempt_at',now());
 end if;
 next_at:=now()+least(interval '7 days',interval '6 hours'*power(2,least(n,6)-1));
 insert into public.tix_event_observations(event_id,source,state,meta)
 values(l.event_id,l.source,'failed',jsonb_build_object('reason','redirected'));
 update public.tix_catalog set discovery_attempt_at=now() where event_id=l.event_id;
 update public.tix_capture_jobs set state='failed',reason='redirected',next_attempt_at=greatest(next_attempt_at,next_at),
  redirects=n,redirected_at=now() where event_id=l.event_id;
 delete from public.tix_capture_leases where token=p_token;
 return jsonb_build_object('state','failed','reason','redirected','next_attempt_at',greatest(j.next_attempt_at,next_at));
end $$;

-- The sitemap refresh replaced the link of an event that was backing off
-- after a redirect: the new link may work, so it is due again.
create or replace function public.tix_catalog_url_changed() returns trigger
language plpgsql set search_path='' as $$
begin
 update public.tix_capture_jobs set next_attempt_at=least(next_attempt_at,now()),redirects=0,redirected_at=null
 where event_id=new.event_id and reason='redirected';
 return null;
end $$;
drop trigger if exists tix_catalog_url_changed on public.tix_catalog;
create trigger tix_catalog_url_changed after update of url on public.tix_catalog
 for each row when (old.url is distinct from new.url) execute function public.tix_catalog_url_changed();

revoke all on function public.tix_note_redirect(uuid,text) from public,anon,authenticated;
grant execute on function public.tix_note_redirect(uuid,text) to service_role;
commit;
