# Smoke tests (HTTP level, no browser)

Each test starts its own server (`server/index.js`) with a fresh, temporary `DATA_DIR` and cleans up afterwards.
The real `data/` directory is never touched. The port comes from `SMOKE_PORT` (each test has its own default).

| File | Covers |
| --- | --- |
| `smoke-core.mjs` | Setup, registration, wishlists, reservations, gifting, security headers |
| `smoke-auth.mjs` | Login, 2FA/TOTP, passkeys, Google (mock `mock-google.mjs`), rate limiting, security fixes |
| `smoke-platform.mjs` | Admin, AI (`AI_TEST_MOCK=1`), API keys, audit, backups, prompts |
| `occasion-types.mjs` | Per-space occasion types: seeding, fixed built-ins (hide/show only), custom types, hide/show + last-visible rule, delete/merge, reorder, isolation, v1 output, export/import, frontend icon map == server allow-list |
| `space-permissions.mjs` | Member permissions per space: me/state payload, defaults, every permission denied (403) and allowed, default permissions for new members, owner cannot be restricted, expenses redaction, API v1, audit |
| `person-planning.mjs` | Person-centred planning: occasion audience (all/selected) and effective participants, leaving persons out (carried to the next occurrence/birthday, surprise protection), `person_excluded`, `recipient_required`, idea -> gift inheritance, birthdays from persons (`birthday_from_person`, Feb 29), type default audience, export/import, merge, permissions, API v1 |

Run: `npm run test:smoke` (sequentially) or a single test, e.g. `SMOKE_PORT=3961 node scripts/tests/smoke-core.mjs`.
Non-zero exit code on failures. The update end-to-end test (`npm run test:e2e`) is separate because it runs for a long time.
