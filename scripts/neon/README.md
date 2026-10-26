# Free Neon recovery

The live replacement uses project `crimson-fire-70025251`, branch
`br-round-pine-b5ahrts5`, database `ticketline`, managed Neon Auth and the
`ticketline` function. The old Supabase project is preserved for later recovery.
No paid upgrade is required or configured.

The function receives its database connection through a private deployment
variable obtained from the same Neon project. The automatic injected URL was
missing its password, so it is overridden with the database owner connection
returned by Neon. Keep it inside Neon; never commit or print it. The remaining
variables are public service URLs and the allowed site origin. Never forward
the old Supabase service key.
GitHub jobs obtain short-lived OIDC tokens. The backend verifies their signature,
audience, repository, main ref and exact operational workflow. Browser requests
use managed user tokens and Data API RLS; they never acquire service access.

Build and check with `npm run build:neon`, `npm run test:neon`, `npm test`, and
`python -m unittest discover -s tests -v`. Deploy the bundled
`.neon-build/index.mjs` as `index.mjs` in a ZIP using the Neon function deploy
API. The generated browser bundle is `neon-auth-client.js`.

`bootstrap.mjs` applies the existing migration manifest to a NEW isolated Neon
branch using the compatibility transform, followed by `runtime.sql`. It requires
a direct Neon connection supplied through a private connection file or
`DATABASE_URL_UNPOOLED`. It refuses an existing uncheckpointed Ticketline schema.
Do not run the original Supabase release workflow against this replacement.
The transformed schema deliberately excludes legacy anonymous destination
writers, privileged admin RPCs and account removal. No admin is populated.

Background schedules share 15-minute boundaries. Quote workers stop when idle
and have a short run budget, allowing compute to suspend between batches.
The project has conservative free resource quotas. Availability probes skip
workers when the backend is unreachable, provider capture is paused, or storage
has less than the configured headroom; maintenance can still prune approved
redundant raw copies. This is bounded free service, not a promise of unlimited
capacity. Check Neon usage if traffic or alert volume grows; do not enable paid
resources to resolve capacity automatically.

New captures omit duplicate raw provider JSON while retaining mapped listings
and historical rollups. Only the existing owner-approved retention policy can
remove redundant individual listing copies. Alerts and rollups are not deleted
by that policy.

Users must sign in again. No private accounts, destinations, alerts or history
were copied from Supabase. Recovery of any Gmail-derived watch requires the
owner's explicit approval to transfer its email address and criteria. An
approved recovered watch is claimed only by its verified mailbox owner and
remains paused for review. Never place private recovery records in this public
repository.

Before enabling the live site, review the actual outcomes in the recovery
workflow summary: its diagnostic job can complete successfully while a smoke
step reports failure. Require both integration and collector outcomes to be
success. Public `/status` alone does not establish database or login health.
