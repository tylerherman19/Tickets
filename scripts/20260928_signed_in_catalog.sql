-- Event discovery is public even after a visitor signs in. The original
-- catalog and venue policies only named anon, so authenticated users saw an
-- empty security-invoker view despite there being upcoming events.
begin;
grant select on public.tix_catalog, public.tix_events_v, public.tix_venue_clubs to authenticated;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public'
    and tablename='tix_catalog' and policyname='signed in read catalog') then
    create policy "signed in read catalog" on public.tix_catalog
      for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public'
    and tablename='tix_venue_clubs' and policyname='signed in read venue clubs') then
    create policy "signed in read venue clubs" on public.tix_venue_clubs
      for select to authenticated using (true);
  end if;
  if to_regclass('public.tix_teams_v') is not null then
    grant select on public.tix_teams_v to authenticated;
  end if;
end $$;
commit;
