# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning according to [SemVer](https://semver.org/).
The section of a version is used automatically as the release notes when releasing
(`scripts/release-notes.mjs`); the heading must read exactly `## [x.y.z]`.

## [1.1.0] – 2026-11-24

### Added
- AI is clearly marked: every button and dialog that uses AI carries an AI badge with a note on what is sent to the provider, and Settings has a new AI page listing the features, their status, the provider kind and the data sent.
- Link import can run with the app's built-in page parser or with AI, chosen per import (remembered locally); admins set the default in Admin > AI (`ai_link_mode`), the API field `use_ai` follows it for links.
- Persons can have a photo instead of an emoji (JPG, PNG or WebP, up to 2 MB), shown round wherever the person avatar appears; uploading or removing needs a connection, viewing works offline. Photos are part of backups. Existing databases get one additive column (schema version 2).
- Emoji picker with search (German and English names) and categories replaces the hand-typed emoji field; the person's emoji is now validated to be a single emoji.
- Ideas, planned gifts and wishes open a read-only detail view first (all fields, a clickable link with its domain, status and actions); "Edit" opens the form. It works offline like the forms.
- Ideas and gifts carry a type badge (Idea / Gift, with icon) wherever the person page mixes them.
- Relationship types are managed per space like occasion types (Settings > Space; needs the `manage_persons` permission): built-in defaults (parent, child, sibling, partner, grandparent, grandchild, aunt/uncle, cousin, in-law, friend, colleague, neighbour, acquaintance, other) that can be hidden and reordered, plus custom types that can be renamed, merged and deleted; changes are audited, offline reads use the cached state and the types are part of the space export.

### Changed
- AI prices are entered and stored in the configured cost currency instead of USD, so no exchange rate is needed for normal use. Existing prices are converted once on update (using the stored rate); changing the currency later asks for a one-time rate and converts costs, cost cap and prices. A fresh installation seeds the default Claude prices only for USD and starts with an empty price table for other currencies.
- Settings use the same section menu as the admin area (a list on the left, a scrollable bar on phones) instead of top tabs; both share one `SectionLayout` component. Top tabs remain only for views of the same content.
- Tighter layout on phones: smaller headings, page and card padding, rows, buttons and inputs (still at least 40 px tall), and a top bar that fits on one row at 360 px.
- Existing databases migrate once on update (schema version 3): each space gets the default types, and the free-text relationships of its persons become types (same text in any case becomes one type, text equal to a default name uses the default).
- The person form offers a select of the space's relationship types instead of free text, and the people list is grouped by relationship type (persons without one come last); API v1 `/persons` returns `relationship` (display name) and the new `relationship_type` (key). Older clients may still send a free-text `relationship`: it is matched to a type by name or creates a custom type.

### Removed
- The relationship group of persons (partner/family/friends/work/other) is gone from the person form, state, export and API v1 (`relationship_group`); the database column is left unused, and an incoming `relationship_group` is ignored.

## [1.0.1] – 2026-11-24

### Fixed
- AI costs are tracked in the configured currency: costs and the cost cap are recorded in it (prices stay in USD, converted with the exchange rate at the time of the request). Already recorded costs and the cap are converted once when updating, and whenever the currency changes. A currency other than USD needs an exchange rate.
- After a failed update, the shown command to find the recovery token matches the container log.

### Changed
- The AI usage CSV export contains `cost` and `currency` instead of `cost_usd`.
- `docker-compose.yml` keeps the data in a named volume (`wishy-data`) by default. Existing installations with `./data` keep their Compose file or use the commented line for a folder.
- License: GNU Affero General Public License v3 (`AGPL-3.0-only`); the license text is part of the release archive and the image.
- Extended security policy for reporting vulnerabilities.

## [1.0.0] – 2026-11-24

First public version.

### Wishes and gifts
- Your own wish lists (as many as you like), shareable by link (even without an account) and directly with app users.
- Reserving by others without the recipient seeing it; "Reserve & plan" creates a gift in the chosen space.
- Gift ideas, people, occasions (birthdays and more), gift status, shared gifts with cost shares, and budgets.
- Person-centred planning: the person page is the main planning place (one block per occasion, plus gifts and ideas without an occasion); occasions are grouped by person; occasions apply to everyone or to selected people, and single people can be left out; every gift needs a recipient; birthdays come from the person.
- Calendar with month grid and list, recurring occasions, and your own occasion types.
- Link import with preview (title, image, price from JSON-LD/OpenGraph/Microdata), using headless Chromium when needed.
- Optional AI assistance (Anthropic, OpenAI, Google) and quick capture from text.

### Offline
- Installable app (PWA): starts and shows your data without a connection; changes made offline are synchronised later, conflicting edits are shown for you to decide.

### Spaces and accounts
- Spaces for shared planning with invite links and permissions per member; export/import per space.
- Sign-in with email and password, 2FA (TOTP), passkeys (WebAuthn) and Google; registration open, invite-only or closed.
- Administration: user management, audit log, system statistics, API keys and REST API (`/api/v1`, OpenAPI).
- UI in English and German.

### Operations
- Docker image (amd64 + arm64) with launcher, maintenance page, recovery view and healthcheck.
- Backups as a single file (optionally AES-256-GCM encrypted) with schedule, retention and restore.
- Signed updates (Ed25519): in-container app update, image update via the Docker API, automatic rollback with a backup taken before the update.
- Weekly security watcher that opens an issue when the container image has fixable vulnerabilities or newer base components are available.

### Security
- Security headers, rate limiting, SSRF protection in the link import, sealed secrets (`secret.key`).
- Supply chain: actions and base image pinned by SHA, npm audit and Trivy scan in CI.
