# Quick quotes, delivery and recovery

Quick quotes are public. Saving an alert still requires sign-in. `tix_public_quotes` reads fresh saved quotes for the selected seat count. The page preloads saved quotes for the first 12 visible games; selecting a game can therefore render immediately. A missing quote calls `ticketline-prices`, which fetches the public event page in Supabase and queues the exact requested quantities. `warm ticket quotes` consumes the queue while a GitHub runner is available. This avoids launching a new runner for each event. GitHub schedules can be late; cold rendered checks are not guaranteed instant.

The quote worker has no email credentials. It keeps recently viewed events warm for a day. Alert checks run separately every 15 minutes. Catalog/discovery work continues in its own job and gets less of the unchanged 40/minute, 420/hour and 5,000/day provider allowance. Every process uses the same database admission and suspension controls. No worker bypasses a provider block.

`20261020_runtime_reliability.sql` saves prices, metadata, evidence and queue completion atomically. Each seat count has its own timestamp. An absent amount preserves the known amount and its age; explicit empty inventory is different from missing data.

`20261020_delivery_health.sql` records send intent before SMTP. A worker must own a delivery lease. Acceptance and the notification log commit together. An expired send lease is uncertain and cannot resend automatically. Safe failures retry on a later qualifying check, at most five outbox attempts (confirmation queue also retains its three-attempt limit). Edits, pauses, channel changes and completed purchases are checked before a claim. Repeat messages require 60 minutes since acceptance. Gmail acceptance does not establish inbox receipt or provide bounce/delivery webhooks.

`last_success_at` is independent from the latest attempt. The collector records every alert/event pair it resolves. Admin health counts pairs without a successful check in 30 minutes, sends needing review, queue wait, worker heartbeat and backup state. An overdue pair can trigger watchdog recovery even when the last run's heartbeat was recent. Alerts with no upcoming matches are reported separately.

## Daily backups

Automatic backup runs remain disabled until the owner approves the encrypted export and the repository variable `TIX_ENCRYPTED_BACKUP_ENABLED` is set to `true`. The hosted backup takes one database snapshot of critical Ticketline private state and owner references. It includes alerts, settings, delivery history, admin allowlist and search records within their existing retention. It excludes authentication sessions, passwords, unrelated apps, and rebuildable public ticket inventory. Owner references preserve account IDs and confirmed email references; this is not a full Supabase Auth disaster-recovery image.

The snapshot is compressed in memory, encrypted with AES-256-GCM, and its random key is encrypted with RSA-OAEP/SHA-256. Only encrypted `.json.enc` files are uploaded to GitHub artifacts, retained for 30 days. Backup health says `stored` only after upload succeeds. A private recovery key was placed in the owner's local task outputs/recovery folder with owner-only permissions. Copy that file to a separate secure location. Losing it makes these archives unreadable. Never put it in the repository or an Actions secret.

Download an encrypted artifact. Run:

```
npm ci --ignore-scripts --no-audit --no-fund
node scripts/tickets_restore_check.mjs /path/to/archive.json.enc /path/to/ticketline-backup-private.pem
```

This decrypts only in memory and restores into an isolated in-memory PostgreSQL database, with no production connection. It verifies table counts, constraints and alert ownership. Its output contains counts, not private records. A real hosted Supabase Auth restore needs a separate account recovery plan and must not be claimed from this drill.

## Backend releases

The `release Ticketline backend` Actions workflow runs checks, applies only missing reviewed reliability migrations, deploys the bundled function with JWT verification enabled, and verifies the database schema. It needs an owner-supplied `SUPABASE_ACCESS_TOKEN` Actions secret. Without it, backend deployment stays manual; the existing frontend workflow does not pretend that SQL and Edge code were deployed. Workers fail closed on a missing/older schema.

Management endpoints are documented by [Supabase's function deployment guide](https://supabase.com/changelog/33720-deploy-and-update-edge-functions-using-the-management-api) and [query reference](https://supabase.com/docs/reference/api/v1-run-a-query).

## Handling an uncertain send

Review the Gmail sent folder or provider evidence before retrying. Do not clear a sending/uncertain row merely to get a green dashboard. If it was accepted, acknowledge that same outbox ID and lease through the service-only completion function; its alert insert is idempotent. A resend requires a deliberate reviewed operation after establishing that no copy was accepted. This is intentionally separate from automatic delivery.

## Approved listing retention

The owner approved preserving price history and permanently removing individual listing copies older than 24 hours. The `20261020_storage_policy.sql` migration first builds price-history summaries for each event sample, quantity, fee/tax basis and section. Future captures save these summaries in the same transaction. Price-history charts read the summaries. Cleanup touches only `tix_listing_observations`; it never deletes watch prices, alerts, destinations, users, or event observations.

The database flag `tix_storage_policy.listing_retention_enabled` and repository variable `TIX_LISTING_RETENTION_ENABLED` must both be enabled after owner approval. Maintenance runs every six hours. A one-time `VACUUM FULL public.tix_listing_observations` returns the initially reclaimed space to the database disk; this can briefly block listing-detail access. Routine retention reuses freed pages and does not compact the whole table each time.

For interactive speed, the quote worker checks its queue every second and takes one job at a time so a newly selected game can take priority between captures. Fresh advertised metadata is reused; the browser verifies seat prices without repeating that metadata fetch.
