# Ticketline

A lightweight Gametime ticket intelligence board with private alerts and price context.

Live: https://tylerherman19.github.io/Tickets/

## User flow

- Find real upcoming events by team, artist, category, date, or city/state.
- Create an alert for an event, team schedule, or day out.
- Choose 1–8 tickets, an exact all-in per-ticket maximum, any section or club seating, and the phone that should get the alert.
- Review the total budget before saving. Edit, pause, resume, or delete saved alerts.
- Get a one-time confirmation after a new phone destination is saved.
- View recent prices, text-send results, and collector health.

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

The `tix_save_alert` RPC saves the alert, its private destination, and the confirmation queue entry in one transaction. Only the owner may call it for an existing alert. The browser can read only configured/provider metadata, never the phone digits. Gmail SMTP sends to the per-alert carrier gateway. `SMS_GATEWAY` remains as a fallback for older watches and manual delivery tests. A successful SMTP result means accepted by the mail server, not proof of phone delivery.

The form supports T-Mobile/Metro, Verizon/Visible, Xfinity Mobile, and UScellular. [Xfinity Mobile lists `mypixmessages.com` for email-to-text](https://forums.xfinity.com/conversations/phone/answered-how-to-forward-an-email-to-a-text-message-on-xfinity-mobile-phones/602da6abc5375f08cdcd3ae8), and customers can [text `Status` to 4040](https://www.xfinity.com/support/articles/block-email-text-messages) to check whether it is enabled. [AT&T ended email-to-text on June 17, 2025](https://www.att.com/support/article/wireless/KM1061254/). [Verizon is shutting down Vtext and VZWPix by March 31, 2027](https://www.verizon.com/support/vtext-vzwpix-shutdown/) and warns that some senders can lose access earlier. A direct SMS provider will be needed for reliable carrier-independent delivery.

The sole automatic schedule is GitHub Actions cron every 15 minutes. The workflow has one collector job and workflow-level concurrency with `cancel-in-progress: false`. Remove/disable the old cron-job.org repository-dispatch pinger; its events are no longer accepted by this workflow. There is no sleeping pacer. The collector chooses due watched events on each run: 15 minutes in the week before the event or close to target, hourly up to 30 days away, and every three hours further out. GitHub cron can be delayed; it cannot guarantee sub-15-minute checks. Manual `workflow_dispatch` remains for operational tests. Its `test_sms: true` input sends one fixed test to the legacy fallback destination.

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

The event detail page shows the most recent real market sample, seller-confirmed exact quantity prices, section breakdown, event metadata changes, and calendar links. Dates are exported as all-day entries because the catalog's local start time has no timezone identifier. The budget form accepts either a per-ticket limit or a total budget and always displays both amounts before saving. The PWA shell can be installed and browsed after a prior visit, but live ticket checks and alert editing require connectivity. Web push and direct SMS are not configured; carrier gateway texts remain the active delivery method.

Apply `scripts/20260928_public_discovery.sql` before deploying the matching collector. It adds a separate public discovery attempt/status to the catalog and a per-event market sample table. No prior prices or alerts are removed. `tix_discovery_due` is callable only by the service role. On every 15-minute run, the collector checks up to 24 events in the next week and 8 events 8–30 days away, spread across cities. It never interprets a parser failure as zero tickets. The public **See what’s cheap** search shows only real get-in prices checked in the past 72 hours, sorted by all-in price; city/state, category, date, upcoming range, and maximum price remain available without sign-in. Coverage grows as the bounded discovery scan runs; it is not a claim that every marketplace event has been priced. Event detail and the alert builder now read exact-quantity samples by event ID instead of a venue-wide sample that could belong to another event.

**Production cutover:** The three pre-existing live watches initially have `owner_id = null`. The service collector continues checking them, but the browser cannot display or edit them until they are assigned. Have the existing owner sign in once, then use the SQL editor to inspect the new `auth.users` row and assign the legacy watches with `update public.tix_watches set owner_id = '<verified-owner-uuid>' where owner_id is null;`. Verify the owner and watch count before running this statement. Add `https://tylerherman19.github.io/Tickets/**` to Auth Redirect URLs and set the Auth Site URL to the Ticketline home page. Never run an assignment based on an unverified email or an arbitrary browser-provided ID.

Collector health distinguishes parser failures, HTTP failures, removed events, and valid scans without a matching lot. Per-watch scan detail records the number of listings and seller-offered lot sizes. The `tix_alert_intelligence_v` view aggregates the current configuration and the `tix_alert_history` RPC returns time buckets instead of thousands of raw prices. Health records have no recipient, sender address, credentials, or message body.

## Deployment

Push `main`; the existing GitHub Pages deployment publishes the root directory. Verify the Pages workflow and public pages after each deploy. `Ticketline checks` runs the collector and frontend regression tests on pushes and pull requests.
