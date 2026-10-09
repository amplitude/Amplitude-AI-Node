# Releasing @amplitude/ai

## Publishing setup

`@amplitude/ai` is published only by `.github/workflows/publish.yml` through npm
Trusted Publishing (OIDC). There are no npm tokens; don't create any.

### npm package settings

At https://www.npmjs.com/package/@amplitude/ai/access:

- **Trusted Publisher** (case-sensitive):
  - **Repository owner**: `amplitude`
  - **Repository name**: `Amplitude-AI-Node`
  - **Workflow filename**: `publish.yml`
  - **Environment**: `npm`
- **Publishing access**: **"Require two-factor authentication and disallow tokens"**.
  Trusted Publishing still works with this setting; automation and granular
  tokens do not.

### GitHub settings

- **`npm` environment** (Settings → Environments): required reviewers from
  `@amplitude/agent-analytics`, and a deployment rule limited to `v*` tags and
  `main`. The publish job is the only job that runs in this environment and the
  only job with `id-token: write`.
- **Tag ruleset** restricting who can create `v*` tags.
- **CODEOWNERS** (`.github/CODEOWNERS`) covers `.github/workflows/` and `src/`.

### Release guard

The workflow's `verify` job runs an inline check before anything from the repo
is executed. It fails the release unless:

- the commit is on `main` (GitHub compare `main...<sha>` is `identical` or `behind`);
- for tag pushes, the tag is exactly `v<version>` where `<version>` is
  `package.json`'s `version` at that commit;
- for manual runs, the workflow was dispatched from `main`.

It then builds, type-checks and runs the tests. The `publish` job only runs
after `verify` passes, installs with `--ignore-scripts` and no dependency cache,
and publishes with provenance.

### Bootstrapping a new package

Trusted Publishing can't create a package. For a brand-new package, a maintainer
with 2FA publishes the first version manually from a clean checkout of `main`
(`pnpm install --frozen-lockfile && pnpm run build && npm publish --access public`),
then configures the settings above. Don't use third-party bootstrap tools.

## Automated Release (after setup)

1. **Bump the version** in `package.json`:
   ```json
   "version": "0.2.0"
   ```

2. **Regenerate agent docs** (if source changed):
   ```bash
   node scripts/generate-agent-docs.mjs
   ```

3. **Commit and push** to main:
   ```bash
   git add package.json AGENTS.md llms.txt llms-full.txt mcp.schema.json
   git commit -m "Release v0.2.0"
   git push origin main
   ```

4. **Tag the release** and push the tag:
   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```

5. The GitHub Actions workflow (`.github/workflows/publish.yml`) triggers automatically,
   runs the release guard and tests, waits for approval on the `npm` environment,
   and publishes to npm with provenance via Trusted Publishing (OIDC). It then
   creates a GitHub Release from the version's `CHANGELOG.md` section, so add
   a `## X.Y.Z` section before tagging or the release job fails.

6. **Docs site.** The docs repo's SDK release watcher picks up the GitHub
   Release and opens a Doc Bot PR against
   `sdks/agent-analytics/sdk-release-notes` in `amplitude/amplitude-docs-next`.
   Review that PR, and update `sdks/agent-analytics/sdk.md` yourself for any new
   or changed public API, default, or event property.

## Versioning

- Use [semantic versioning](https://semver.org/): `MAJOR.MINOR.PATCH`
- The version in `package.json` is the single source of truth

## npm Package

- **Package name**: `@amplitude/ai`
- **npm URL**: https://www.npmjs.com/package/@amplitude/ai
- **Install**: `npm install @amplitude/ai`

## Troubleshooting

- **npm CLI version**: Trusted Publishing requires npm >= 11.5.1. The publish workflow uses Node 24.x which bundles a compatible version.
- **"Process completed with exit code 1"**: This is a [known npm CLI issue](https://github.com/npm/cli/issues/8544). Even when it reports failure, the publish may have succeeded -- check npm to confirm.
- **Debug logging**: Add `--loglevel silly` to the npm publish command for more info.
