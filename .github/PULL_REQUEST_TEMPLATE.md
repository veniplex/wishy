<!-- Security fix? Please report the vulnerability privately first, see SECURITY.md. For larger changes, open an issue first. -->

## What changes and why?

<!-- Short description. Link the issue: Fixes #123 -->

## Type of change

- [ ] Bug fix
- [ ] New feature or improvement
- [ ] Documentation or translation
- [ ] Build, CI or dependencies

## How was it tested?

<!-- Steps, browsers, Docker … UI changes: screenshots in light and dark, desktop and phone width -->

## Checklist

- [ ] `npm run typecheck` and `npm run build` pass
- [ ] `npm run test:smoke` passes; tests added where it makes sense
- [ ] UI texts exist in `src/i18n/locales/de` **and** `en`
- [ ] Permissions and the protection of surprises (nobody sees gifts or reservations meant for them) are enforced on the server
- [ ] New writes work offline or are clearly online only (`server/offline-ops.js`, `src/offline/routes.ts`)
- [ ] Schema changes: `bumpSchema` is called (docs/operations.md §10)
- [ ] New environment variables are listed in `docker-compose.yml` and the README
- [ ] `CHANGELOG.md` is updated if users notice the change
- [ ] No secrets, credentials or personal data in the diff
- [ ] I agree that my contribution is licensed under AGPL-3.0-only, the license of this project
