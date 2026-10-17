# Ticketline sign-in emails

These two templates match the operational confirmation and matching-price emails. They keep Supabase's `{{ .ConfirmationURL }}` verification URL intact, so the existing passwordless callback and redirect continue to work. There are no tracking pixels, external fonts, images, credentials, or hardcoded expiry claims.

The `supabase/config.toml` entries configure local CLI development only. For the hosted Ticketline project (`aahqagqztanltejsqjom`), open **Authentication > Emails > Templates** and apply:

| Template | Subject | Body |
| --- | --- | --- |
| Magic Link | Your Ticketline sign-in link | `magic-link.html` |
| Confirm signup | Welcome to Ticketline — confirm your email | `confirmation.html` |

Copy the complete HTML into the matching body field, preview, and save. Do not replace the verification URL, alter allowed redirects, change sender credentials, or disable any authentication protections. Configuring production templates requires access to this project; committing the files does not publish hosted Auth settings.

Verify one new-account confirmation and one returning-account magic link using an authorized test inbox. Confirm each link reaches Ticketline, establishes the session, and returns to the requested page. An offline HTML preview does not prove inbox delivery or a working live login.

Supabase reference: https://supabase.com/docs/guides/auth/auth-email-templates
