# Ticketline

A lightweight Gametime ticket intelligence board with private alerts and price context.

Live: https://tylerherman19.github.io/Tickets/

## User flow

- Find real upcoming events by team, artist, category, date, or city/state.
- Create an alert for an event, team schedule, or day out.
- Choose 1–8 tickets, an exact all-in per-ticket maximum, any section or club seating, and email delivery to the sign-in inbox. Carrier email-to-text is an optional extra.
- Review the total budget before saving. Edit, pause, resume, or delete saved alerts.
- Get a confirmation email when an alert is saved; optional carrier text uses the same queue.
- View recent prices, channel-specific delivery attempts, and collector health.

Public event discovery remains available without an account. Alerts and their history require Supabase email sign-in and are scoped to the signed-in user. Full phone numbers are never returned to the browser after saving. The browser contains only the public Supabase anon key.

## Local preview and checks

No build step or npm dependencies are needed.

```sh
python3 -m http.server 8765
python3 -m unittest discover -s tests -v
node --check tickets.js
node --check app.js
node --test tests/test_frontend.cjs
```

`localhost` and `127.0.0.1` use a read-only snapshot of actual catalog events in `dev-fixtures.js`. Local preview makes **no** production Supabase calls and cannot save alerts. Update that snapshot as needed for UI work. Production is selected only on the hosted site.

## Data and notification service

`scripts/tickets_collect.py` runs in the `tickets` GitHub Actions workflow. Existing secrets:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`
- `GMAIL_ADDRESS`
- `GMAIL_APP_PASSWORD`
- `SMS_GATEWAY`

The `tix_save_alert` RPC saves the alert, its private destination, and the confirmation queue entry in one transaction. Only the owner may call it for an existing alert. The browser can read only configured/provider metadata, never the phone digits. Gmail SMTP sends to the verified Supabase sign-in email by default and, when selected, to the per-alert carrier gateway. The collector resolves the owner email through a service-role-only RPC; the browser cannot read other users’ addresses. `SMS_GATEWAY` is used only for manual carrier delivery tests; an email-only watch needs no phone destination. A successful SMTP result means accepted by the mail server, not proof of inbox or phone delivery. Email and carrier text have independent confirmation status and per-channel price-alert deduplication, so a dropped carrier text does not suppress the email.

The form supports T-Mobile/Metro, Verizon/Visible, Xfinity Mobile, and UScellular. [Xfinity Mobile lists `mypixmessages.com` for email-to-text](https://forums.xfinity.com/conversations/phone/answered-how-to-forward-an-email-to-a-text-message-on-xfinity-mobile-phones/602da6abc5375f08cdcd3ae8), and customers can [text `Status` to 4040](https://www.xfinity.com/support/articles/block-email-text-messages) to check whether it is enabled. [AT&T ended email-to-text on June 17, 2025](https://www.att.com/support/article/wireless/KM1061254/). [Verizon is shutting down Vtext and VZWPix by March 31, 2027](https://www.verizon.com/support/vtext-vzwpix-shutdown/) and warns that some senders can lose access earlier. A direct SMS provider would be needed for reliable carrier-independent delivery, but no paid provider is required for the current email-first setup.

The existing external `tickets-ping` repository dispatch is the primary scheduler, targeting every 15 minutes. A separate GitHub schedule at minutes 8, 23, 38, and 53 is a backup watchdog. GitHub scheduled starts were previously delayed, so this schedule is not relied on for normal price checks. The watchdog reads the last completed collector timestamp and runs a recovery scan only if it is over 25 minutes old. Both triggers share one workflow-level concurrency group with `cancel-in-progress: false`, so they cannot scan concurrently. There is no sleeping pacer job. If the external dispatcher ever needs to be replaced, configure another free service to send the same `tickets-ping` event every 15 minutes. The collector chooses due watched events on each run: 15 minutes in the week before the event or close to target, hourly up to 30 days away, and every three hours further out. Manual `workflow_dispatch` remains for operational tests. Its `test_sms: true` input sends one fixed test to the legacy fallback destination; its `watchdog: true` input tests freshness gating without forcing a duplicate check.

The collector checks the seller's `availableLots`, not just its seat count. It does not treat a requested quantity as available unless the seller explicitly offers that exact quantity. Thresholds are inclusive, preserve cents, and use the listing's total price. Repeat alerts have a one-hour interval per watch, event, and section; first-match alerts are sent once per event and section. Failed sends can retry. Paused/deleted/edited watches are rechecked before delivery.

## Database migration

The existing schema lives in `scripts/tickets_schema.sql`. On the configured project, apply `scripts/20260910_alert_reliability.sql` and `scripts/20260910_per_alert_destinations.sql` after the original setup. They add:

- A criteria-change timestamp to invalidate prices after edits to seats/events/sections.
- `tix_scans`, so failed or unavailable checks invalidate older listings.
- Restricted public reads of two non-sensitive health records in `tix_state`.
- `tix_events_v`, an RLS-respecting view that excludes season passes from single-event discovery.
- Private per-alert phone destinations and a one-time confirmation queue.
- Public RPCs that can save a destination or return non-sensitive configured/provider metadata without exposing the number.

The existing `tix_teams_v` and `tix_categories_v` are catalog views already provided by the deployed project. The UI uses `tix_teams_v` for league team selection.

Apply `scripts/20260927_ticket_intelligence.sql` after the two earlier migrations. It adds `owner_id` and `criteria_version` without deleting watches, prices, alerts, scans, or destinations. Existing rows have version 1. The criteria trigger increments the version when event, seat, quantity, threshold, or alert frequency changes. The collector writes that version to new observations and deduplicates sent alerts within the current version. Current charts use only that version; prior observations remain in the database. The migration removes anonymous access to private tables and the old destination RPC.

Apply `scripts/20260927_criteria_lifecycle.sql` afterward. It gives catalog prices their own `price_checked_at` timestamp, separate from the sitemap `last_seen` field, so a catalog refresh cannot make an old price look current. New collector scans populate it; older prices remain recorded but appear without a recent-price badge until refreshed. It also keeps an archive action from incrementing the watch's criteria version.

The event detail page shows the most recent real market sample, seller-confirmed exact quantity prices, section breakdown, event metadata changes, and calendar links. Dates are exported as all-day entries because the catalog's local start time has no timezone identifier. The budget form accepts either a per-ticket limit or a total budget and always displays both amounts before saving. Team alerts show the lowest and average recently checked get-in price across upcoming matching games, with the number of games sampled and a reminder that get-in does not prove the requested lot size. The PWA shell can be installed and browsed after a prior visit, but live ticket checks and alert editing require connectivity. Web push and direct SMS are not configured; verified inbox email is the default delivery method and carrier gateway text is optional.

Apply `scripts/20260928_public_discovery.sql` before deploying the matching collector. It adds a separate public discovery attempt/status to the catalog and a per-event market sample table. No prior prices or alerts are removed. `tix_discovery_due` is callable only by the service role. On every 15-minute run, the collector checks up to 20 events in the next week and 8 events 8–30 days away, spread across cities. Four additional samples each in Minneapolis and Milwaukee and two each in MLB, NFL, NBA, and NHL seed useful browsing categories while the wider city rotation builds coverage. It never interprets a parser failure as zero tickets. The public **See what’s cheap** search shows real get-in prices checked in the past 72 hours, sorted by all-in price; city/state, category, date, upcoming range, and maximum price remain available without sign-in. When a filter has no recently checked prices, it shows matching catalog events with a clear price-pending label. If an exact date has no listed events, it says so and offers to remove only the date filter. Coverage grows as the bounded discovery scan runs; it is not a claim that every marketplace event has been priced. Event detail and the alert builder now read exact-quantity samples by event ID instead of a venue-wide sample that could belong to another event.

Apply `scripts/20260928_provider_metadata.sql` after the discovery migration. Gametime sometimes serves event metadata and a get-in price without the listing payload. The collector retries once, then records `metadata_only` if the second response is also incomplete. That get-in price can appear in public discovery with a clear label; exact quantity remains unverified, and a watch receives `provider_incomplete` instead of a false no-inventory result or a notification.

Apply `scripts/20260928_discovery_interest.sql` before deploying the matching frontend and collector. It adds a bounded request queue for public browsing. Every public event search requests checks for at most three shown events whose prices are missing or older than 15 minutes. The RPC accepts only existing events within 30 days, rate-limits each event to one request per 15 minutes, and returns no private data. The collector checks up to eight requested events first on its next scheduled run. The queue does not trigger an extra workflow or incur a paid service fee. The price remains labeled unverified until a real provider check succeeds.

Apply `scripts/20260928_signed_in_catalog.sql` after the earlier migrations. The public catalog and venue section policies originally allowed only the `anon` role. Because the browser uses an `authenticated` token after sign-in, the same discovery query then returned zero rows. This additive migration lets signed-in users read the same public event and seating catalog; private watch and destination policies remain owner-restricted. It was applied to production on September 28.

**Production cutover:** Existing watches were assigned to their verified owner in a guarded transaction, and a follow-up query confirmed that none remain unclaimed. Supabase Auth Redirect URLs include `https://tylerherman19.github.io/Tickets/**`, and the Auth Site URL points to the Ticketline home page. A legacy watch without its own saved destination must be edited by its owner before it can deliver an alert.

When Gametime returns only event metadata and a get-in price, alert cards now show that get-in separately from the last verified exact-quantity price. The current exact match remains unverified, and a single historical observation is not drawn as a trend. A link opens the live Gametime event for a manual check. Provider responses have varied by environment, so the current GitHub collector cannot promise exact-lot monitoring on every run. Do not add proxy or hidden-API workarounds; [Gametime’s terms prohibit scraping and bypassing access restrictions](https://gametime.co/policies/terms-of-service/). Reliable automated exact-lot alerts require an authorized data arrangement.

Collector health distinguishes parser failures, HTTP failures, removed events, and valid scans without a matching lot. Per-watch scan detail records the number of listings and seller-offered lot sizes. The `tix_alert_intelligence_v` view aggregates the current configuration and the `tix_alert_history` RPC returns time buckets instead of thousands of raw prices. Health records have no recipient, sender address, credentials, or message body.

Apply `scripts/20260928_email_delivery.sql` after the earlier migrations. It adds email and SMS flags to watches, labels historical alert deliveries as SMS, tracks each channel separately on confirmations, and exposes a service-role-only owner-email lookup. Existing watches with saved phone destinations retain text delivery; email is enabled for all owned watches. The migration preserves previous watch, price, and alert rows. The save RPC remains transactional and now allows email-only alerts without a phone. Gmail SMTP uses the existing free GitHub Actions secrets. Deploy the collector and frontend together after this migration so email confirmations and optional text delivery use the new fields.

## Deployment

Push `main`; the existing GitHub Pages deployment publishes the root directory. Verify the Pages workflow and public pages after each deploy. `Ticketline checks` runs the collector and frontend regression tests on pushes and pull requests.
