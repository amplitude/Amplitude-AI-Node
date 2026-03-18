# Releasing @amplitude/ai

## First-Time Setup (one-time bootstrap)

Trusted Publishing (OIDC) cannot be used for the very first publish of a new package.
You must bootstrap the package on npm first.

### Option A: Use setup-npm-trusted-publish (recommended)

```bash
npx --yes setup-npm-trusted-publish @amplitude/ai
```

This creates a dummy placeholder version on npm, allowing you to then configure
Trusted Publishing.

### Option B: Manual first publish with 2FA

1. Log in to npm with an account that has publish access to the `@amplitude` scope
2. From the repo root:
   ```bash
   pnpm install
   pnpm run build
   npm publish --access public
   ```
3. You'll be prompted for a 2FA OTP code

### Configure Trusted Publishing on npm

After the first version exists on npm:

1. Go to https://www.npmjs.com/package/@amplitude/ai/access
2. Add a **Trusted Publisher** with these settings (case-sensitive):
   - **Repository owner**: `amplitude`
   - **Repository name**: `Amplitude-AI-Node`
   - **Workflow filename**: `publish.yml`
   - **Environment**: *(leave blank)*
3. Set publishing access to: **"Require two-factor authentication or an automation or granular access token"**

After this, all future publishes go through GitHub Actions OIDC -- no npm tokens needed.

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

5. The GitHub Actions workflow (`.github/workflows/publish.yml`) triggers automatically
   and publishes to npm with provenance via Trusted Publishing (OIDC).

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
