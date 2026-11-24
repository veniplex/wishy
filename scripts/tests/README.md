# Smoke tests (HTTP level, no browser)

Each test starts its own server (`server/index.js`) with a fresh, temporary `DATA_DIR` and cleans up afterwards.
The real `data/` directory is never touched. The port comes from `SMOKE_PORT` (each test has its own default).

| File | Covers |
| --- | --- |
| `smoke-core.mjs` | Setup, registration, wishlists, reservations, gifting, security headers |
| `smoke-auth.mjs` | Login, 2FA/TOTP, passkeys, Google (mock `mock-google.mjs`), rate limiting, security fixes |
| `passkey-browser.mjs` | Passwordless passkey sign-in in Chrome (CDP virtual authenticator, desktop + phone, de/en, autofill); needs Chrome, not part of `test:smoke`. `webauthn-soft.mjs` is the software authenticator used by `smoke-auth.mjs` |
| `smoke-platform.mjs` | Admin, AI (`AI_TEST_MOCK=1`), API keys, audit, backups, prompts |
| `occasion-types.mjs` | Per-space occasion types: seeding, fixed built-ins (hide/show only), custom types, hide/show + last-visible rule, delete/merge, reorder, isolation, v1 output, export/import, frontend icon map == server allow-list |
| `relationship-types.mjs` | Per-space relationship types (same logic as occasion types): seeding, fixed built-ins, custom types, `manage_persons` permission, in-use/merge/delete, reorder, person validation (key, hidden, free text of older clients, removed `relationship_group`), export/import incl. a 1.0.x backup, API v1, audit, and the schema 3 migration of free-text relationships (two spaces, idempotent, from schema 1 and 2) |
| `space-permissions.mjs` | Member permissions per space: me/state payload, defaults, every permission denied (403) and allowed, default permissions for new members, owner cannot be restricted, expenses redaction, API v1, audit |
| `person-planning.mjs` | Person-centred planning: occasion audience (all/selected) and effective participants, leaving persons out (carried to the next occurrence/birthday, surprise protection), `person_excluded`, `recipient_required`, idea -> gift inheritance, birthdays from persons (`birthday_from_person`, Feb 29), type default audience, export/import, merge, permissions, API v1 |
| `offline-sync.mjs` | Offline sync (server side): idempotent writes via `X-Op-Id` for every offline-capable route family, `X-Created-Id`, `space_gone`, op id isolation between users, surprise protection in repeated responses, retention of old ops, web app manifest, caching headers (service worker, hashed assets), CSP `worker-src`/`manifest-src`, 404 for missing build files; runs against its own fake `dist` |
| `offline-client.mjs` | Offline client (pure parts of `src/offline`, no server): queueable routes, temp id rewriting, overlay of queued changes, conflict decisions, order/dependencies of the queue |
| `person-photos.mjs` | Person photos: upload/replace/remove, type (magic bytes) and 2 MB limits, access (members only, `manage_persons`), file cleanup, export/import, backup coverage, migration of a schema-1 database, emoji validation |
| `claims-admin.mjs` | Admin > Reservations and IP logging: claims list/filters/pagination/CSV export/release, surprise protection for an admin who owns the list (claims list, audit list/search/filters/counts/export, reveal is explicit and audited), 403 for non-admins, default audit level "all", IP and user agent on a sample of activities of every module, offline replay without double entries, IP anonymisation, CSV formula injection, flood protection for anonymous successful actions, per-user sessions |
| `emoji-search.mjs` | Emoji picker data and search (no server): well-formed data, language preference and fallback, diacritics |
| `detail-view.mjs` | Detail view of ideas, gifts and wishes (no server): link shown as anchor, only http/https, domain |
| `guest-claims.mjs` | Guests on shared lists: identity created on demand only (key hashed, never stored or logged), claims per guest, two browsers with one key, wrong key/name cannot release, rename, merge, regenerate, takeover into an account, owner never learns anything (also with a guest key), legacy name claims, per-list setting, rate limit and caps, CSRF, audit entries with guest code, key in no URL/audit/export, IP/user agent kept off every non-admin answer, the public page behind a fake sign-in proxy that passes only `BYPASS_PATHS` (4 answer modes, incl. the new endpoints), migration from schema 3 and from a 1.2.0 development database incl. second start |

Run: `npm run test:smoke` (sequentially) or a single test, e.g. `SMOKE_PORT=3961 node scripts/tests/smoke-core.mjs`.
Non-zero exit code on failures. The update end-to-end test (`npm run test:e2e`) is separate because it runs for a long time.
