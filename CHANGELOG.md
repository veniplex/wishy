# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning according to [SemVer](https://semver.org/).
The section of a version is used automatically as the release notes when releasing
(`scripts/release-notes.mjs`); the heading must read exactly `## [x.y.z]`.

## [Unreleased]

- License: GNU Affero General Public License v3 (`AGPL-3.0-only`); the license text is part of the release archive and the image.
- Extended security policy for reporting vulnerabilities.
- `docker-compose.yml` keeps the data in a named volume by default.
- Fixed: after a failed update, the shown command to find the recovery token now matches the container log.

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
