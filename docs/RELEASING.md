# Publishing releases (maintainers)

This guide describes setup and process for `veniplex/wishy`. Technical background (signatures, update flow, security
watcher): [operations.md](operations.md) §3 and §6.

Overview: A tag `v<version>` starts `.github/workflows/release.yml`:
`build` (checks, tests, builds archive and multi-arch image, scans, only then applies the image tags) →
`sign` (environment `release-signing`, manual approval, the only job with the key) → `publish` (GitHub release).
Versions are plain semver (`1.2.3`, `1.3.0-rc.1`); every release is cut by hand, including base image / Node updates (patch release). A weekly security watcher
(`.github/workflows/watch.yml`) tells you when one is due (section 7).

## 1. One-time setup

1. **Create the repository:** `veniplex/wishy`, public, default branch `main`. Add a `LICENSE` file before the first
   push (the README refers to it).
2. **Generate the signing key** (see section 2) and commit `launcher/update-key.pub`.
3. **Push:** `git remote add origin git@github.com:veniplex/wishy.git && git push -u origin main`.
4. **Settings › Actions › General:** set workflow permissions to *Read repository contents and packages permissions*
   (the workflows request write permissions per job themselves). *Allow GitHub Actions to create and approve pull
   requests* is not needed. Allow actions (all actions are pinned by SHA).
5. **Settings › Environments › New environment `release-signing`:**
   - *Required reviewers*: yourself (turn *Prevent self-review* off if you are alone).
   - *Deployment branches and tags*: **`v*` (tags) only.**
   - *Environment secret* `WISHY_UPDATE_KEY` = the Base64 line of the private key. **Not** a repository secret.
6. **Tag protection:** Settings › Rules › Rulesets › New tag ruleset, target `v*`, *Restrict updates* and
   *Restrict deletions*, plus *Restrict creations* with yourself as bypass so you can still create release tags.
7. **Branch protection `main`:** ruleset requiring pull requests and the status checks `test`, `docker` (CI);
   forbid force pushes and deletion.
8. **Security:** Settings › Code security: enable *Dependabot alerts*, *Dependabot security updates* and *Private
   vulnerability reporting* (for [SECURITY.md](../SECURITY.md)). `.github/dependabot.yml` is in place.
9. **Make the GHCR package public:** After the first successful image push (release dry run), set the visibility to
   *Public* under *Profile/Organization › Packages › wishy › Package settings* and link the package to the repository.
   Installations pull the image without logging in.

## 2. Signing key

```bash
node scripts/gen-update-key.mjs
```

- Writes `launcher/update-key.pub` (**commit it**; it is built into the image and used by installations for verification).
- Prints the private key **once**. Store it **only** (a) as the environment secret `WISHY_UPDATE_KEY` and
  (b) as an offline backup (password manager/encrypted drive). Not in the repository, not in chats, not in issues.
  Whoever has it can sign updates for all installations.
- Without `launcher/update-key.pub` in the tagged commit, the release workflow aborts immediately with an error message.

## 3. Dry run: `v1.0.0-rc.1` first

The workflow has never run before the first tag. So set a pre-release tag first (it appears as a pre-release and moves
neither `latest` nor the stable update channel):

```bash
npm version 1.0.0-rc.1          # package.json + lockfile + commit + tag v1.0.0-rc.1
git push --follow-tags
```

Check, wait for the environment approval, verify the result (section 4). Fix problems, then delete the tag
(`git push --delete origin v1.0.0-rc.1`, delete the release on GitHub) and repeat with `-rc.2`. Then, for
1.0.0: date the section `## [1.0.0] – unreleased` in the changelog, `npm version 1.0.0`, push.
(If `package.json` is already at the target version, `npm version` does not work: use `git tag v1.0.0` and
`git push origin v1.0.0` instead.)

## 4. Release process

1. `CHANGELOG.md`: add a section `## [x.y.z] – <date>` (heading exactly `## [x.y.z]`; the section is used as the
   release notes, for pre-releases the section of the main version is used as a fallback).
2. Merge everything to `main`; CI must be green.
3. `npm version x.y.z` (or `x.y.z-rc.1`), then `git push --follow-tags`. The tag must match `package.json`, otherwise
   the workflow aborts.
4. Actions › *Release*: `build` runs (tests; the image build with QEMU for arm64 takes a while). Then `sign` waits for
   your approval (*Review deployments*).
5. Check once the run is green:
   - Release `v<x.y.z>` contains `wishy-<v>.tar.gz`, `.tar.gz.sha256`, `.tar.gz.sig`, `wishy-<v>.release.json`, `.release.json.sig`.
   - Image: `docker buildx imagetools inspect ghcr.io/veniplex/wishy:<v>` shows `linux/amd64` and `linux/arm64`; the
     digest matches `image.digest` in `wishy-<v>.release.json`. Stable versions additionally carry `latest`
     and `<major>.<minor>`; pre-releases do not.
   - Signatures: the `sign` job has already verified them against `launcher/update-key.pub`; the end-to-end check is the staging test.
6. **Staging test:** Start a throwaway instance with the previous version (instructions: [operations.md](operations.md) §10),
   *Admin › Updates* (channel "Pre-releases" for rc), update. Expected: the update completes, the version is correct.

## 5. Changing the key

Generate a new pair with `node scripts/gen-update-key.mjs --force`, commit the new `update-key.pub`, replace the secret.
Consequences: Already installed instances only know the old public key and **reject updates signed with the new one**
(`signature_invalid`). They must renew the image manually once (`docker compose pull && docker compose up -d`, the
new image contains the new key) or temporarily set `UPDATE_PUBLIC_KEY`. So only change it when a key loss is suspected;
a second key in parallel is not supported.
Losing the private key means the same: no more signed updates for existing installations until they switch manually to
an image with a new key.

## 6. Troubleshooting

| Symptom | Cause / remedy |
| --- | --- |
| `build` aborts immediately: `update-key.pub is missing` | Generate the key and commit it, re-create the tag (moving a tag: locally `git tag -f`, `git push -f origin v…` only if tag protection allows it, otherwise use a new version). |
| `Tag … does not match package.json` | Use `npm version <x.y.z>` instead of a manual tag; delete the tag and re-create it. |
| `CHANGELOG.md has no section` | Add a section `## [x.y.z]` with content. |
| `sign` does not start / waits forever | Grant approval under *Review deployments*; the environment `release-signing` must allow the tag. |
| `Secret WISHY_UPDATE_KEY is missing` | Create the secret in the **environment** (not in the repository). |
| `Private key does not match launcher/update-key.pub` | The secret belongs to a different pair than the committed `update-key.pub`. |
| Push to GHCR fails (`denied`) | Settings › Actions: workflow permissions; package already owned by someone else? Check package access for the repository. |
| Trivy reports CRITICAL | Fixable critical finding: update the base image/dependency. No tag was applied yet. Unfixable findings (`ignore-unfixed`) do not block. |
| Installations do not see the release | Package/release visibility; for a pre-release the "prerelease" channel; repository entry in Admin › Updates. |
| The watcher issue does not appear / does not close | Check the run of *Security watcher* (Actions); it needs `issues: write` and runs weekly or via *Run workflow*. |

## 7. Keeping the base image current

The image is built on a base pinned by digest (`FROM node:24-alpine@sha256:…`), and `apk upgrade` pulls in Alpine fixes
at build time. Nothing is rebuilt or published automatically; instead:

1. **Dependabot** (`.github/dependabot.yml`, weekly) opens pull requests for the base image digest (same Node major;
   major bumps are ignored), for npm packages (minor/patch grouped) and for GitHub Actions (pinned by SHA).
2. **CI** (`ci.yml`, `security.yml`) builds and tests every pull request, including a Docker build and a container scan.
3. **You merge** the green Dependabot PRs and **cut a release** (section 4, usually a patch version with a changelog
   entry such as "Updated base image and dependencies"). The release job builds on the fresh digest, scans, signs and
   publishes; installations then offer it as an update in Admin › Updates.
4. **The security watcher** (`.github/workflows/watch.yml`, weekly, also via *Run workflow*) builds the image of the
   latest stable release (or `main` if there is none) without pushing it, runs Trivy (HIGH/CRITICAL, fixable only)
   and `npm audit --omit=dev`, and compares the result with the latest release: a newer base digest for the same Node
   major, or newer Node.js/Alpine/Chromium versions than in the release's `components.json`. If anything is found, it
   opens or updates **one** issue titled "Security updates available for the container image" (labels `security`,
   `dependencies`) with a table (package, installed → fixed, severity, CVE) and the recommendation to merge the Dependabot
   PRs and cut a release. When a later run finds nothing, it closes the issue itself.

The watcher needs only `contents: read`, `issues: write` and `packages: read`; it never pushes an image, creates a tag
or publishes a release.
