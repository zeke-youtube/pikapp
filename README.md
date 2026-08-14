# PikApp MVP

PikApp is a lightweight, mobile-first social network with a deliberately separate AI chat workspace. The social side supports registration, sessions, editable text posts, one-level threaded replies, likes, follows, profiles with paginated post lists and owner settings, refreshable identicon avatars, and ranked Explore search. Direct thread links use `/?post=<post-id>`. AI never appears in or modifies the social feed.

## Architecture

- **Frontend:** directly editable HTML, responsive CSS, and small vanilla JavaScript ES modules in `public/`. No build step or framework.
- **Backend:** one Cloudflare Worker in `worker/index.js`, serving REST APIs and static assets.
- **Data:** Cloudflare KV binding named `PIKAPP_KV`, using namespaced keys such as `user:`, `username:`, `session:`, `post:`, `post-likes:`, `followers:`, `following:`, `feed:recent`, and `mod:event:`. KV is eventually consistent; counters and list updates can briefly lag or lose competing writes. This is an intentional MVP tradeoff, not a transactional design.
- **Search:** MiniSearch runs inside the Worker over bounded recent-user/recent-post sets; browsers never download the complete corpus. It can later be replaced behind `/api/search`.
- **Security:** authorization, roles, bans, input validation, spam controls, and moderation all run in the Worker. Passwords use Web Crypto PBKDF2-HMAC-SHA-256 with a random 128-bit salt and 100,000 iterations (Cloudflare Workers' supported maximum); the iteration count is stored with each hash for compatibility. Sessions use random opaque, HttpOnly, Secure, SameSite=Lax cookies. Raw email is omitted from public API objects unless `showEmail` is true.

## Files

```text
public/index.html          app shell
public/mod.html            protected moderator UI
public/css/style.css       responsive themes/layout
public/js/*.js             feature modules
worker/index.js            Worker API
test/worker.test.js        backend tests
wrangler.jsonc             Cloudflare configuration
```

## Local development

Node.js 20+ is recommended. No database, Docker, native toolchain, or frontend build is required.

```bash
npm install
npx wrangler dev
```

Open the URL Wrangler prints (normally `http://localhost:8787`). Wrangler uses local KV storage while developing and automatically exposes the configured Workers AI binding. No Groq, OpenAI, moderation, or other provider API key is required. Both chat and automated post moderation run through Cloudflare Workers AI; moderation fails closed if the binding or model is unavailable.

## Configuration

Required binding:

| Name | Type | Purpose |
|---|---|---|
| `PIKAPP_KV` | KV namespace | users, sessions, posts, relationships, moderation metadata |
| `AI` | Workers AI | AI chat and automated post moderation |

Model variables (non-secret values are in `wrangler.jsonc`):

| Name | Default | Purpose |
|---|---|---|
| `AI_MODEL` | `@cf/qwen/qwen3-30b-a3b-fp8` | Workers AI chat model |
| `MODERATION_MODEL` | `@cf/meta/llama-guard-3-8b` | Workers AI safety model |

The `ai` section in `wrangler.jsonc` creates the `AI` binding. Workers AI is authenticated by the deployed Worker, so the application has no AI or moderation secrets to create, store, or expose.

To bootstrap the first admin, register normally, then use the Cloudflare dashboard's KV viewer to edit `user:<id>` and change `"role":"user"` to `"role":"admin"`. Find the ID in `username:<your_username>`. Thereafter admins can manage moderator roles via the protected API. Do not accept roles from registration clients.

## Profiles and settings

Profiles request 20 authored posts at a time from `GET /api/users/:username/posts`; the response includes a bounded next-page cursor for a **Load more** button. The profile, Home, thread, and Explore views share `postHtml` and `bindPosts`, so likes, replies, timestamps, edited labels, and authorized edit/delete actions behave consistently. Own-profile settings use authenticated `PATCH /api/settings/profile`; the Worker derives the account from the session rather than accepting a user ID. `POST /api/settings/avatar` replaces the user's public identicon seed without changing their private email.

Navigation is centralized in `public/js/navigation.js`. It constructs a destination from a per-view allowlist, clears unrelated search/hash state, and uses `pushState`/`replaceState`. `popstate` restores Back/Forward views, while direct `/?post=<id>` URLs still render threads after refresh.

## Editing and conversation behavior

Every feed post opens a shareable thread at `/?post=<post-id>`. The thread shows the original, an authenticated reply composer, and one clear level of replies. Reply creation and deletion update the stored parent count and repaint the page without a reload. Owners can edit their posts or replies inline; the Worker derives ownership from the session cookie, moderates the proposed replacement, preserves `createdAt`, and writes `updatedAt` plus `edited: true` only after acceptance. Moderators/admins can remove content but cannot edit another author’s words.

In the separate AI workspace, only user messages have **Edit**. **Save & Resend** removes that message’s later conversation, sends the edited history, and regenerates the assistant response. Assistant messages provide **Copy response** and **Regenerate**; fenced code also has its own copy button. Rendering escapes HTML before applying a deliberately small Markdown subset, so model-provided raw HTML is never injected.

The assistant's product identity is **PikApp AI**, made by **PikaStudio** and built into PikApp (which is also made by PikaStudio). Its authoritative identity and capability-honesty system prompt lives in the Worker, not in browser-controlled state. The Worker accepts only `user` and `assistant` conversation roles, validates them, and prepends its trusted `system` message to every request, including histories produced by editing and regeneration.

## Why Workers AI was failing

The production 503 was caused by Cloudflare error 5028: the previously configured Infire Llama model was deprecated on 2026-05-30. The replacement `@cf/qwen/qwen3-30b-a3b-fp8` was verified in the current Cloudflare-generated Workers AI model types shipped with workerd and accepts the documented `{ messages }` chat input. Model configuration is centralized through `AI_MODEL` with the same supported fallback in the Worker. The old chat path treated the AI call as a one-off integration and returned an undifferentiated upstream error, while example environment files incorrectly implied external AI and moderation keys were required. PikApp now resolves a small `CloudflareWorkersAIProvider` from the Wrangler-provisioned `AI` binding and calls `env.AI.run(model, { messages })`. Invalid input, missing/malformed binding, rate limits, and temporary upstream failures receive distinct 400, 500, 429, and 503 responses. Server logs retain diagnostic status/name/message only and public responses never include stacks or secrets. The only required AI credential is Cloudflare’s binding authorization; **no `AI_API_KEY` or `MODERATION_API_KEY` is required**.

## Moderation and spam controls

New posts, replies, and edits require an authenticated, non-banned user, 1–750 characters, no more than three links, and successful automated moderation. New top-level posts additionally use a five-second cooldown and one-hour duplicate check. Rejected new text is **not stored**, and rejected edits leave the previously stored content untouched; only actor ID, timestamp, category/result, and action are audited. Provider failures fail closed. The panel at `/mod.html` shows safe metadata rather than rejected content. Moderators can remove posts and ban users; only admins can unban users or change moderator roles. Every action is re-authorized in the Worker.

## Tests and checks

```bash
npm test
npm run check
```

Tests cover registration/login, Cloudflare-compatible PBKDF2, private email serialization, post/reply creation, reply counts, owner and cross-user edit/delete authorization, moderation rejection with original-content preservation, like/unlike, follow/unfollow, Workers AI success/failure mapping, moderator restrictions, and admin-only actions.

## Deploy method A: terminal / npx Wrangler

These commands match the installed Wrangler 4 configuration:

```bash
npm install
npx wrangler login
npx wrangler whoami
npx wrangler deploy
```

That first deploy automatically creates the KV namespace because the `PIKAPP_KV` entry in `wrangler.jsonc` intentionally has no `id`. Wrangler writes the new namespace ID into the configuration and uses the same namespace on later deploys. **Commit the updated `wrangler.jsonc` after the first deployment** so another device or Cloudflare's Git build does not provision a second namespace:

```bash
git add wrangler.jsonc
git commit -m "Record provisioned PikApp KV namespace"
git push
```

If automatic provisioning is unavailable on an older Wrangler installation, upgrade with `npm install`, or use this manual fallback and paste its returned ID into the `PIKAPP_KV` entry:

```bash
npx wrangler kv namespace create PIKAPP_KV
```

Chat and moderation are enabled by the Workers AI binding in `wrangler.jsonc`; no provider setup or secret commands are needed. Validate locally and deploy updates:

```bash
npx wrangler dev
npm test
npx wrangler deploy
```

Wrangler prints the final URL, normally `https://pikapp.<your-workers-subdomain>.workers.dev`. Future changes deploy with `git pull`, `npm install`, and `npx wrangler deploy`.

## Deploy method B: Android phone + Cloudflare Dashboard

Dashboard labels evolve, but the binding and build values below are exact:

1. In Android Chrome, open `https://dash.cloudflare.com`, sign in, and choose **Workers & Pages**.
2. Choose **Create application** → **Import a repository** (or **Connect to Git**) and authorize GitHub. Select this PikApp repository and branch.
3. Choose a **Workers** deployment, not a Pages-only project. Set the build command to `npm install` (or leave it blank if the dashboard installs dependencies automatically) and deploy command to `npx wrangler deploy`. The root directory is `/`. Wrangler reads `worker/index.js` and the `public/` assets declaration from `wrangler.jsonc`.
4. The first Git deployment should automatically provision the KV namespace from the ID-less `PIKAPP_KV` binding in `wrangler.jsonc`. Check **Storage & Databases** → **KV** for the new namespace and check **Worker Settings** → **Bindings** for the `PIKAPP_KV` binding. If the Dashboard build does not write Wrangler's generated ID back to Git, copy the namespace ID, add `"id": "THE_COPIED_ID"` beside the binding in `wrangler.jsonc` using GitHub's mobile editor, commit, and redeploy. This prevents a later clean build from creating another namespace. As a manual fallback, create the namespace in **Storage & Databases** → **KV** and add it under **Settings** → **Bindings** with the exact variable name `PIKAPP_KV`.
5. Under the Worker's **Settings** → **Bindings**, verify that the Workers AI binding is named `AI`. Wrangler creates it from `wrangler.jsonc`. Do not add Groq, OpenAI, or moderation API-key secrets; none are used. The model names can be changed through the non-secret `AI_MODEL` and `MODERATION_MODEL` variables.
6. Open **Deployments**, select the latest Git commit, and choose **Deploy** or **Retry deployment**. Build logs should show Wrangler uploading the Worker and assets.
7. The application URL appears on the Worker overview and deployment details as `https://pikapp.<your-workers-subdomain>.workers.dev`. Open `/mod.html` for moderation after bootstrapping an admin through the KV viewer.
8. For updates, edit/commit files on GitHub from Chrome. The Git integration automatically creates a new deployment; otherwise open **Deployments** and redeploy the latest commit.

If your account UI offers only **Pages** for Git imports, use **Workers & Pages → Create → Worker → Deploy**, then **Settings → Builds → Connect repository**. Set the same deploy command. A plain Pages project cannot execute `worker/index.js`; it must be a Worker with static assets.

## Troubleshooting

- **KV is not created:** run `npm install` to use the pinned Wrangler 4 release, then deploy again. As a fallback run `npx wrangler kv namespace create PIKAPP_KV`, add its returned `id` to the binding, and redeploy. The binding name must be exactly `PIKAPP_KV`.
- **401:** sign in; cookies must be enabled. Secure session cookies require HTTPS outside local Wrangler development.
- **403:** the account is banned or lacks the backend role required for moderation.
- **429:** wait five seconds or avoid submitting a recent duplicate.
- **AI 500 (binding configuration) or 503 (provider outage):** verify that the Worker's Workers AI binding is named `AI`. The app intentionally does not fake responses.
- **Posts rejected with a service-unavailable audit reason:** check the Workers AI binding and moderation model availability; moderation intentionally fails closed.
- **Static 404:** verify the Worker is deployed from repository root and assets directory remains `./public`.

## MVP limitations

KV list mutations are not atomic and search covers bounded recent records. There are no uploads, DMs, notifications, WebSockets, or realtime features. Avatar uploads are not included: Refresh avatar creates a new privacy-preserving Gravatar identicon seed, which avoids adding R2 or another storage system.
