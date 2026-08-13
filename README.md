# PikApp MVP

PikApp is a lightweight, mobile-first social network with a deliberately separate AI chat workspace. The social side supports registration, sessions, text posts and replies, likes, follows, profiles, Gravatar avatars, and ranked Explore search. AI never appears in or modifies the social feed.

## Architecture

- **Frontend:** directly editable HTML, responsive CSS, and small vanilla JavaScript ES modules in `public/`. No build step or framework.
- **Backend:** one Cloudflare Worker in `worker/index.js`, serving REST APIs and static assets.
- **Data:** Cloudflare KV binding named `PIKAPP_KV`, using namespaced keys such as `user:`, `username:`, `session:`, `post:`, `post-likes:`, `followers:`, `following:`, `feed:recent`, and `mod:event:`. KV is eventually consistent; counters and list updates can briefly lag or lose competing writes. This is an intentional MVP tradeoff, not a transactional design.
- **Search:** MiniSearch runs inside the Worker over bounded recent-user/recent-post sets; browsers never download the complete corpus. It can later be replaced behind `/api/search`.
- **Security:** authorization, roles, bans, input validation, spam controls, and moderation all run in the Worker. Passwords use Web Crypto PBKDF2-HMAC-SHA-256 with a random 128-bit salt and 210,000 iterations. Sessions use random opaque, HttpOnly, Secure, SameSite=Lax cookies. Raw email is omitted from public API objects unless `showEmail` is true.

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

Open the URL Wrangler prints (normally `http://localhost:8787`). Wrangler uses local KV storage while developing. For local AI/moderation credentials, copy `.dev.vars.example` to `.dev.vars`; this file is ignored by Git. With no AI credentials, chat clearly returns `AI provider is not configured.` Social posting still uses a small local high-risk rule set. Production deployments should configure the external moderation credential so moderation can fail closed if that service is unavailable.

## Configuration

Required binding:

| Name | Type | Purpose |
|---|---|---|
| `PIKAPP_KV` | KV namespace | users, sessions, posts, relationships, moderation metadata |

Optional variables (non-secret values are in `wrangler.jsonc`):

| Name | Default | Purpose |
|---|---|---|
| `AI_PROVIDER` | `none` | set to `openai-compatible` to enable chat |
| `AI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible endpoint |
| `AI_MODEL` | `gpt-4.1-mini` | configured chat model |
| `MODERATION_MODEL` | `omni-moderation-latest` | optional moderation model |

Optional secrets (never place these in `public/` or Git): `AI_API_KEY` enables chat and `MODERATION_API_KEY` enables provider moderation. They can be separate credentials. Configure them with:

```bash
npx wrangler secret put AI_API_KEY
npx wrangler secret put MODERATION_API_KEY
```

To bootstrap the first admin, register normally, then use the Cloudflare dashboard's KV viewer to edit `user:<id>` and change `"role":"user"` to `"role":"admin"`. Find the ID in `username:<your_username>`. Thereafter admins can manage moderator roles via the protected API. Do not accept roles from registration clients.

## Moderation and spam controls

Posts are checked in order: authenticated/non-banned user, 1–750 character validation, maximum three links, five-second cooldown, one-hour duplicate detection, then automated moderation. Rejected text is **not stored**; only actor ID, timestamp, category/result, and action are audited. Provider failures fail closed. The panel at `/mod.html` shows safe metadata rather than rejected content. Moderators can remove posts and ban users; only admins can unban users or change moderator roles. Every action is re-authorized in the Worker.

## Tests and checks

```bash
npm test
npm run check
```

Tests cover registration, PBKDF2 authentication, private email serialization, authorization, creation/deletion, moderation rejection, like/unlike, follow/unfollow, moderator restrictions, and admin-only actions.

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

Configure desired production secrets after the Worker exists:

```bash
npx wrangler secret put MODERATION_API_KEY
npx wrangler secret put AI_API_KEY
```

To enable chat, change `AI_PROVIDER` from `none` to `openai-compatible` in `wrangler.jsonc`. Validate locally and deploy updates:

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
5. Under the Worker's **Settings** → **Variables and Secrets**, add encrypted secrets `MODERATION_API_KEY` and, if using chat, `AI_API_KEY`. Never add them as plaintext repository variables. Add non-secret variables `AI_PROVIDER=openai-compatible`, `AI_BASE_URL=https://api.openai.com/v1`, and the chosen `AI_MODEL` when enabling chat. If AI remains disabled, keep `AI_PROVIDER=none` and omit `AI_API_KEY`.
6. Open **Deployments**, select the latest Git commit, and choose **Deploy** or **Retry deployment**. Build logs should show Wrangler uploading the Worker and assets.
7. The application URL appears on the Worker overview and deployment details as `https://pikapp.<your-workers-subdomain>.workers.dev`. Open `/mod.html` for moderation after bootstrapping an admin through the KV viewer.
8. For updates, edit/commit files on GitHub from Chrome. The Git integration automatically creates a new deployment; otherwise open **Deployments** and redeploy the latest commit.

If your account UI offers only **Pages** for Git imports, use **Workers & Pages → Create → Worker → Deploy**, then **Settings → Builds → Connect repository**. Set the same deploy command. A plain Pages project cannot execute `worker/index.js`; it must be a Worker with static assets.

## Troubleshooting

- **KV is not created:** run `npm install` to use the pinned Wrangler 4 release, then deploy again. As a fallback run `npx wrangler kv namespace create PIKAPP_KV`, add its returned `id` to the binding, and redeploy. The binding name must be exactly `PIKAPP_KV`.
- **401:** sign in; cookies must be enabled. Secure session cookies require HTTPS outside local Wrangler development.
- **403:** the account is banned or lacks the backend role required for moderation.
- **429:** wait five seconds or avoid submitting a recent duplicate.
- **AI 503:** set `AI_PROVIDER`, `AI_API_KEY`, endpoint, and model. The app intentionally does not fake responses.
- **Posts rejected when moderation is configured:** check provider availability and credentials; the production moderation path fails closed.
- **Static 404:** verify the Worker is deployed from repository root and assets directory remains `./public`.

## MVP limitations

KV list mutations are not atomic and search covers bounded recent records. There are no uploads, DMs, notifications, WebSockets, or realtime features. Profile editing and a richer threaded reply view are intentionally deferred; the stored model already supports bios/email visibility for later authenticated settings UI.
