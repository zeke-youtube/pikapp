# PikaMail v0.1

PikaMail is PikaStudio's lightweight, private messaging service for verified PikApp users. It supports **internal `@pikamail.com` → `@pikamail.com` mail only**. It does not provide SMTP, IMAP, POP3, MX, custom domains, Gmail/Outlook integration, or inbound/outbound internet email. PikaMail v0.1 does **not** deliver to external internet email addresses.

## Architecture

- Cloudflare Worker (`worker/index.js`) validates identity, authorization, input, mail access, developer keys, admin actions, and rate limits.
- Vanilla HTML/CSS/JavaScript in `public/` provides Inbox, Compose, Sent, Settings, address setup, Developer Tester, and API documentation.
- One Cloudflare KV binding, `PIKAMAIL_KV`, stores accounts, the direct `mail-address:<local-part>` index, messages, bounded mailbox indexes, applications, SHA-256 key hashes, rate buckets, and body-free audit events.
- Private routes use `no-store`; the app is `noindex`. Plain-text bodies are placed into the DOM with `textContent`, not raw HTML.

### PikApp identity contract

Set `PIKAPP_VERIFY_URL` to a PikApp endpoint which accepts the incoming `Authorization` and/or session `Cookie` and returns:

```json
{
  "verified": true,
  "user": { "id": "user_immutable", "username": "pika", "displayName": "Pika", "role": "user" }
}
```

`user.id` must be stable and server-verified. `role` may be `admin`; PikaMail never accepts browser-supplied identity or admin flags. If service authentication is required, store `PIKAPP_SERVICE_TOKEN` as a Wrangler secret; the Worker sends it as `X-PikApp-Service-Token`. No production credentials are included. Without `PIKAPP_VERIFY_URL`, authentication fails closed.

## Addresses and mail

A verified user without an address (including an existing PikApp user) chooses one in Settings and explicitly confirms permanence. Addresses are normalized to lowercase and cannot be renamed, replaced, synchronized, or claimed twice. Local parts are 3–32 characters, begin/end with a letter or number, and contain lowercase letters, numbers, underscores, or non-consecutive dots. Central reserved names include `admin`, `root`, `support`, `security`, `abuse`, `postmaster`, `noreply`, `system`, `api`, developer names, and Pika product names.

The direct address index avoids scans. Cloudflare KV is eventually consistent and does not provide compare-and-swap; the Worker uses preflight and post-write owner checks to minimize races. For strict globally simultaneous claims at scale, route address claims through a single Cloudflare Durable Object while retaining KV as the lookup index.

Inbox and Sent use bounded indexes and 20-item cursor pages. Opening a recipient message marks it read; a PATCH can mark it read/unread. Sender identity for user mail is always derived from the verified PikApp account. Messages are private to sender and recipient.

## Developer API (real mail; no sandbox)

Applications store owner ID, name, assigned senders, enabled state, timestamps, key suffix, and only the SHA-256 API-key hash. Keys use `pm_live_<cryptographically-random-value>`, are shown once, and can be revoked. There are no `pm_test_` keys and **no sandbox endpoint**. Admins assign senders and can disable compromised applications. Revoking removes the key lookup; disabling preserves it so requests receive an explicit disabled response. Security actions produce audit metadata without message bodies, tokens, or plaintext keys.

`POST /api/v1/send` authenticates `Authorization: Bearer pm_live_...`, checks the enabled app and assigned sender, validates the internal recipient, and enforces 60 requests per app per minute (a lightweight KV fixed window). A successful call writes the same real message and mailbox indexes used by user mail. A 429 response asks the caller to retry later. KV counters are lightweight abuse protection rather than a strict globally atomic quota.

API keys are server-side secrets. **Do not expose them in frontend/browser JavaScript.** The first-party desktop Tester uses the authenticated owner route, applies the same sender/recipient/rate rules, and delivers real mail without returning or storing a plaintext key. On mobile, ordinary mail remains available while the testing workspace shows a desktop notice. Device type is never an authorization control.

Developer code examples and response/error documentation are available on the Developer screen. Calling applications create and validate their own verification codes; PikaMail only delivers messages.

## Admin API

Server-verified PikApp admins can:

- `POST /api/admin/apps/:id/sender` with `{ "sender": "verify@pikamail.com" }`
- `POST /api/admin/apps/:id/state` with `{ "enabled": false }`

This intentionally small surface supports controlled sender assignment, application disabling, and API revocation through the owner dashboard. Provision the first admin in PikApp, not from PikaMail browser input.

## Local development and validation

```sh
npm install
npm test
npm run check
git diff --check
npx wrangler dev
```

Tests inject a test-only identity map directly into the Worker environment; that mechanism is not configured by Wrangler and is unavailable in deployment.

## Cloudflare deployment

The exact required bindings/configuration are:

1. Static Assets binding `ASSETS` (declared in `wrangler.jsonc`).
2. KV namespace binding `PIKAMAIL_KV` (declared in `wrangler.jsonc`; Wrangler can provision its ID on first deployment).
3. Variable `PIKAPP_VERIFY_URL` configured for the real PikApp verification endpoint.
4. Optional secret `PIKAPP_SERVICE_TOKEN` if PikApp requires service authentication.

```sh
npm install
npm test
npm run check
npx wrangler secret put PIKAPP_SERVICE_TOKEN # only when required
npx wrangler deploy
```

Before production, set `PIKAPP_VERIFY_URL` in Cloudflare configuration, establish the PikApp admin role, assign application senders through the admin API, and consider a Durable Object if globally atomic address claims/quotas are required. No production deployment is performed by this repository setup.
