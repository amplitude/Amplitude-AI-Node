# Releasing @amplitude/ai

## Automated Release (recommended)

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
   git commit -m "AA-XXXXX Bump @amplitude/ai to vX.Y.Z"
   git push origin main
   ```

4. **Tag the release** and push the tag:
   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```

5. The GitHub Actions workflow (`.github/workflows/publish.yml`) triggers automatically and publishes to npm.

## Manual Release (fallback)

If the GitHub Action isn't set up yet or you need to publish manually:

```bash
pnpm install
pnpm run build
npm publish --access public
```

You'll need an npm token with publish access to the `@amplitude` scope.

## GitHub Actions Setup

The publish workflow requires a repository secret named `NPM_TOKEN`. To set it up:

1. Generate an npm access token with publish permissions for the `@amplitude` scope
2. In the GitHub repo, go to **Settings > Secrets and variables > Actions**
3. Add a new secret: name = `NPM_TOKEN`, value = the token

## Versioning

- Use [semantic versioning](https://semver.org/): `MAJOR.MINOR.PATCH`
- The version in `package.json` is the single source of truth

## npm Package

- **Package name**: `@amplitude/ai`
- **npm URL**: https://www.npmjs.com/package/@amplitude/ai
- **Install**: `npm install @amplitude/ai`
