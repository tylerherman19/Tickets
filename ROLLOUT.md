# Guarded price capture and history release

This PR is staged for review. It does not apply SQL, deploy Edge, change production secrets, enable capture/cleanup, send test alerts, or merge itself. The original request requires a separate merge go-ahead. The temporary feasibility probe remains disabled.

## What ships

- Authenticated fast public-page capture from Supabase Edge, with a recent saved-price cache. Search records history-only tracking for at most 12 displayed events and starts at most three fast checks per page load, sequentially. Anonymous visitors retain cached-price/history reads; they cannot start scraping.
- Every successfully parsed page is saved before a browser detail attempt. Every returned listing retains the raw provider fields, seats, available lots, nullable price/tax components, timestamp, provenance and coverage. Metadata-only, partial and genuinely empty inventory are distinct. No reconstruction of missing seat numbers or tax.
- Optional GitHub Actions detail dispatch, independent of notifications, shares collector concurrency. Without its optional secret, requested events wait for the existing 15-minute collector. A minute is a useful detail target after a runner starts, not a guaranteed finish time. A strict initial HTTP budget may prevent rendering all scripts/cards; successful metadata already saved remains available.
- Public event history compares one quantity and one price basis at a time. The API returns the latest 366 hourly samples; underlying observations and listings are retained until expiry. Provider was/now history and deal tier ranking stay disabled.
- A 365-day horizon, slower far-out tracking, and transactional event expiry. Date-only events expire after their full date has passed everywhere (UTC-12); this intentionally retains late local events longer rather than guessing a start/end time. Expiry removes catalog, observations/listings, tracking/jobs, event changes, associated prices, alert logs, scans and venue samples. Watch definitions, settings and notification opt-ins remain.

## Release order after merge approval

1. Confirm current main/CI, record active-watch count and collector health, and export a recoverable backup of **Ticketline tables only** before enabling deletion. Preview the expiry set using the same date condition below. Keep unrelated prop-edge tables untouched.
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
