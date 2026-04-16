# Designsystem Healthcheck

Turborepo monorepo with a Figma plugin and a Cloudflare Worker API proxy.

## Package manager

Use `pnpm` for all package operations. Do not use npm or yarn.

## Structure

- `apps/figma-plugin/` — Figma plugin (TypeScript + ui.html)
- `apps/worker/` — Cloudflare Worker CORS proxy for Anthropic API

## Build

- `pnpm run build` — build all apps
- `pnpm run dev` — dev mode (worker on localhost:8787, plugin watch)
- `pnpm run lint` — lint all apps

## Worker

- Local secrets in `apps/worker/.dev.vars`
- Production secrets via `wrangler secret put <NAME>`
- `pnpm --filter worker dev` — run worker locally
- `pnpm --filter worker deploy` — deploy to Cloudflare

## Figma plugin

- `pnpm --filter figma-plugin build` — compile code.ts to code.js
- Plugin UI calls the worker (localhost in dev, workers.dev in prod)
- `WORKER_URL` and `API_TOKEN` constants at top of ui.html
