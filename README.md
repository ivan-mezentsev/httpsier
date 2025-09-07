# httpsier

[![npm version](https://img.shields.io/npm/v/httpsier)](https://www.npmjs.com/package/httpsier) [![npm downloads](https://img.shields.io/npm/dm/httpsier)](https://www.npmjs.com/package/httpsier)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub issues](https://img.shields.io/github/issues/ivan-mezentsev/httpsier.svg)](https://github.com/ivan-mezentsev/httpsier/issues)

Tiny, opinionated HTTP tunnel for local development, built on Cloudflare Workers + Durable Objects. The CLI opens a WebSocket to your Worker and proxies public HTTP traffic from a slug subdomain like `https://<slug>.<your-domain>` to your local server (for example, `http://localhost:8080`).

- Worker uses a custom domain with wildcard subdomains (e.g. `*.example.com`) and routes traffic to a Durable Object that multiplexes requests over a single WS connection to your machine.
- CLI is a single-file Node.js 18+ binary published to npm and runnable via npx.
- Safe defaults: strips service Authorization from proxied requests, sets X-Forwarded-* headers, basic concurrency limiting per isolate, and throttle windows for repeated unauthenticated hits.

## How it works (high level)

1) CLI connects to the Worker over WebSocket at `wss://<slug>.<CUSTOM_DOMAIN>/connect?slug=<slug>`, authenticating with a bearer API token.
2) Public HTTP requests to `https://<slug>.<CUSTOM_DOMAIN>/*` are forwarded by the Worker to a Durable Object instance keyed by the slug. The DO streams the request over the WS to the CLI.
3) CLI performs a local fetch against your target (for example, `http://localhost:8080`), streams the response back to the DO, and the Worker returns it to the public client.

## Requirements

- Node.js 18 or newer on the client side (for the CLI).
- A Cloudflare account with a zone using your custom domain (DNS managed by Cloudflare) to attach Worker routes.
- You must own a domain whose DNS is managed by Cloudflare (active zone). Wildcard subdomains are supported by free plan.
- Wrangler CLI installed and authenticated: <https://developers.cloudflare.com/workers/wrangler/>

## Configure the Worker (start from the example)

If you don’t have `worker/wrangler.toml` yet, copy the provided example and edit a few keys:

```bash
cp worker/example.wrangler.toml worker/wrangler.toml
```

Open `worker/wrangler.toml` and update the following:

- [vars]
  - CUSTOM_DOMAIN = "example.com" → set to your domain (must be in your Cloudflare zone)
  - DELAY_SECONDS and CONCURRENT_SESSIONS_MAX: keep defaults or tune to your needs

- [routes]
  - Ensure the apex route matches your zone (pattern/zone_name)
  - Ensure the wildcard subdomain route exists: `*.your-domain/*`
  - Set `custom_domain = true` for the apex if you want an explicit custom domain binding

Other important settings are already present in the template:

- Durable Object binding for the session registry:
  - [[durable_objects.bindings]] name = "SESSION_REGISTRY", class_name = "SessionRegistry"
- Compatibility date and entrypoint:
  - `main = "src/worker.js"`
  - `compatibility_date = "YYYY-MM-DD"` (keep the pinned date or bump intentionally)

## Deploy the Worker

From the `worker/` folder:

```bash
cd worker
wrangler login           # one-time, opens a browser for auth
wrangler deploy          # uploads the worker and provisions the Durable Object
```

After a successful deploy, requests to your configured routes (apex and wildcard) will hit this Worker.

## DNS setup (required)

In your Cloudflare Dashboard for the domain (Zone) used in `CUSTOM_DOMAIN`:

- Create a wildcard CNAME that points to the apex and make sure it is proxied:

  ```text
  Type:   CNAME
  Name:   *
  Target: @   (the zone apex)
  Proxy:  Proxied (orange cloud on)
  ```

## Set the secret API token (server side)

The Worker expects a bearer token for the CLI’s `/connect` handshake.

```bash
cd worker
wrangler secret put API_TOKEN
# paste a long random value, for example:
# openssl rand -hex 32
```

Notes:

- The token is only used by `/connect` for authenticating the CLI. It’s not forwarded to your backend.
- You don’t need to redeploy after putting/updating a secret; Workers apply it immediately.

## Run the CLI via npx

You can keep your token in an environment variable locally:

```bash
export API_TOKEN="<the-same-value-you-put-with-wrangler>"
```

Then start the tunnel to your local server (example: `http://localhost:8080`) using your custom domain as the Worker base:

```bash
npx httpsier \
  --http http://localhost:8080 \
  --api "${API_TOKEN}" \
  --worker https://<YOUR_CUSTOM_DOMAIN> \
  --json \
  --slug myapp
```

- Public URL format: `https://myapp.<YOUR_CUSTOM_DOMAIN>`
- Omit `--slug` to use a random slug.
- Add `--json` for machine-friendly logs (newline-delimited JSON with events like `connected` and per-request summaries).

Usage synopsis printed by the tool:

```text
Usage: npx httpsier --http http://localhost:8080 --api [token] --worker https://<worker-host> [--json] [--slug name]
```

## What gets forwarded to your local server

- Your end-user Authorization header (if any) is forwarded untouched.
- The service Bearer token used for `/connect` is never forwarded.
- Standard proxy headers are added: `X-Forwarded-Proto`, `X-Forwarded-Host`, `X-Forwarded-For`.

## Components and tooling

- Cloudflare Workers Runtime and Cache API (throttle windows).
- Cloudflare Durable Objects (session registry, sticky WS per slug).
- Wrangler (build/deploy/secrets).
- Node.js 18+ (global fetch, WHATWG streams in the CLI).
- WebSocket (ws) for the tunnel.
- TypeScript + esbuild for a single-file ESM CLI bundle.
- ESLint + Prettier for linting/formatting.

## Troubleshooting

- 401 Unauthorized on `/connect` with delay: check that `API_TOKEN` secret exists in the Worker and matches the `--api` value you pass to the CLI.
- Domain mismatch: ensure `CUSTOM_DOMAIN` and both `[[routes]]` entries in `worker/wrangler.toml` match your zone (apex and wildcard).
- CLI log says “Waiting for a free slot on worker…”: the Worker is busy; it’ll connect as a slot frees (limited by `CONCURRENT_SESSIONS_MAX`).
- Repeated 404 with delay on a slug: likely no active CLI session for that slug. Start the CLI or use the correct `--slug`.
