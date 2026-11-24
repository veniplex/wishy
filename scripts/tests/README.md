# Smoke tests (HTTP level, no browser)

Each test starts its own server (`server/index.js`) with a fresh, temporary `DATA_DIR` and cleans up afterwards.
The real `data/` directory is never touched. The port comes from `SMOKE_PORT` (each test has its own default).

| File | Covers |
| --- | --- |
| `smoke-core.mjs` | Setup, registration, wishlists, reservations, gifting, security headers |
| `smoke-auth.mjs` | Login, 2FA/TOTP, passkeys, Google (mock `mock-google.mjs`), rate limiting, security fixes |
| `smoke-platform.mjs` | Admin, AI (`AI_TEST_MOCK=1`), API keys, audit, backups, prompts |
| `occasion-types.mjs` | Per-space occasion types: seeding, fixed built-ins (hide/show only), custom types, hide/show + last-visible rule, delete/merge, reorder, isolation, v1 output, export/import, frontend icon map == server allow-list |
| `relationship-types.mjs` | Per-space relationship types (same logic as occasion types): seeding, fixed built-ins, custom types, `manage_persons` permission, in-use/merge/delete, reorder, person validation (key, hidden, free text of older clients, removed `relationship_group`), export/import incl. a 1.0.x backup, API v1, audit, and the schema 3 migration of free-text relationships (two spaces, idempotent, from schema 1 and 2) |
| `space-permissions.mjs` | Member permissions per space: me/state payload, defaults, every permission denied (403) and allowed, default permissions for new members, owner cannot be restricted, expenses redaction, API v1, audit |
| `person-planning.mjs` | Person-centred planning: occasion audience (all/selected) and effective participants, leaving persons out (carried to the next occurrence/birthday, surprise protection), `person_excluded`, `recipient_required`, idea -> gift inheritance, birthdays from persons (`birthday_from_person`, Feb 29), type default audience, export/import, merge, permissions, API v1 |
| `offline-sync.mjs` | Offline sync (server side): idempotent writes via `X-Op-Id` for every offline-capable route family, `X-Created-Id`, `space_gone`, op id isolation between users, surprise protection in repeated responses, retention of old ops, web app manifest, caching headers (service worker, hashed assets), CSP `worker-src`/`manifest-src`, 404 for missing build files; runs against its own fake `dist` |
| `offline-client.mjs` | Offline client (pure parts of `src/offline`, no server): queueable routes, temp id rewriting, overlay of queued changes, conflict decisions, order/dependencies of the queue |
| `person-photos.mjs` | Person photos: upload/replace/remove, type (magic bytes) and 2 MB limits, access (members only, `manage_persons`), file cleanup, export/import, backup coverage, migration of a schema-1 database, emoji validation |
| `emoji-search.mjs` | Emoji picker data and search (no server): well-formed data, language preference and fallback, diacritics |
| `detail-view.mjs` | Detail view of ideas, gifts and wishes (no server): link shown as anchor, only http/https, domain |

Run: `npm run test:smoke` (sequentially) or a single test, e.g. `SMOKE_PORT=3961 node scripts/tests/smoke-core.mjs`.
Non-zero exit code on failures. The update end-to-end test (`npm run test:e2e`) is separate because it runs for a long time.
