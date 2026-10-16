# Moved event links and category pages: deploy checklist (October 17)

The first live run on October 16 found Gametime answering some saved event links with a redirect (4 of 12 Vikings results) and two dead category pages (`/c/concerts`, `/c/wnba-basketball`). Redirects are still never followed. A redirect to the same event's page on gametime.co now saves the new link, and the search's automatic retry prices the event with it. Any other redirect backs off (6 hours, doubling to 7 days) so searches and alert checks stop spending requests on it; a new link from the sitemap refresh clears the back-off. The budget, blocking pause and request limits are unchanged.

Each step is safe on its own: until the SQL and the new Edge code are both live, a redirect fails exactly as before.

1. **Merge this PR.** The collector and team/artist sweep pick up the change on their next run. The sweep now uses `/c/wnba` and no longer requests the concerts page.
2. **Apply the SQL** in the SQL Editor: `scripts/20261017_moved_events.sql` (idempotent, additive).
3. **Redeploy the Edge function** `ticketline-prices`, the same way as on October 16 (dashboard editor, one combined file: `supabase/functions/_shared/provider.mjs` with `export function` changed to `function`, then `supabase/functions/ticketline-prices/index.ts` without its provider import line, `// @ts-nocheck` on top). Leave the JWT setting as it is.
4. **Verify.**
   - `select count(*) from pg_proc where proname='tix_note_redirect';` returns 1.
   - Signed in, search "Vikings": moved events show a price (or "Live check queued") instead of "Live check failed". Edge logs show one `ticketline_redirect` line per redirect, with where it pointed.
   - `select event_id,reason,redirects,next_attempt_at from public.tix_capture_jobs where reason in ('url_moved','redirected');`

# Fast search prices: deploy checklist (October 16)

Production check on October 16: the guarded schema (`20261012`) and the `ticketline-prices` Edge function were never deployed, so every collector run used the pinned October 11 collector and searches could only queue a check for the next 15-minute run (events within 30 days only). This release turns the guarded path on at the owner-approved budget of **5,000 provider page requests per day** (40/minute, 420/hour) and makes a signed-in search price its results right away.

Do the steps in this order. Each step is safe on its own; the collector and frontend fall back until the next step lands.

1. **Merge this PR.** Pages publishes the frontend. Until the SQL lands, the collector keeps using the pinned collector and the search fallback uses the signed-in token (the `20261012` migration removes anonymous access to that fallback).
2. **Apply the SQL** in the Supabase dashboard (SQL Editor), one file at a time: `scripts/20261012_guarded_history.sql`, then `scripts/20261016_fast_search.sql`. Both are idempotent and additive. The second one enables the guard at the 5,000/day budget with catalog refresh on, expiry left off.
3. **Deploy the Edge function** from the repo root (it reads `supabase/config.toml` for `verify_jwt` and bundles `supabase/functions/_shared`):
   ```sh
   npx supabase login
   npx supabase functions deploy ticketline-prices --project-ref aahqagqztanltejsqjom
   ```
   Deploy it after step 2: it calls RPCs that only exist once the SQL is applied.
4. **Verify.**
   - `select public.tix_event_capture_status('x');` returns `"schema": 20261016` and `"guard_enabled": true`.
   - Signed in on the live site, search a team: rows show "Checking live price..." and fill in within a few seconds; the status line reads "N live prices updated."
   - The next `tickets` run logs "Guarded schema available; using current collector." Run **team and artist prices** once by hand (Actions, Run workflow) and check its summary line.
   - Budget use: `select count(*) filter (where at>now()-interval '1 hour') as last_hour, count(*) as last_day from public.tix_provider_http where at>now()-interval '1 day';`
   - Health: `select k,v from public.tix_state where k in ('collector_health','performer_sweep');`

**Budget.** Foreground work (signed-in searches, opened events, alerts, targeted sweeps) may use the whole budget. Background coverage (sitemaps, discovery, team/artist pages, college basketball) stops at `background_share` (75%) of every window, so a search always has headroom. Change limits with `update public.tix_provider_guard set day_limit=..., hour_limit=..., minute_limit=... where id;` (caps: 10,000/day, 1,000/hour, 60/minute).

**Provider blocking.** A 403, 429 or challenge page pauses every check (search, collector, sweeps). Runs then fail with "Provider checks are paused", and the site says live checks are paused. Saved prices stay available. Resume only after reviewing why: `update public.tix_provider_guard set suspended_at=null,suspension_reason=null where id;`. Stop everything: `update public.tix_provider_guard set enabled=false where id;`.

**Storage.** Team/artist page prices add at most one history point per event per 20 hours, only for events within 30 days or opened by someone. Opened events add a point on each check. Enable expiry after a backup so past events stop accumulating: `update public.tix_provider_guard set expiry_enabled=true where id;`.

# Guarded price capture and history release (October 12)

This PR is staged for review. It does not apply SQL, deploy Edge, change production secrets, enable capture/cleanup, send test alerts, or merge itself. The original request requires a separate merge go-ahead. The scheduled workflow checks schema readiness and uses the pinned pre-PR collector only when PostgREST explicitly reports the new status RPC missing; this preserves existing collection if backend deployment is unavailable at merge. Once the RPC exists, every collector run uses the shared guards. Auth/network errors never trigger the fallback. The temporary feasibility probe remains disabled.

## What ships

- Authenticated fast public-page capture from Supabase Edge, with a recent saved-price cache. Search records history-only tracking for at most 12 displayed events and starts at most three fast checks per page load, sequentially. Anonymous visitors retain cached-price/history reads; they cannot start scraping.
- Every successfully parsed page is saved before a browser detail attempt. Every returned listing retains the raw provider fields, seats, available lots, nullable price/tax components, timestamp, provenance and coverage. Metadata-only, partial and genuinely empty inventory are distinct. No reconstruction of missing seat numbers or tax.
- Optional GitHub Actions detail dispatch, independent of notifications, shares collector concurrency. Without its optional secret, requested events wait for the existing 15-minute collector. A minute is a useful detail target after a runner starts, not a guaranteed finish time. A strict initial HTTP budget may prevent rendering all scripts/cards; successful metadata already saved remains available.
- Public event history compares one quantity and one price basis at a time. The API returns the latest 366 hourly samples; underlying observations and listings are retained until expiry. Provider was/now history and deal tier ranking stay disabled.
- A 365-day horizon, slower far-out tracking, and transactional event expiry. Date-only events expire after their full date has passed everywhere (UTC-12); this intentionally retains late local events longer rather than guessing a start/end time. Expiry removes catalog, observations/listings, tracking/jobs, event changes, associated prices, alert logs, scans and venue samples. Watch definitions, settings and notification opt-ins remain.

## Release order after merge approval

1. Confirm current main/CI, record active-watch count and collector health, and export a recoverable backup of **Ticketline tables only** before enabling deletion. Also count legacy price/alert/scan rows whose event IDs no longer exist in the catalog: prior catalog expiry left some history orphaned. New expiry cannot establish an event date for those rows; delete only after recovering reliable date evidence, without guessing. Preview the expiry set using the same date condition below. Keep unrelated prop-edge tables untouched.
2. Apply `scripts/20261012_guarded_history.sql` after the existing migrations, particularly `20261011_listing_fields.sql`. The migration is idempotent; fetching and expiry are disabled and catalog fetching is off. Deploy `supabase/functions/ticketline-prices/index.ts` with its shared module and `verify_jwt = true` from `supabase/config.toml`.
3. Let PR CI pass; merge only after the separate go-ahead. Wait for Pages and workflow availability. Confirm cached public prices work while fetching is disabled, authenticated requests return rollout-disabled, and anonymous requests cannot write tracking.
4. For a canary, set `enabled=true`, retain limits of **3/minute, 30/hour, 100/day**, `allow_catalog=false`, `expiry_enabled=false`, and set `canary_event_ids` to a small list of verified future catalog IDs. All instances share one lease and transactional admission for every HTTP attempt, including browser subresources. No implicit provider retries or redirects. Sitemap refresh and other events stay deferred during this canary. Set the canary list deliberately: an empty array permits all in-horizon events.
5. Independently verify the canary from hosted Edge/Actions: auth states, measured price response, atomic observation/listing storage, exact quantity, duplicate clients, blocking suspension, and saved-state reads. Include watched events in the canary and check that existing explicit notification opt-ins still function. No notifications are sent by the history-only worker. The global budget can defer existing watches; do not widen to general traffic until watch coverage is acceptable. Watches run before history discovery in each collector run.
6. Optionally configure `TIX_GITHUB_DISPATCH_TOKEN` on Edge as a repository-scoped **Actions-write** credential for Tickets only; never put it in the static site. Its absence uses scheduled collection and is visible as scheduled/queued. The workflow has no Gmail credentials. Check workflow-dispatch auth before promising immediate detail dispatch. This credential is not provisioned by this PR.
7. After a reviewed backup and expiry preview, enable `expiry_enabled=true`. Run one bounded batch and verify related history disappears while watches/settings and future events remain. Continue through the existing collector; cleanup is independent of sitemap success. Expiry should stay enabled even if provider fetching is suspended.
8. Expand the canary deliberately, then clear the list and enable catalog refresh only after evidence supports the available budgets. Low budgets are safety ceilings, not a guarantee of every 15-minute alert check. Tune capacity only after reviewing coverage and blocking evidence; never automatically resume a suspended provider.

```sql
-- Preview only, no deletion.
select event_date,count(*) from public.tix_catalog
where event_date < (now() at time zone 'Etc/GMT+12')::date
  and not exists(select 1 from public.tix_capture_leases l
    where l.event_id=tix_catalog.event_id and l.expires_at>now())
group by event_date order by event_date;

-- Operator-controlled stop; cached reads and saved history stay available.
update public.tix_provider_guard set enabled=false where id;
-- Separately stop irreversible expiry if backup/retention verification fails.
update public.tix_provider_guard set expiry_enabled=false where id;
```

Provider-budget records remain for two days, even if an event expires, so deletion cannot refund the daily limit. They contain operational IDs and no requester identities. An operator may resume after reviewing a blocking incident by clearing suspension and explicitly enabling capture; clients cannot do this.

## Validation and limits

Offline tests exercise Edge auth, no redirects/retries, hard admission denial, blocking suspension, history persistence and no notification calls; Python tests preserve watch ownership/edit checks and delivery opt-ins; DOM tests exercise real event rendering and quantity/basis selection. Real embedded fixtures cover both listing aliases. PGlite applies the entire migration chain, then the new migration twice, tests roles/limits/leases/exact lots/history/expiry and preserves settings. PGlite lacks the old `pg_trgm` extension, so only that pre-existing extension/index is omitted in the isolated engine test; the new migration is unmodified.

No new Gametime calls have been made from the user's machine or in implementation tests. The three previously authorized hosted probe requests establish feasibility only. Production migration, dispatch credentials, full deployed latency, sustained safety, visual browser review and live rollout remain to be verified after release authorization. Browser control timed out twice before inspecting the localhost preview; DOM checks do not claim visual verification.
