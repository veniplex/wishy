# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning according to [SemVer](https://semver.org/).
The section of a version is used automatically as the release notes when releasing
(`scripts/release-notes.mjs`); the heading must read exactly `## [x.y.z]`.

## [1.2.0] – 2026-11-24

### Added
- Admin > Reservations: who claimed which wish (signed-in people and guests with a Guest badge), when, on which list and for whom, from which IP and device, with filters (list owner, user or guest, text, IP, active or released), pagination, CSV export and audited admin actions to delete a reservation (single or several at once) or a whole guest, a Guests view (name, guest ID, list, active reservations, first/last seen, IP, device) and the guest ID in filters, search and CSV; ended reservations form the history from the audit log.
- Every wish reservation and release is written to the audit log at every level, with list, owner, name and IP; admins who own the list do not see claims on their own lists in the reservations view or the audit log (hidden server-side in rows, search, filters, counts and exports) unless they deliberately reveal them, which is logged.
- IP addresses are visible and filterable in the audit log (also on phones, click an IP to filter, new IP filter), and Admin > Users shows each person's last activity, last IP and active sessions with device and a sign-out button; both pages warn when X-Forwarded-For is ignored because the proxy is not trusted.
- New retention setting "IP addresses and devices (days)" (default 90, 0 = as long as the entry) anonymises IP and user agent in the audit log and on reservations; documented for the operator's privacy notice in the README and docs/operations.md.
- Guests claim gifts safely: every browser is a guest of the list with a random key that only it (and its personal link) holds, stored hashed and created only when the guest reserves or saves the link, so nobody can release a reservation by typing the same name; reservations made before keep working by name.
- Guests get a personal link (`/w/<token>#g=<key>`, the key stays in the URL fragment and never reaches the server or any log) to manage their reservations later and on other devices: copy/share it, see and release your own reservations, rename yourself, merge two browsers, forget the key on a device, and move the reservations into an account after signing in; every guest has a short guest ID (G-7F3KQ2) shown to administrators and in the audit log.
- New guest reservation dialog with a privacy note (the name is visible to other visitors but not to the owner, administrators see name and IP address), success and conflict messages, "reserved by you" with release, and an optional sign-in link; it works on phones.
- Share dialog setting "Guests without an account may reserve" per list (default on, enforced by the server); with it off, guests see the list and are asked to sign in.
- Guest reservations and releases are limited to 30 per IP and minute and 100 guest reservations per list; names are checked for length and control characters. Existing databases get additive columns and a guests table (schema version 4), and the IP retention setting also clears the IP and device of guests.
- Passkeys now sign you in without a password (discoverable credentials with user verification, button and browser autofill on the sign-in page); a passkey replaces password and second factor, the challenge is single-use and bound to the browser, every failure answers identically and is rate limited and audited with method passkey.
- New passkeys must be discoverable and protected by user verification; older security keys can still be added as "second factor only", existing passkeys keep working (additive column, schema version 5), and passkeys can also confirm sensitive actions.

### Changed
- The audit level now defaults to "Everything" when an admin has never chosen one, so user activities are logged with their IP out of the box (an explicitly stored choice, including "Security", is kept; reservations are logged at every level).
- Anonymous successful actions such as guest claims are now capped in the audit log per IP, action and minute (30 entries), like failed ones already were; sorting of occasion and relationship types, re-authentication and passkey renames get their own action names, and link previews are logged as such.
- Dependencies updated to their newest versions (npm packages, Docker socket proxy example 1.14.0); GitHub Actions were already current.
- The Docker image and CI run on Node.js 26 (LTS); the app and `engines` still support Node.js 24, and CI tests both.
- Guests and signed-in people reserve through `/api/shared/:token/wishes/:id/reserve` (the guest name is no longer sent in the URL); the old `/api/wishes/:id/reserve` routes keep working for clients that are still cached.
- Mobile: one-line header on phones (offline status as an icon, theme switch in the account menu), page titles and breadcrumbs shortened, all controls at least 44 px on touch devices, tabs and segmented controls scroll instead of wrapping, list rows give the title the full width on narrow screens, and nothing widens the page at 320 px.
- Mobile: dialogs are bottom sheets with the height of their content, respect safe areas and the on-screen keyboard, and close with the Back button (also menus and pickers); admin and settings show a section list first on phones; short landscape phones keep the phone layout.
- Faster first load: static files are served precompressed (brotli/gzip) and the admin, settings, finance, calendar detail and person planning screens load on demand; a failed chunk load after an update reloads once.
- Prices show two decimals whenever the amount is not whole, date fields format typed digits and accept short dates, search fields no longer open the keyboard on touch, and chart labels are unique and readable.
- Mobile people, gifts and calendar: the person page header is compact (notes clamped with "more"), blocks offer one "Add" menu instead of two stacked buttons, ideas are rows, the gift filters live in one "Filter" sheet with an active count, the calendar month selects the first day with an entry and has a colour legend, the expenses period table fits narrow screens, forms start with the title (link and AI note after it) and the gift status stepper no longer breaks words.
- Mobile settings and admin: the space page puts members and permissions before the long type lists (collapsed on phones, "Change order" mode instead of arrows per row), user and backup rows use a labelled actions sheet, the audit log and reservations show search first with filters on demand, the API documentation and AI usage details are collapsed, sessions show only this device first, long admin forms get a floating save bar when changed, and fields have fitting keyboard hints.
- Wish lists and the guest page (phones and desktop): tapping a wish opens a read-only detail with the full notes, image, link and the reserve button, rows show one action (own lists: "Received", reordering in a "Reorder" mode, deleting in the detail), the guest intro is one short line, your own reservations are summarised, list cards are compact rows on phones, and the language switch and link icons have touch-sized targets.

### Fixed
- The public list page works behind a reverse proxy with its own sign-in (Pangolin, …) when only the documented paths are open: it no longer shows "Server unreachable" when `/api/auth/me` is answered by the proxy, guests can reserve and release (everything runs under `/api/shared/*`), no "offline" notice or service worker is involved for guests, and the sign-in link is a real page load. Proxy setups that already allow the documented paths need no change.
- A guest's reservations stay recognised as theirs when the owner generates a new link (the key is kept per list, not per link; the old personal links stop working with the old link), and deleting a user writes the implicit release entries (reason `user_deleted`) for the claims they held and the claims on their lists.

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
