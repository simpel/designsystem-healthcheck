# Designsystem Healthcheck

A Figma plugin that audits design system variables against a 3-layer architecture (primitives → themes → components). Powered by Claude AI via a Cloudflare Worker proxy.

## Architecture

```
apps/
  figma-plugin/   Figma plugin (TypeScript + HTML/CSS)
  worker/         Cloudflare Worker — CORS proxy for Anthropic API + D1 database
```

The plugin runs entirely inside Figma. The worker handles API authentication so the Anthropic key is never exposed to the client.

## Setup

### Prerequisites

- Node.js 22+
- pnpm 9+
- A [Cloudflare](https://cloudflare.com) account with Workers enabled
- An [Anthropic](https://console.anthropic.com) API key

### Install

```sh
pnpm install
```

### Worker secrets

For local development, create `apps/worker/.dev.vars`:

```sh
ANTHROPIC_API_KEY=sk-ant-...
```

For production, set the secret via Wrangler:

```sh
pnpm --filter worker exec wrangler secret put ANTHROPIC_API_KEY
```

### Figma plugin URLs

| File | URL used |
|------|----------|
| `apps/figma-plugin/.env` | `http://localhost:8787` (dev) |
| `apps/figma-plugin/.env.production` | Your deployed worker URL (prod) |

## Development

```sh
# Start worker (localhost:8787) and watch plugin files
pnpm dev
```

Load the plugin in Figma: **Plugins → Development → Import plugin from manifest** → select `apps/figma-plugin/manifest.json`.

## Building the plugin

```sh
# Development build (points to localhost)
pnpm --filter figma-plugin build

# Production build (points to deployed worker)
NODE_ENV=production pnpm --filter figma-plugin build
```

Output is `apps/figma-plugin/dist/ui.html`. Update the manifest to point at the `dist/` directory before publishing.

## Deploying the worker

```sh
pnpm --filter worker deploy
```

CI deploys automatically on every push to `main` — see `.github/workflows/deploy.yml`. Add `CLOUDFLARE_API_TOKEN` as a repository secret in GitHub.

## Database

The worker uses Cloudflare D1 (SQLite).

```sh
# Apply migrations locally
pnpm --filter worker db:migrate:local

# Apply migrations to production
pnpm --filter worker db:migrate:remote
```
