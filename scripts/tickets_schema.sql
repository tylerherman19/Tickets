-- ticket-watch tables, same project as prop-edge. Run once (Management API or SQL editor).
create table if not exists tix_catalog (
  event_id text primary key,
  category text,                 -- url prefix: nfl-football, mlb-baseball, concerts, ...
  slug text,                     -- 'dolphins-at-vikings' or performer slug
  name text,                     -- 'Miami Dolphins at Minnesota Vikings' (filled from event page; humanized slug until then)
  event_date date,               -- from the url slug
  datetime_local text,           -- '2026-10-04T15:05:00', filled on first event-page fetch
  venue_slug text,               -- 'u-s-bank-stadium'
  venue text,                    -- display name, filled lazily
  city text, state text,
  url text not null,
  min_total int,                 -- get-in all-in cents, filled lazily
  last_seen timestamptz not null default now()
);
create index if not exists tix_catalog_slug on tix_catalog(slug);
create index if not exists tix_catalog_date on tix_catalog(event_date);
create index if not exists tix_catalog_venue on tix_catalog(venue_slug);

create table if not exists tix_watches (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  active boolean not null default true,
  label text not null,
  kind text not null,            -- event | team | date
  match jsonb not null,          -- {slug, home_away:'home'|'away'|'any', date, event_ids:text[], venue_slug}
  clubs text[] not null default '{}',  -- sectionGroup names; empty = every club group found
  qty int not null default 2,
  threshold_cents int not null,
  alert_style text not null default 'first'  -- first | repeat
);

create table if not exists tix_venue_clubs (
  venue_slug text primary key,
  venue text,
  clubs jsonb not null,          -- [{"group":"Medtronic Club","listings":2,"cheapest":84100}]
  sample_event_id text,
  updated_at timestamptz not null default now()
);

create table if not exists tix_prices (
  id bigint generated always as identity primary key,
  checked_at timestamptz not null default now(),
  watch_id uuid references tix_watches(id) on delete cascade,
  event_id text not null,
  event_label text,
  club text not null,
  qty int not null,
  price_cents int not null,      -- cheapest per-ticket all-in for qty+ seats together
  listing_id text,
  listing_url text
);
create index if not exists tix_prices_watch on tix_prices(watch_id, checked_at desc);
create index if not exists tix_prices_event on tix_prices(event_id, checked_at desc);

create table if not exists tix_alerts (
  id bigint generated always as identity primary key,
  sent_at timestamptz not null default now(),
  watch_id uuid references tix_watches(id) on delete cascade,
  event_id text not null,
  club text not null,
  qty int not null,
  price_cents int not null,
  listing_id text,
  listing_url text,
  status text not null default 'sent'   -- sent | failed
);
create index if not exists tix_alerts_dedup on tix_alerts(watch_id, event_id, club, sent_at desc);

create table if not exists tix_state (
  k text primary key,
  v jsonb,
  updated_at timestamptz not null default now()
);

-- single-user posture, same as the prop tables: anon reads everything the site needs,
-- anon may also manage watches; all writes to the rest are service-key only.
alter table tix_catalog enable row level security;
alter table tix_watches enable row level security;
alter table tix_venue_clubs enable row level security;
alter table tix_prices enable row level security;
alter table tix_alerts enable row level security;
alter table tix_state enable row level security;

create policy "public read catalog" on tix_catalog for select to anon using (true);
create policy "anon manages watches" on tix_watches for all to anon using (true) with check (true);
create policy "public read venue clubs" on tix_venue_clubs for select to anon using (true);
create policy "public read prices" on tix_prices for select to anon using (true);
create policy "public read alerts" on tix_alerts for select to anon using (true);
