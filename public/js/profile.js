import { api, escapeHtml, gravatar } from './api.js';
import { me, setMe } from './auth.js';
import { postHtml, bindPosts } from './feed.js';
import { navigate } from './navigation.js';

function settingsHtml(user) {
  return `<details class="profile-settings"><summary>Settings</summary><form id="profile-settings-form">
    <label>Display name<input name="displayName" maxlength="50" required value="${escapeHtml(user.displayName)}"></label>
    <label>Username<input name="username" maxlength="24" pattern="[a-z0-9_]{3,24}" required value="${escapeHtml(user.username)}"></label>
    <label>Bio<textarea name="bio" maxlength="160" placeholder="Tell people about yourself">${escapeHtml(user.bio || '')}</textarea></label>
    <label class="check"><input type="checkbox" name="showEmail" ${user.showEmail ? 'checked' : ''}> Show email on my profile</label>
    <div class="settings-actions"><button type="button" class="quiet" id="refresh-avatar">Refresh avatar</button><button type="submit">Save profile</button></div>
    <p class="form-error" role="alert"></p>
  </form></details>`;
}

export async function renderProfile(root, username, notice) {
  if (!username && !me()) { root.innerHTML = '<p class="empty">Sign in to view your profile.</p>'; return; }
  const requested = username || me().username;
  root.innerHTML = '<div class="profile-loading">Loading profile and posts…</div>';
  try {
    const d = await api(`/api/users/${encodeURIComponent(requested)}`), u = d.user, own = me()?.id === u.id;
    root.innerHTML = `<section class="profile-hero"><img class="avatar" src="${gravatar(u.avatarHash)}" alt="${escapeHtml(u.displayName)}'s profile picture"><h2>${escapeHtml(u.displayName)}</h2><p>@${escapeHtml(u.username)}</p><p>${escapeHtml(u.bio || 'No bio yet.')}</p>${u.email ? `<p>${escapeHtml(u.email)}</p>` : ''}<p><strong>${d.followers}</strong> followers · <strong>${d.following}</strong> following</p>${me() && !own ? `<button id="follow">${d.followed ? 'Unfollow' : 'Follow'}</button>` : ''}${own ? settingsHtml(u) : ''}</section><section class="profile-posts"><h2>Posts</h2><div id="profile-post-list"><div class="post-skeleton">Loading posts…</div></div></section>`;
    root.querySelector('#follow')?.addEventListener('click', async e => { try { const add = e.target.textContent === 'Follow'; await api(`/api/users/${u.username}/follow`, { method: add ? 'POST' : 'DELETE' }); await renderProfile(root, u.username, notice); } catch (x) { notice(x.message); } });
    const form = root.querySelector('#profile-settings-form');
    if (form) form.onsubmit = async event => { event.preventDefault(); const values = new FormData(form), error = form.querySelector('.form-error'), button = form.querySelector('button[type=submit]'); button.disabled = true; error.textContent = ''; try { const { user } = await api('/api/settings/profile', { method: 'PATCH', body: JSON.stringify({ displayName: values.get('displayName'), username: values.get('username'), bio: values.get('bio'), showEmail: values.get('showEmail') === 'on' }) }); setMe(user); notice('Profile saved.'); if (user.username !== requested) navigate('profile', { username: user.username }, { replace: true }); else await renderProfile(root, user.username, notice); } catch (x) { error.textContent = x.message || 'Could not save profile. Please try again.'; } finally { if (button.isConnected) button.disabled = false; } };
    root.querySelector('#refresh-avatar')?.addEventListener('click', e => { const button = e.currentTarget, canonical = gravatar(u.avatarHash), refreshed = gravatar(u.avatarHash, Date.now()); button.disabled = true; document.querySelectorAll('img.avatar').forEach(image => { if (image.src === canonical) image.src = refreshed; }); button.disabled = false; notice('Avatar refreshed.'); });
    let cursor = null;
    const load = async (next = '') => { const data = await api(`/api/users/${encodeURIComponent(u.username)}/posts?limit=20${next ? `&cursor=${encodeURIComponent(next)}` : ''}`), list = root.querySelector('#profile-post-list'); if (!list) return; const markup = data.posts.map(postHtml).join(''); if (!next) list.innerHTML = markup || '<p class="empty">No posts yet.</p>'; else { list.querySelector('[data-load-more]')?.remove(); list.insertAdjacentHTML('beforeend', markup); } cursor = data.nextCursor; if (cursor) list.insertAdjacentHTML('beforeend', '<button class="load-more quiet" data-load-more>Load more</button>'); bindPosts(list, notice, () => renderProfile(root, u.username, notice)); list.querySelector('[data-load-more]')?.addEventListener('click', e => { e.target.disabled = true; load(cursor).catch(x => notice(x.message)); }); };
    await load();
  } catch (e) { root.innerHTML = `<p class="empty">${escapeHtml(e.message)}</p>`; }
}
