---
name: wednesdayai-mac-release
description: "Run or recover WednesdayAI macOS release signing, notarization, appcast, and asset promotion."
---

# WednesdayAI Mac Release

Use with `$wednesdayai-release-maintainer`, `$wednesdayai-release-ci`, and `$one-password` when stable macOS assets, private mac preflight, notarization, appcast promotion, or mac release recovery is involved.

## Credentials

- Canonical ASC item: vault `Molty`, title `API Key - App Store Connect - Personal - Release`.
- Fields: `private_key_p8`, `key_id`, `issuer_id`.
- Current known good key id: `AKVLXW849T`.
- Legacy mirror: vault `Private`, title `API Key - App Store Connect - Personal`; keep it synced for older refs.
- Stale/revoked key symptom: `xcrun notarytool submit` fails with `HTTP status code: 401. Unauthenticated`.
- Validate candidate ASC credentials with `xcrun notarytool history` before setting GitHub secrets.

## 1Password

- Use `$one-password`: all `op` work inside one persistent tmux session, no secret output.
- Prefer `OP_SERVICE_ACCOUNT_TOKEN` from `~/.profile` for Molty reads.
- Do not assume `MOLTY_OP_SERVICE_ACCOUNT_TOKEN` is alive; it has previously pointed at a deleted service account.
- If a service token fails, run status-only checks: token present/length and `op whoami`; never print token values.
- If desktop app auth is needed but Touch ID is unavailable, set `OP_BIOMETRIC_UNLOCK_ENABLED=false` for the manual `op account add --signin` path.

## GitHub Secrets

Target private repo environment: `openclaw/releases-private`, env `mac-release`.

Set only after local notary auth validation:

- `APP_STORE_CONNECT_API_KEY_P8`
- `APP_STORE_CONNECT_KEY_ID`
- `APP_STORE_CONNECT_ISSUER_ID`

Do not update these from mixed sources. All three ASC fields must come from the same 1Password item.

## Workflow Shape

- Public release branch may carry mac-only packaging fixes after the stable tag/npm are already live.
- Use `source_ref=release/YYYY.M.D` for private mac preflight/validation when building that branch variation.
- Keep `tag=vYYYY.M.D` pointing at the original stable release commit.
- Real mac publish must reuse:
  - a successful private mac preflight run for the same tag/source SHA
  - a successful private mac validation run for the same tag/source SHA
- If preflight source SHA differs from tag SHA, validation must also use the same `source_ref`; promotion rejects mismatched proof.

## Build and Package (WednesdayAI-apps)

The macOS app is built and packaged in the [WednesdayAI-apps](https://github.com/ExpansionX/WednesdayAI-apps) repository, not in core:

- Sync client contracts and stamp app versions before packaging: `npm run contracts:sync` (pins `apps/shared/contracts/CORE_VERSION`, regenerates Swift, stamps app versions).
- Package the app: `npm run mac:package` (wraps `scripts/package-mac-app.sh`; outputs `dist/OpenClaw.app`). The app no longer bundles the gateway.
- Do not run core-only steps here (`pnpm` scripts, npm publish, `version:sync`); core versioning is owned by the WednesdayAI-core release, and app versions follow the synced `CORE_VERSION` (ADR 0097).

## Notarization

- WednesdayAI uses `scripts/notarize-mac-artifact.sh`.
- `xcrun notarytool submit` should use `--no-s3-acceleration`; accelerated upload can surface misleading 401s even when `notarytool history` succeeds.
- If signing succeeds but notarization fails immediately with 401, check ASC key freshness first.
- If notarization stays in progress for several minutes after key-file write, that is normal Apple wait time; do not edit blindly.

## Dispatch

Private preflight:

```bash
gh workflow run openclaw-macos-publish.yml --repo openclaw/releases-private --ref main \
  -f tag=vYYYY.M.D \
  -f source_ref=release/YYYY.M.D \
  -f preflight_only=true \
  -f smoke_test_only=false \
  -f allow_late_calver_recovery=false \
  -f public_release_branch=release/YYYY.M.D
```

Private validation for a branch-variation preflight:

```bash
gh workflow run openclaw-macos-validate.yml --repo openclaw/releases-private --ref main \
  -f tag=vYYYY.M.D \
  -f source_ref=release/YYYY.M.D
```

Real publish:

```bash
gh workflow run openclaw-macos-publish.yml --repo openclaw/releases-private --ref main \
  -f tag=vYYYY.M.D \
  -f preflight_only=false \
  -f smoke_test_only=false \
  -f preflight_run_id=<successful-preflight-run> \
  -f validate_run_id=<successful-validation-run> \
  -f allow_late_calver_recovery=false \
  -f public_release_branch=release/YYYY.M.D
```

## Appcast

Generate the Sparkle appcast with `scripts/make_appcast.sh OpenClaw-<ver>.zip`. Set `CHANGELOG_FILE` to a checkout of the WednesdayAI-core `CHANGELOG.md` for the release version (app version == core version); the script fails without it, and it generates HTML release notes via `scripts/changelog-to-html.sh`.

## Verify

- `gh release view vYYYY.M.D --repo openclaw/openclaw` shows zip, dmg, dSYM zip, not draft, not prerelease.
- Public `main` `appcast.xml` points at `WednesdayAI-YYYY.M.D.zip`.
- Appcast entry has `sparkle:version`, `sparkle:shortVersionString`, length, and `sparkle:edSignature`.
