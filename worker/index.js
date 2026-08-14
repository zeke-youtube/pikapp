import MiniSearch from 'minisearch';

const PBKDF2_ITERATIONS = 100_000;
// Verified in the current Cloudflare-generated Workers AI model types shipped with workerd.
const DEFAULT_AI_MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
const error = (message, status = 400) => json({ error: message }, status);
const id = prefix => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
const now = () => Date.now();
const normalizeUsername = value => String(value || '').trim().toLowerCase();
const publicUser = u => ({ id: u.id, username: u.username, displayName: u.displayName, bio: u.bio, avatarHash: u.avatarHash || u.emailHash, showEmail: !!u.showEmail, ...(u.showEmail ? { email: u.email } : {}), role: u.role, banned: !!u.banned, createdAt: u.createdAt });
const parseList = value => value ? JSON.parse(value) : [];
const readJson = async request => { try { return await request.json(); } catch { return null; } };
const get = async (kv, key) => { const v = await kv.get(key); return v ? JSON.parse(v) : null; };
const put = (kv, key, value, options) => kv.put(key, JSON.stringify(value), options);
const updateList = async (kv, key, mutate, max = 500) => { const list = parseList(await kv.get(key)); const next = mutate(list).slice(0, max); await kv.put(key, JSON.stringify(next)); return next; };

async function sha256(value) { const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)); return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join(''); }
async function hashPassword(password, salt = crypto.getRandomValues(new Uint8Array(16)), iterations = PBKDF2_ITERATIONS) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256);
  const enc = b => btoa(String.fromCharCode(...new Uint8Array(b)));
  return `pbkdf2-sha256$${iterations}$${enc(salt)}$${enc(bits)}`;
}
async function verifyPassword(password, stored) {
  const parts = String(stored).split('$'); if (parts.length !== 4) return false;
  const [scheme, rounds, salt, expected] = parts;
  const iterations = Number(rounds);
  if (scheme !== 'pbkdf2-sha256' || !Number.isSafeInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS) return false;
  const bytes = Uint8Array.from(atob(salt), c => c.charCodeAt(0));
  const actual = await hashPassword(password, bytes, iterations); return actual === `${scheme}$${rounds}$${salt}$${expected}`;
}
async function auth(request, env) {
  const cookie = request.headers.get('cookie') || ''; const token = cookie.match(/(?:^|;\s*)pikapp_session=([^;]+)/)?.[1];
  if (!token) return null; const session = await get(env.PIKAPP_KV, `session:${token}`); if (!session || session.expiresAt < now()) return null;
  return get(env.PIKAPP_KV, `user:${session.userId}`);
}
const requireUser = async (request, env) => { const user = await auth(request, env); return !user ? error('Unauthorized', 401) : user.banned ? error('Account suspended', 403) : user; };
const canModerate = u => ['moderator', 'admin'].includes(u?.role);
async function audit(env, actor, action, target, reason) { const event = { id: id('event'), actor: actor?.id || 'system', actorUsername: actor?.username || 'automated', action, target, reason: reason || '', timestamp: now() }; await put(env.PIKAPP_KV, `mod:event:${event.id}`, event); await updateList(env.PIKAPP_KV, 'mod:events', x => [event.id, ...x], 300); }

async function register(request, env) {
  const b = await readJson(request); if (!b) return error('Invalid JSON');
  const username = normalizeUsername(b.username), email = String(b.email || '').trim().toLowerCase(), password = String(b.password || '');
  if (!/^[a-z0-9_]{3,24}$/.test(username)) return error('Username must be 3–24 letters, numbers, or underscores.');
  if (!/^\S+@\S+\.\S+$/.test(email)) return error('A valid email is required.'); if (password.length < 10) return error('Password must be at least 10 characters.');
  if (await env.PIKAPP_KV.get(`username:${username}`)) return error('Username is already taken.', 409);
  const user = { id: id('user'), username, displayName: String(b.displayName || username).trim().slice(0, 50), bio: '', email, emailHash: await sha256(email), showEmail: false, role: 'user', banned: false, passwordHash: await hashPassword(password), createdAt: now() };
  await put(env.PIKAPP_KV, `user:${user.id}`, user); await env.PIKAPP_KV.put(`username:${username}`, user.id); await updateList(env.PIKAPP_KV, 'users:recent', x => [user.id, ...x]);
  return createSession(env, user, 201);
}
async function createSession(env, user, status = 200) { const token = crypto.randomUUID() + crypto.randomUUID(); await put(env.PIKAPP_KV, `session:${token}`, { userId: user.id, expiresAt: now() + 2592000000 }, { expirationTtl: 2592000 }); return json({ user: publicUser(user) }, status, { 'set-cookie': `pikapp_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000` }); }
async function login(request, env) { const b = await readJson(request); const uid = await env.PIKAPP_KV.get(`username:${normalizeUsername(b?.username)}`); const user = uid && await get(env.PIKAPP_KV, `user:${uid}`); if (!user || !(await verifyPassword(String(b?.password || ''), user.passwordHash))) return error('Invalid username or password.', 401); if (user.banned) return error('Account suspended', 403); return createSession(env, user); }
async function postView(env, post, viewer) { const author = await get(env.PIKAPP_KV, `user:${post.authorId}`); const likes = parseList(await env.PIKAPP_KV.get(`post-likes:${post.id}`)); return { ...post, author: publicUser(author), likes: likes.length, liked: !!viewer && likes.includes(viewer.id) }; }
async function moderation(env, content) {
  const lower = content.toLowerCase(); const localFlag = /\b(kill yourself|child porn|rape)\b/.test(lower);
  if (localFlag) return { safe: false, category: 'high-risk-language', result: 'local-rule-match' };
  if (!env.AI) return { safe: false, category: 'service-unavailable', result: 'binding-missing' };
  try {
    const data = await env.AI.run(env.MODERATION_MODEL || '@cf/meta/llama-guard-3-8b', { messages: [{ role: 'user', content }] });
    const result = String(data?.response || '').trim(); const verdict = result.split(/\s+/)[0]?.toLowerCase();
    if (verdict === 'safe') return { safe: true, category: 'none', result: 'safe' };
    if (verdict === 'unsafe') return { safe: false, category: result.split(/\s+/).slice(1).join(',') || 'worker-ai-flagged', result: 'flagged' };
    return { safe: false, category: 'service-unavailable', result: 'invalid-response' };
  } catch { return { safe: false, category: 'service-unavailable', result: 'fail-closed' }; }
}
async function createPost(request, env) {
  const user = await requireUser(request, env); if (user instanceof Response) return user; const b = await readJson(request); const content = String(b?.content || '').trim();
  if (!content || content.length > 750) return error('Posts must contain 1–750 characters.'); if ((content.match(/https?:\/\//gi) || []).length > 3) return error('Posts may contain at most 3 links.');
  const state = await get(env.PIKAPP_KV, `post-state:${user.id}`) || {}; if (now() - (state.at || 0) < 5000) return error('Please wait before posting again.', 429); if (state.hash === await sha256(content.toLowerCase()) && now() - state.at < 3600000) return error('Duplicate post.', 429);
  const mod = await moderation(env, content); if (!mod.safe) { await audit(env, null, 'post_rejected', user.id, `${mod.category}:${mod.result}`); return error('AI flagged your post.\n\nThis post was not published because it was flagged by our automated moderation system.', 422); }
  const post = { id: id('post'), authorId: user.id, content, createdAt: now(), updatedAt: null, edited: false, replyCount: 0 }; await put(env.PIKAPP_KV, `post:${post.id}`, post); await updateList(env.PIKAPP_KV, 'feed:recent', x => [post.id, ...x], 500); await put(env.PIKAPP_KV, `post-state:${user.id}`, { at: now(), hash: await sha256(content.toLowerCase()) }); return json({ post: await postView(env, post, user) }, 201);
}
async function deletePost(request, env, postId, moderator = false) { const user = await requireUser(request, env); if (user instanceof Response) return user; const post = await get(env.PIKAPP_KV, `post:${postId}`); if (!post) return error('Not found', 404); if (post.authorId !== user.id && !canModerate(user)) return error('Forbidden', 403); await env.PIKAPP_KV.delete(`post:${postId}`); await env.PIKAPP_KV.delete(`post-likes:${postId}`); if (post.parentId) { const remaining = await updateList(env.PIKAPP_KV, `post-replies:${post.parentId}`, x => x.filter(v => v !== postId)); const parent = await get(env.PIKAPP_KV, `post:${post.parentId}`); if (parent) { parent.replyCount = remaining.length; await put(env.PIKAPP_KV, `post:${parent.id}`, parent); } } else { await updateList(env.PIKAPP_KV, 'feed:recent', x => x.filter(v => v !== postId)); const replyIds = parseList(await env.PIKAPP_KV.get(`post-replies:${postId}`)); await Promise.all(replyIds.flatMap(replyId => [env.PIKAPP_KV.delete(`post:${replyId}`), env.PIKAPP_KV.delete(`post-likes:${replyId}`)])); await env.PIKAPP_KV.delete(`post-replies:${postId}`); } if (post.authorId !== user.id || moderator) await audit(env, user, 'post_removed', postId); return new Response(null, { status: 204 }); }
async function editPost(request, env, postId) { const user = await requireUser(request, env); if (user instanceof Response) return user; const post = await get(env.PIKAPP_KV, `post:${postId}`); if (!post) return error('Not found', 404); if (post.authorId !== user.id) return error('You can only edit your own content.', 403); const b = await readJson(request), content = String(b?.content || '').trim(); if (!content || content.length > 750) return error('Content must contain 1–750 characters.'); if ((content.match(/https?:\/\//gi) || []).length > 3) return error('Content may contain at most 3 links.'); const mod = await moderation(env, content); if (!mod.safe) { await audit(env, null, 'edit_rejected', postId, `${mod.category}:${mod.result}`); return error('This edit was rejected by automated moderation. Your original content was not changed.', 422); } post.content = content; post.updatedAt = now(); post.edited = true; await put(env.PIKAPP_KV, `post:${post.id}`, post); return json({ post: await postView(env, post, user) }); }
async function feed(request, env) { const viewer = await auth(request, env); const ids = parseList(await env.PIKAPP_KV.get('feed:recent')); const posts = (await Promise.all(ids.slice(0, 60).map(x => get(env.PIKAPP_KV, `post:${x}`)))).filter(Boolean); return json({ posts: await Promise.all(posts.map(p => postView(env, p, viewer))) }); }
async function toggleLike(request, env, postId, add) { const user = await requireUser(request, env); if (user instanceof Response) return user; if (!(await env.PIKAPP_KV.get(`post:${postId}`))) return error('Not found', 404); const likes = await updateList(env.PIKAPP_KV, `post-likes:${postId}`, x => add ? [...new Set([user.id, ...x])] : x.filter(v => v !== user.id)); return json({ likes: likes.length, liked: add }); }
async function replies(request, env, postId) { const parent = await get(env.PIKAPP_KV, `post:${postId}`); if (!parent || parent.parentId) return error('Parent post not found', 404); if (request.method === 'GET') { const viewer = await auth(request, env); const ids = parseList(await env.PIKAPP_KV.get(`post-replies:${postId}`)); const items = (await Promise.all(ids.map(x => get(env.PIKAPP_KV, `post:${x}`)))).filter(Boolean); return json({ replies: await Promise.all(items.map(x => postView(env, x, viewer))) }); } if (request.method !== 'POST') return error('Method not allowed', 405); const user = await requireUser(request, env); if (user instanceof Response) return user; const b = await readJson(request), content = String(b?.content || '').trim(); if (!content || content.length > 750) return error('Replies must contain 1–750 characters.'); if ((content.match(/https?:\/\//gi) || []).length > 3) return error('Replies may contain at most 3 links.'); const mod = await moderation(env, content); if (!mod.safe) return error('This reply was rejected by automated moderation.', 422); const reply = { id: id('reply'), parentId: postId, authorId: user.id, content, createdAt: now(), updatedAt: null, edited: false, replyCount: 0 }; await put(env.PIKAPP_KV, `post:${reply.id}`, reply); const ids = await updateList(env.PIKAPP_KV, `post-replies:${postId}`, x => [...x, reply.id]); parent.replyCount = ids.length; await put(env.PIKAPP_KV, `post:${postId}`, parent); return json({ reply: await postView(env, reply, user), replyCount: ids.length }, 201); }
async function userRoute(request, env, username, action) { const uid = await env.PIKAPP_KV.get(`username:${normalizeUsername(username)}`); const target = uid && await get(env.PIKAPP_KV, `user:${uid}`); if (!target) return error('Not found', 404); if (!action) { const followers = parseList(await env.PIKAPP_KV.get(`followers:${uid}`)); const following = parseList(await env.PIKAPP_KV.get(`following:${uid}`)); const viewer = await auth(request, env); return json({ user: publicUser(target), followers: followers.length, following: following.length, followed: !!viewer && followers.includes(viewer.id) }); } const user = await requireUser(request, env); if (user instanceof Response) return user; if (user.id === uid) return error('You cannot follow yourself.'); const add = request.method === 'POST'; await updateList(env.PIKAPP_KV, `followers:${uid}`, x => add ? [...new Set([user.id, ...x])] : x.filter(v => v !== user.id)); await updateList(env.PIKAPP_KV, `following:${user.id}`, x => add ? [...new Set([uid, ...x])] : x.filter(v => v !== uid)); return json({ followed: add }); }
async function userPosts(request, env, username) {
  const uid = await env.PIKAPP_KV.get(`username:${normalizeUsername(username)}`);
  if (!uid) return error('Not found', 404);
  const url = new URL(request.url), cursor = Math.max(0, Number.parseInt(url.searchParams.get('cursor') || '0', 10) || 0);
  const limit = Math.min(20, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '20', 10) || 20));
  const ids = parseList(await env.PIKAPP_KV.get('feed:recent'));
  const authored = (await Promise.all(ids.map(x => get(env.PIKAPP_KV, `post:${x}`)))).filter(p => p?.authorId === uid && !p.parentId);
  const page = authored.slice(cursor, cursor + limit), viewer = await auth(request, env);
  return json({ posts: await Promise.all(page.map(p => postView(env, p, viewer))), nextCursor: cursor + limit < authored.length ? String(cursor + limit) : null });
}
async function updateSettings(request, env, refreshAvatar = false) {
  const user = await requireUser(request, env); if (user instanceof Response) return user;
  if (refreshAvatar) user.avatarHash = await sha256(crypto.randomUUID());
  else {
    const b = await readJson(request); if (!b) return error('Invalid JSON');
    const username = normalizeUsername(b.username), displayName = String(b.displayName || '').trim(), bio = String(b.bio || '').trim();
    if (!/^[a-z0-9_]{3,24}$/.test(username)) return error('Username must be 3–24 letters, numbers, or underscores.');
    if (!displayName || displayName.length > 50) return error('Display name must contain 1–50 characters.');
    if (bio.length > 160) return error('Bio must be 160 characters or fewer.');
    if (username !== user.username) { if (await env.PIKAPP_KV.get(`username:${username}`)) return error('Username is already taken.', 409); await env.PIKAPP_KV.put(`username:${username}`, user.id); await env.PIKAPP_KV.delete(`username:${user.username}`); }
    user.username = username; user.displayName = displayName; user.bio = bio; user.showEmail = !!b.showEmail;
  }
  await put(env.PIKAPP_KV, `user:${user.id}`, user); return json({ user: publicUser(user) });
}
async function search(request, env, q) { if (!q.trim()) return json({ results: [] }); const userIds = parseList(await env.PIKAPP_KV.get('users:recent')).slice(0, 300), postIds = parseList(await env.PIKAPP_KV.get('feed:recent')).slice(0, 500); const users = (await Promise.all(userIds.map(x => get(env.PIKAPP_KV, `user:${x}`)))).filter(Boolean); const posts = (await Promise.all(postIds.map(x => get(env.PIKAPP_KV, `post:${x}`)))).filter(Boolean); const docs = [...users.map(u => ({ id: `u:${u.id}`, type: 'user', username: u.username, displayName: u.displayName, content: '', boost: 2 })), ...posts.map(p => ({ id: `p:${p.id}`, type: 'post', username: '', displayName: '', content: p.content, boost: 1 }))]; const mini = new MiniSearch({ fields: ['username', 'displayName', 'content'], storeFields: ['type'], searchOptions: { prefix: true, fuzzy: 0.2, boost: { username: 4, displayName: 3, content: 1 } } }); mini.addAll(docs); const hits = mini.search(q).slice(0, 20); const results = await Promise.all(hits.map(async h => h.type === 'user' ? { type: 'user', user: publicUser(users.find(u => `u:${u.id}` === h.id)), score: h.score } : { type: 'post', post: await postView(env, posts.find(p => `p:${p.id}` === h.id), null), score: h.score })); return json({ results }); }
class CloudflareWorkersAIProvider { constructor(binding, model) { this.binding = binding; this.model = model; } async chat(messages) { return this.binding.run(this.model, { messages }); } }
const aiProvider = env => env.AI?.run ? new CloudflareWorkersAIProvider(env.AI, env.AI_MODEL || DEFAULT_AI_MODEL) : null;
async function aiChat(request, env) { const user = await requireUser(request, env); if (user instanceof Response) return user; const provider = aiProvider(env); if (!provider) { console.error('PikApp AI binding missing or invalid'); return error('AI is not configured for this deployment.', 500); } const b = await readJson(request); if (!b || !Array.isArray(b.messages) || !b.messages.length || b.messages.length > 20) return error('Invalid chat request. Send 1–20 messages.', 400); const messages = b.messages.map(m => ({ role: m?.role, content: String(m?.content || '').trim() })); if (messages.some(m => !['user','assistant'].includes(m.role) || !m.content || m.content.length > 4000) || messages.at(-1).role !== 'user') return error('Invalid chat request. Messages must have a valid role and 1–4000 characters, ending with a user message.', 400); try { const data = await provider.chat(messages); const message = String(data?.response || '').trim(); return message ? json({ message }) : error('AI is temporarily unavailable. Please try again.', 503); } catch (cause) { const status = Number(cause?.status || cause?.statusCode); console.error('Workers AI request failed', { status: status || 'unknown', name: cause?.name || 'Error', message: cause?.message || 'No message' }); if (status === 429 || /rate.?limit/i.test(cause?.message || '')) return error('AI rate limit exceeded. Please wait and try again.', 429); return error('AI is temporarily unavailable. Please try again.', 503); } }
async function modRoute(request, env, path) { const actor = await requireUser(request, env); if (actor instanceof Response) return actor; if (!canModerate(actor)) return error('Forbidden', 403); if (path === '/api/mod/events' && request.method === 'GET') { const ids = parseList(await env.PIKAPP_KV.get('mod:events')); return json({ events: (await Promise.all(ids.map(x => get(env.PIKAPP_KV, `mod:event:${x}`)))).filter(Boolean) }); } let m = path.match(/^\/api\/mod\/users\/([^/]+)\/(ban|unban|role)$/); if (m) { const target = await get(env.PIKAPP_KV, `user:${m[1]}`); if (!target) return error('Not found', 404); if (m[2] === 'unban' && actor.role !== 'admin') return error('Admin required', 403); if (m[2] === 'role') { if (actor.role !== 'admin') return error('Admin required', 403); const b = await readJson(request); if (!['user','moderator'].includes(b?.role)) return error('Invalid role'); target.role = b.role; } else target.banned = m[2] === 'ban'; await put(env.PIKAPP_KV, `user:${target.id}`, target); await audit(env, actor, m[2], target.id); return json({ user: publicUser(target) }); } m = path.match(/^\/api\/mod\/posts\/(.+)$/); if (m && request.method === 'DELETE') return deletePost(request, env, m[1], true); return error('Not found', 404); }

export default { async fetch(request, env) {
  const url = new URL(request.url), p = url.pathname; if (!p.startsWith('/api/')) return env.ASSETS.fetch(request);
  if (p === '/api/health' && request.method === 'GET') return json({ status: env.PIKAPP_KV ? 'ok' : 'degraded', kv: env.PIKAPP_KV ? 'configured' : 'missing', aiBinding: env.AI?.run ? 'configured' : 'missing' });
  if (request.method === 'POST' && p === '/api/auth/register') return register(request, env); if (request.method === 'POST' && p === '/api/auth/login') return login(request, env);
  if (request.method === 'POST' && p === '/api/auth/logout') return json({ ok: true }, 200, { 'set-cookie': 'pikapp_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0' }); if (request.method === 'GET' && p === '/api/auth/me') { const u = await auth(request, env); return u ? json({ user: publicUser(u) }) : error('Unauthorized', 401); }
  if (p === '/api/feed' && request.method === 'GET') return feed(request, env); if (p === '/api/posts' && request.method === 'POST') return createPost(request, env);
  let m = p.match(/^\/api\/posts\/([^/]+)(?:\/(like|replies))?$/); if (m) { if (m[2] === 'like' && ['POST','DELETE'].includes(request.method)) return toggleLike(request, env, m[1], request.method === 'POST'); if (m[2] === 'replies') return replies(request, env, m[1]); if (m[2]) return error('Method not allowed', 405); if (request.method === 'DELETE') return deletePost(request, env, m[1]); if (request.method === 'PATCH') return editPost(request, env, m[1]); if (request.method !== 'GET') return error('Method not allowed', 405); const post = await get(env.PIKAPP_KV, `post:${m[1]}`); return post ? json({ post: await postView(env, post, await auth(request, env)) }) : error('Not found', 404); }
  if (p === '/api/settings/profile' && request.method === 'PATCH') return updateSettings(request, env); if (p === '/api/settings/avatar' && request.method === 'POST') return updateSettings(request, env, true);
  m = p.match(/^\/api\/users\/([^/]+)\/posts$/); if (m && request.method === 'GET') return userPosts(request, env, decodeURIComponent(m[1]));
  m = p.match(/^\/api\/users\/([^/]+)(?:\/(follow))?$/); if (m) return userRoute(request, env, decodeURIComponent(m[1]), m[2]); if (p === '/api/search') return search(request, env, url.searchParams.get('q') || ''); if (p === '/api/ai/chat' && request.method === 'POST') return aiChat(request, env); if (p.startsWith('/api/mod/')) return modRoute(request, env, p); return error('Not found', 404);
} };

export const __test = { hashPassword, verifyPassword, publicUser, CloudflareWorkersAIProvider, DEFAULT_AI_MODEL };
