# Ticketline administration

Apply `20261017_admin.sql` after `20261017_coverage_query.sql`. This creates an empty administrator allowlist: deployment does not automatically authorize anyone. Keep ordinary owner RLS unchanged.

The project owner provisions a **confirmed** auth user by UUID in `public.tix_admins` using trusted database administration. Never ship a service key, email-based client check, or browser role editor. Removing the membership revokes the next API request. Deleting an account cascades its membership.

`admin.html` checks signed-in membership, and each admin RPC independently checks membership and email verification. The directory covers Ticketline business records, contact destinations, audited alert edits and safe auth profile fields. It deliberately excludes password hashes, refresh/access tokens, authentication metadata, unrelated project tables and arbitrary SQL. Admin edits are recorded in both the existing watch audit and admin audit. No user impersonation or permanent deletion UI is included.

Usage semantics:

- Account totals use auth users in this Supabase project. Sign-in counts are users whose **last sign-in** is in the range, not sessions, pageviews or daily active users.
- Active alerts exclude archived and purchased alerts. Notification counts count retained send records, not unique recipients or confirmed inbox deliveries.
- Daily alert creations/changes use retained watch audit events; system changes can also produce changes. Dates use UTC.
- Latest scans are latest watch/event states, not a historical count of all sweeps. Provider request logs have short existing retention. The dashboard cannot reconstruct deleted/expired data.
- Exports page through every matching row with a creation-time cutoff. Concurrent updates/deletions can change a long export: it is not a transaction snapshot. Downloads contain private data and must be stored securely.

Local `localhost`/`127.0.0.1` preview shows clearly labeled synthetic admin records and refuses writes; production always requires server authorization. `npm test` includes default-deny SQL tests, non-admin isolation, safe profile projection, pagination, SQL injection cases, auditing, revocation, validation and DOM escaping.
