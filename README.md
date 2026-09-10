# Ticketline

A personal Gametime ticket-price alert board with a light, sporty interface.

Live: https://tylerherman19.github.io/Tickets/

## User flow

- Find real upcoming events by team, artist, category, date, or city/state.
- Create an alert for an event, team schedule, or day out.
- Choose 1–8 tickets, an exact all-in per-ticket maximum, and any section or club seating.
- Review the total budget before saving. Edit, pause, resume, or delete saved alerts.
- View recent prices, text-send results, and collector health.

This is a shared personal board, not a multi-user service. Its existing anonymous-access policy lets visitors see and manage watches. Phone numbers and mail credentials are never sent to the browser. The browser contains only the existing Supabase anonymous key. Use authenticated ownership policies before converting this into a public multi-user service.

## Local preview and checks

No build step or npm dependencies are needed.

```sh
python3 -m http.server 8765
python3 -m unittest discover -s tests -v
node --check tickets.js
node --check app.js
node --test tests/test_frontend.cjs
```

The local UI connects to the configured Supabase project. Use a clearly named disposable watch with a very low target for integration checks; remove it afterward.

## Data and notification service

`scripts/tickets_collect.py` runs in the `tickets` GitHub Actions workflow. Existing secrets:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`
- `GMAIL_ADDRESS`
- `GMAIL_APP_PASSWORD`
- `SMS_GATEWAY`

The text destination is preserved. Gmail SMTP forwards alerts to the configured carrier gateway. A successful SMTP result means accepted by the mail server, not proof of phone delivery. Carrier email-to-SMS support varies; verify receipt on the destination phone.

Run the workflow manually with `test_sms: true` to send one fixed test to that destination. No ticket purchase occurs. Normal runs target 15-minute checks within seven days of an event and hourly checks further out; GitHub and external scheduling can be delayed. The existing external trigger and pacer remain supported. Collector jobs are serialized to reduce duplicate notifications.

The collector checks the seller's `availableLots`, not just its seat count. It does not treat a requested quantity as available unless the seller explicitly offers that exact quantity. Thresholds are inclusive, preserve cents, and use the listing's total price. Repeat alerts have a one-hour interval per watch, event, and section; first-match alerts are sent once per event and section. Failed sends can retry. Paused/deleted/edited watches are rechecked before delivery.

## Database migration

The existing schema lives in `scripts/tickets_schema.sql`. On the configured project, apply `scripts/20260910_alert_reliability.sql` after the original setup. It adds:

- A criteria-change timestamp to invalidate prices after edits to seats/events/sections.
- `tix_scans`, so failed or unavailable checks invalidate older listings.
- Restricted public reads of two non-sensitive health records in `tix_state`.
- `tix_events_v`, an RLS-respecting view that excludes season passes from single-event discovery.

The existing `tix_teams_v` and `tix_categories_v` are catalog views already provided by the deployed project. The UI uses `tix_teams_v` for league team selection.

Public health contains only timestamps, status, aggregate check counts, and whether SMS configuration is present. It contains no recipient, sender address, credentials, or message body.

## Deployment

Push `main`; the existing GitHub Pages deployment publishes the root directory. Verify the Pages workflow and public pages after each deploy. `Ticketline checks` runs the collector and frontend regression tests on pushes and pull requests.
