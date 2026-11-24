# Running Wishy: Docker, updates, backups

This guide describes running Wishy in the Docker image (recommended) and what works without the image
(e.g. `npm start` on Windows).

## 1. Layout

```
Container "wishy"
└─ tini → launcher  /app/launcher/index.js   public port 3000
          ├─ reverse proxy → app (child process) 127.0.0.1:3001
          ├─ supervision: restart with backoff, crash loop → fallback, schema guard
          ├─ maintenance page, /__launcher/status, recovery view /__launcher/recovery
          └─ updates: app update (archive) or image update (Docker API, via helper container)
Volume /data
├─ wishlist.db (+ -wal/-shm)   database
├─ images/  avatars/          images
├─ secret.key                 server key (seals 2FA secrets, passphrases, tokens)
├─ backups/                   backups (*.wbk, *.wbk.enc) + *.meta.json
├─ app/releases/<v>/ + <v>.tar.gz(.sig)   versions installed by app update + signed archive
├─ app/current.json           activated app version
├─ launcher/                  job journal, last result, per-container state, rollback keys
├─ update.log                 log of all update/restore steps
└─ maintenance.json           maintenance marker (only during restore/update)
```

- **Baseline:** The image contains the app under `/app` (owned by root, read-only) together with `components.json`
  (Node, Alpine, Chromium and launcher versions, package list).
- **Which app version runs?** The newest valid one out of {release activated by app update, baseline}. If the
  baseline is newer or equal (new image), it wins. A release installed by app update is checked against its signed
  archive on every start (signature + every file + no foreign files) – tampered releases are not started.
- **Control channel app ↔ launcher:** HTTP on `127.0.0.1` only (random port) with a token from a 0600 file that the
  app reads and deletes at startup. The proxy answers `/__internal*`/`/__launcher*` (except status and the recovery
  view) with 404; requests that do not start with `/` get 400.
- **Schema guard:** If an app version finds a database from a newer schema, it does not start (exit 78). The launcher
  then does not try to restart it but shows the state in the recovery view.

## 2. Docker

```bash
docker compose up -d
```

The data lives in the named volume `wishy-data` (mounted at `/data`). `docker compose down -v` deletes it. To use a folder instead,
create it for the container user `node` (`mkdir data && sudo chown 1000:1000 data`) and mount `./data:/data`.
Files can be copied out with `docker compose cp wishy:/data/backups ./`.

`docker-compose.yml` uses `ghcr.io/veniplex/wishy:latest` (variable `WISHY_IMAGE`) and already sets
`cap_drop: [ALL]` and `no-new-privileges`. `read_only: true` + `tmpfs: [/tmp]` is prepared but untested with
Chromium (link preview).

| Variable | Meaning |
| --- | --- |
| `TZ` | time zone, e.g. `Europe/Berlin` (backup schedule) |
| `BASE_URL` | public address, e.g. `https://wishy.example.com` |
| `TRUST_PROXY` | reverse proxy IN FRONT of the container: number of hops (`1`), `true` or subnets. Alternatively in Admin › General |
| `UPDATE_REPO` / `UPDATE_TOKEN` | GitHub repository `owner/name` (default `veniplex/wishy`) / optional token (rate limit) |
| `BACKUP_PASSPHRASE` | overrides the stored backup passphrase |
| `UPDATE_PUBLIC_KEY` | replaces the built-in public update key (PEM or Base64 SPKI) |
| `DOCKER_HOST` | Docker API for image updates: `tcp://docker-proxy:2375` or `unix:///var/run/docker.sock` |
| `WISHY_IMAGE_UPDATES` | `off` = disable image updates even if the Docker API is reachable |
| `UPDATE_ALLOWED_HOSTS` | additional download hosts (default: github.com, objects/release-assets.githubusercontent.com) |
| `WISHY_HEALTH_TIMEOUT_MS` | deadline for a new version to become healthy (default 90000) |
| `WISHY_MAX_ARTIFACT_MB` | maximum size of an app update archive (default 512) |

All variables with their defaults: [docker-compose.yml](../docker-compose.yml).

**Reverse proxy and client IP:** The launcher is a proxy hop itself. It appends the peer address to
`X-Forwarded-For`, passes through `X-Forwarded-Proto/-Host` of an outer proxy, and additionally tells the app what it
saw itself. For the proxy setting (environment **or** UI), the app adds exactly this one hop. If no outer proxy is
configured, it discards client headers and only uses the launcher's values – a forged `X-Forwarded-For` has no effect.

**Healthcheck:** healthy when the app responds or an update/restore is currently running.
**Stopping:** `docker compose stop` → SIGTERM → the launcher shuts the app down cleanly (the DB is closed).

## 3. Updates

Admin › Updates shows the running and the latest version, release notes and – from the signed release metadata –
what changes (app, Node, system packages, Chromium, launcher). There are two ways:

| Mode | Requirement | What is updated |
| --- | --- | --- |
| **Image update** (`mode: image`) | Docker API reachable (see 3.2) | everything: app, npm packages, Node, Alpine packages, Chromium, launcher |
| **App update** (`mode: app`) | launcher only (standard image) | app code + npm packages only – "app only, base not updated" |
| none (`mode: none`) | without launcher (`npm start`) | check + instructions |

Versions are plain semver; base image / Node updates ship as normal (patch) releases. A release is offered when its
version is newer than the running one. A release that needs a newer launcher or Node major (or has no app archive) is
only installable by image update; without Docker access Wishy shows `image_update_required` with the instructions
`docker compose pull && docker compose up -d`.

### 3.1 Flow and security (both modes)

1. **Pre-check** – update key present, version newer, free space (≥ 2 × database + images + archive), signed metadata
   valid, launcher/Node compatible (otherwise `image_update_required`).
2. **Download/pull** – app mode: archive + `.sha256` + `.sig` (https only, to allowed hosts, every redirect is
   re-checked, size limits while streaming). Image mode: image **by digest only** from the signed metadata
   (`ghcr.io/veniplex/wishy@sha256:…`), followed by a `RepoDigests` comparison. The app keeps running meanwhile.
3. **Verification** – SHA-256 **and** Ed25519 signature against the key built into the image before anything is
   unpacked/started; the hash is computed again while unpacking (no swap between verifying and unpacking). Regular
   files only, no symlinks/absolute paths/`..`.
4. **Maintenance on**, stop the app, **backup** `pre-update` with the app stopped; all sessions except that of the
   acting admin are ended. If encryption is active, this backup is encrypted too (the passphrase is additionally stored
   sealed under `launcher/keys/` so a rollback does not depend on the database).
5. **Switch** – app mode: start the new version in the same container. Image mode: see 3.2.
6. **Health check** – `/healthz` (expected version) + `/readyz` within the deadline, then stable.
7. **Activate** – maintenance off; open pages reload (`/api/maintenance` reports the new version).

**Automatic rollback:** If 5/6 fails, the new version is removed, **only the database** is restored from the
`pre-update` backup (fast, no double space for images) and the old version is started. If the backup cannot be
restored, the old version is **not** started on the migrated database: state `rollback_failed`, recovery view.
An interrupted rollback (crash/restart of the launcher) is resumed at the next start. Error codes: `signature_invalid`,
`sha256_mismatch`, `digest_mismatch`, `pull_failed`, `release_invalid`, `start_failed`, `health_timeout`,
`version_mismatch`, `schema_newer`, `image_update_required`, `insufficient_disk`, `download_failed`,
`docker_unavailable`, `no_update_key`, `crash_loop`, `rollback_failed`, `launcher_interrupted`.

**Crash loop:** If a version activated by app update crashes 5 times within 2 minutes, the launcher falls back to the
previous version. If the version was not yet proven (< 10 min stable), the `pre-update` backup is restored in the
process; otherwise it is not (no silent data loss) – if the old version then refuses to start (schema guard), the
recovery view helps.

**Recovery view:** `https://<wishy>/__launcher/recovery` – protected by a token that the launcher writes to the
container log at every start (`docker compose logs wishy | grep -i "recovery token"`). Shows the state, last result and
log; actions: restart, start previous version, restore the latest `pre-update` backup. 10 failed attempts lock it for 10 minutes.

### 3.2 Image updates (whole container)

Flow in addition to 3.1: The launcher pulls the new image by digest, stops the app, takes a backup, and then starts a
**helper container from the NEW image** (`node /app/launcher/index.js --self-replace <job>`, same volumes/networks/user).
The helper – a separate container so it survives the stopping of the old one –

1. stops the old container and renames it to `<name>-old-<job>`,
2. creates the new container with the **same configuration** (name, environment, volumes/mounts, networks incl.
   aliases, labels incl. Compose labels, ports, restart policy, healthcheck overrides, user, capabilities, security
   options) – only the image is new; values that merely were defaults of the old image (e.g. `NODE_VERSION`) are not carried over,
3. starts it and waits until the app is healthy there,
4. on success removes the old container (and its image, if unused),
5. on failure removes the new container, gives the old one its name back and starts it; the old launcher restores the
   `pre-update` backup (DB only) at startup.

Instead of `AutoRemove` the helper has the restart policy `on-failure`: if it crashes in the middle of the swap,
Docker restarts it and it resumes from the journal (`/data/launcher/job.json`); at the end it deletes itself.

**Expected connection drop:** Between stopping the old and starting the new container, the port is unoccupied for a few
seconds. The maintenance page in the browser tolerates this ("Container is being replaced – briefly no connection") and
reloads as soon as the new version responds. A reverse proxy in front may return 502/503 in the meantime.

**Important with Compose:** The new container carries the Compose labels, so Compose still knows it. However, a later
`docker compose up -d` recreates it from the `image:` in the Compose file. So use `image: …:latest` (points to the same
digest after a release) or bump the tag – an older image would be stopped from starting by the schema guard, but the
app would then be down.

#### Access to the Docker API – risk

Whoever can operate the Docker API can start containers with arbitrary host mounts – this is **equivalent to root on
the host**. If an attacker achieves code execution in Wishy, they inherit this right. Therefore:

- **Option B (recommended): socket proxy** in an internal network that only allows the necessary endpoints
  (see the commented block in `docker-compose.yml`, example `wollomatic/socket-proxy`; alternatively
  `tecnativa/docker-socket-proxy` with `CONTAINERS=1 IMAGES=1 NETWORKS=1 POST=1 VERSION=1`, which is coarser).
  Exactly these are needed:
  - `GET /version` (also without version prefix), `GET /containers/{id}/json`, `GET /images/{name}/json`
  - `POST /containers/create`, `POST /containers/{id}/start`, `POST /containers/{id}/stop`,
    `POST /containers/{id}/rename`, `POST /images/create` (pull), `POST /networks/{id}/connect`
  - `DELETE /containers/{id}`, `DELETE /images/{id}`
  - not needed: exec, attach, logs, events, build, volumes, swarm, system, plugins.
  `DOCKER_HOST=tcp://docker-proxy:2375`, the network `docker-api` with `internal: true` (no internet).
  Even so, `containers/create` can create a privileged container – the proxy limits the attack surface but does not
  replace a trust decision.
- **Option A: socket directly** (`/var/run/docker.sock:/var/run/docker.sock`). Simple, full privileges.
- **Group:** The container runs as `node` (UID 1000). To read the socket it needs the socket's group on the host:
  `stat -c %g /var/run/docker.sock` (often 999 or 998) → `group_add: ["<gid>"]`
  (for option B at the proxy as `user: "65534:<gid>"`).
- TLS-secured Docker endpoints (`tcp://…:2376`) are not supported – use the socket proxy instead.
- Without Docker access everything else works unchanged (app updates, backups).

### 3.3 Updating the image manually (always possible)

```bash
docker compose pull && docker compose up -d
```

### 3.4 Manual rollback

```bash
docker compose exec wishy cat /data/app/current.json
docker compose exec wishy rm /data/app/current.json && docker compose restart wishy   # image baseline
# Data from before the update: Admin › Backups › pre-update backup › Restore, recovery view, or CLI (§5)
# Roll back an image update: docker compose up -d with the previous image tag (e.g. image: ghcr.io/veniplex/wishy:1.4.2)
```

## 4. Backups

A backup is **one file** `wishy-backup-<timestamp>-<version>[-<label>].wbk` (gzip tar): a consistent snapshot of the
database (`VACUUM INTO`, never the live WAL file), `images/`, `avatars/`, `secret.key` **only** in encrypted backups,
and `manifest.json` (last entry) with the SHA-256 of every entry. Every new backup is fully re-verified immediately.

**Encryption** (`.wbk.enc`): AES-256-GCM in 64 KiB chunks, key via scrypt (N=2^17, r=8, p=1 – other parameters are
rejected). Tampering, reordering and truncation are detected; a wrong passphrase is reported as such. The passphrase
is stored sealed with the server key (`BACKUP_PASSPHRASE` takes precedence). With encryption active, `pre-update`/
`pre-restore` backups are encrypted too.

> **Without the passphrase an encrypted backup cannot be restored.** Unencrypted backups do not contain `secret.key`:
> on a *new* server, 2FA and stored secrets must be set up again. An uploaded unencrypted backup that DOES contain
> `secret.key` is rejected.

**Schedule/retention:** `off`/daily/weekly on the hour (`TZ`); missed runs are made up once. The newest `keep_last` (14)
regular backups, none older than `keep_days` (90, 0 = unlimited); `pre-update`/`pre-restore` each `keep_pre_update` (5);
the newest backup is never deleted. Leftovers of aborted operations (`.upload-*`, `.tmp-*`, `*.part`) are removed after
an hour.

**Upload:** fully verified (encrypted ones only with the passphrase), unpacking only as much as there is space for.

**CLI** (in the container `docker compose exec wishy node /app/server/wishy-cli.js …`):
`create [--label x]`, `verify <file>`, `schema-info`.

## 5. Restore

Admin › Backups › Restore: verify the file and unpack it to `/data/restore-pending`, check DB integrity, reject
backups from a **newer schema** (`backup_schema_newer`) and ones with SQL triggers/views (`backup_invalid`) →
`pre-restore` backup → maintenance → restart. **Before** the database is opened, `images/`, `avatars/`, optionally
`secret.key` and **last** the database (incl. `-wal`/`-shm`) are swapped by renaming; a journal makes every step
repeatable (crash in the middle → resume at the next start), and on an error everything is swapped back. All sessions
except that of the acting admin end; backup/update settings are kept.

In the Docker image the launcher restarts automatically (on failure: `pre-restore` back). **Without a launcher** the
app stays in maintenance mode ("restart required"); the acting admin can keep loading the UI and cancel the restore
(`DELETE /api/admin/backups/restore-pending`).

**Emergency (app does not start):**

```bash
docker compose exec wishy node /app/server/wishy-cli.js restore <name-in-/data/backups>
docker compose restart wishy           # restored at startup; sign in again afterwards
```

## 6. Publishing releases (maintainers)

Setup (repository, key, environment `release-signing`, tag protection, GHCR) and process: **[RELEASING.md](RELEASING.md)**.

The workflow has three parts: `build` (no secrets; npm audit, tests, push the image by digest, Trivy scan, only then
image tags, metadata with image digest and component list) → `sign` (only this job sees the key, after approval in the
environment; it runs no npm code and verifies against `launcher/update-key.pub`) → `publish` (notes from `CHANGELOG.md`).
All actions are pinned by commit SHA (Dependabot keeps them current).

**Signing offline (alternative):** leave out the environment secret, the `sign` job fails → download the artifact
`release-unsigned`, run locally `node scripts/sign-release.mjs release --key <private.pem>
--verify-with launcher/update-key.pub`, then `gh release create v<v> release/* --notes-file …`.

### Per release

```bash
npm version patch        # or minor / major / 1.4.0-beta.1 – sets package.json and the tag v<version>
git push --follow-tags   # .github/workflows/release.yml
```

Result: `wishy-<v>.tar.gz` (+ `.sha256`, `.sig`) for app updates, `wishy-<v>.release.json` (+ `.sig`) with image digest
and component list for image updates, image `ghcr.io/veniplex/wishy:<v>` (+ `latest` for stable versions).
Pre-releases (`-beta.1`) only appear in the "prerelease" channel.

### Security watcher (automatic)

`.github/workflows/watch.yml` runs weekly (and on demand via
*Run workflow*): it builds the image of the latest stable release without pushing it, scans it with Trivy and runs
`npm audit --omit=dev`. If it finds fixable HIGH/CRITICAL vulnerabilities, a newer base image digest for the same Node
major, or newer Node/Alpine/Chromium versions than in the latest release's `components.json`, it opens (or updates) one
GitHub issue "Security updates available for the container image" (labels `security`, `dependencies`) and closes it
automatically once a later run finds nothing. Dependabot updates the base image digest, npm packages and actions;
`security.yml` checks every push (npm audit + Trivy, fails on fixable critical findings). The maintainer reacts by
merging the Dependabot PRs and cutting a release – see "Keeping the base image current" in [RELEASING.md](RELEASING.md).

**Launcher compatibility:** Only raise `LAUNCHER_VERSION` (`launcher/lib/release.js`) when new releases need a newer
launcher – app updates then require an image update.
**Changing the key:** see RELEASING.md §5.

## 7. Without the launcher (e.g. `npm start` on Windows)

| Feature | Docker + Docker API | Docker without API | `npm start` |
| --- | --- | --- | --- |
| Update check, notes | yes | yes | yes |
| Update from the app | image update (everything) | app + npm packages only | no (instructions) |
| Backups, schedule | yes | yes | yes |
| Restore | automatic restart | automatic restart | at the next manual restart |
| Maintenance page while the app is stopped, crash restart, recovery view | yes | yes | no |

Test locally: `DATA_DIR=C:\tmp\wishy-data PORT=3983 node launcher/index.js` (baseline = project folder).
End-to-end tests (builds releases, fake GitHub, fake Docker API; free ports, own temp directory):
`node scripts/test-update-e2e.mjs [--only backup|update|image] [--keep]`.

## 8. HTTP interfaces (short overview)

Public: `GET /api/maintenance`, `GET /__launcher/status`, `GET /healthz`, `GET /readyz`,
`/__launcher/recovery` (token). During maintenance the app answers everything with `503 {code:'maintenance'}` –
the acting admin may load the UI and use `GET /api/admin/update/status|log`, `GET /api/admin/backups`,
`GET /api/auth/me`, `DELETE /api/admin/backups/restore-pending`. The lock applies before all routes,
including the API with keys (`/api/v1`).

Admin: `GET|POST /api/admin/backups`, `GET|PUT /api/admin/backups/settings`, `POST /api/admin/backups/upload`,
`GET …/:name/download`, `POST …/:name/verify|restore`, `DELETE …/:name`, `DELETE …/restore-pending`;
`GET /api/admin/update/status[?refresh=1]`, `POST …/update/check`, `POST …/update/start {version, mode?}`,
`GET …/update/log`, `GET|PUT …/update/settings`.

## 9. Offline use (PWA)

Wishy can be installed as an app and keeps working when the Wishy server cannot be reached (no network, home server only
reachable at home, a reverse proxy answering `502`/`504`). Changes made meanwhile are stored on the device and sent when the
server is back.

**HTTPS is required.** Browsers only allow service workers (and installing the app) on HTTPS or on `localhost`. On plain
HTTP, for example `http://192.168.1.20:3000` in the home network, Wishy works as before: no offline start, no install, no errors.
Put a TLS-terminating reverse proxy in front (see `TRUST_PROXY` in §2) or use a hostname with a certificate to get the offline mode.

What works offline:

- Starting the app (the shell is cached by the service worker) when you were signed in on this device before.
- Reading everything that was synchronised: your spaces (persons, occasions, ideas, gifts), your wishlists and the lists
  shared with you, product images of those. After a start and again when the connection returns, all of it is fetched in the
  background (at most every 15 minutes), not only the pages you visited.
- Changing it: persons, occasions, ideas, gifts (including status, payment, settling shares), own wishlists and wishes.
  Rows created offline can be used right away (they get a temporary id that is replaced after the sync).

Needs a connection (the app shows a message): sharing, reserving, invites, link preview and import, AI, settings, spaces,
account and security, admin.

Synchronisation: the queued changes are sent in order as soon as the server answers again. Every change carries an `X-Op-Id`,
so a request whose response got lost is safe to send again (the server remembers the id for 90 days, table `client_ops`,
cleaned up by the retention job). Edits of different fields of the same record merge. If someone changed the same field
meanwhile, the change is held back and the sync dialog (shown in the header when something is pending) lets you keep yours or
theirs. A change the server rejects (for example missing permission, or the space no longer exists) is listed with the reason.

Where the data is kept: in the browser of the device (IndexedDB for data and the queue, Cache Storage for the app shell and
images), separately per user. Nothing is stored on the server for this except the op ids. The browser may evict data of sites
it considers unimportant; Wishy asks for persistent storage once something is worth keeping. **Signing out wipes the local
data of that user from the device** (with a warning when changes are still waiting). Signing out offline wipes it too and
ends the server session at the next contact. Account deletion or disabling removes it with the next start. Settings ›
Account › "Offline & app" shows the storage use, can remove the offline data and installs the app.

Reverse proxy notes: do not cache `/sw.js` or `/manifest.webmanifest` in the proxy (the app already sends
`Cache-Control: no-cache`); `/assets/<name>-<hash>.<ext>` is immutable for a year. The service worker only passes through
answers of the Wishy server: a `503` maintenance page is shown as usual, the cached shell is used only when no answer
arrives or the proxy answers `502`/`504`. `GET /manifest.webmanifest` is public; during `npm run dev` the Vite proxy forwards it.

## 10. For developers: schema version

The complete schema is created in its final form by `server/db.js` on a fresh database. `PRAGMA user_version` is the schema
version (baseline: 1, no migration steps yet). It makes backups from newer schemas get rejected and keeps older app versions
from starting on a newer database (exit 78, see the schema guard above).

To change the schema later: update the `CREATE TABLE` statements in `server/db.js`, add an idempotent upgrade step for existing
databases in `server/schema.js` and register the new number there:

```js
import { bumpSchema } from './schema.js'
bumpSchema(2, 'short-name')      // unique, ascending number – register it in the list in server/schema.js
```

## 11. Trying the first image updates on a real Docker host

The self-replacement is tested against a simulated Docker API, **not against a real daemon**. Before production use,
run through it once on a Linux host (throwaway data!):

```bash
# 1) Publish two pre-releases (e.g. v1.0.0-rc.1 and v1.0.0-rc.2, channel "prerelease")
mkdir -p /tmp/wishy-test && cd /tmp/wishy-test
curl -fsSLO https://raw.githubusercontent.com/veniplex/wishy/main/docker-compose.yml
# Use a host without another Wishy: container and volume have fixed names (wishy, wishy-data); otherwise change both and the port
# 2) Enable option B (uncomment the docker-proxy block + DOCKER_HOST + network), check the GID:
stat -c %g /var/run/docker.sock
WISHY_IMAGE=ghcr.io/veniplex/wishy:1.0.0-rc.1 docker compose up -d
docker compose logs wishy | grep -iE "docker api|recovery token"   # expected: Docker API available
# 3) In the app: create an admin, test data, set UPDATE_REPO, Admin › Updates → mode "Image" → update
watch -n1 'docker ps -a --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"'   # old → -old-…, helper, new
# 4) Check: same name, same ports/volumes/networks/labels, new image by digest
docker inspect wishy --format '{{.Image}} {{json .HostConfig.PortBindings}} {{json .NetworkSettings.Networks}}'
docker inspect wishy --format '{{index .Config.Labels "com.docker.compose.project"}}'
docker ps -a | grep -E "updater|old" && echo "ERROR: leftovers" || echo "cleaned up"
docker compose up -d   # must NOT reset the container to an older version (image: …:latest)
# 5) Test the rollback: publish a deliberately broken release (pre-release, e.g. healthz returns 500),
#    update → expected: old container runs again, status "failed", db_restored=true
# 6) Helper crash: during "swapping container" run `docker kill <name>-updater-<job>` → the helper restarts
#    and resumes (docker ps -a shows RestartCount)
# 7) Without Docker access: remove DOCKER_HOST → Admin › Updates shows "app only"
```
