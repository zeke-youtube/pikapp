import test from 'node:test';
import assert from 'node:assert/strict';
import { destination } from '../public/js/navigation.js';

test('navigation removes post state from unrelated views', () => {
  const fromPost = 'https://pikapp.example/?post=6767';
  assert.equal(destination('home', {}, fromPost), '/');
  assert.equal(destination('profile', {}, fromPost), '/#profile');
  assert.equal(destination('explore', {}, fromPost), '/#explore');
  assert.equal(destination('ai', {}, fromPost), '/#ai');
});

test('navigation creates stable direct post and profile URLs', () => {
  assert.equal(destination('post', { id: 'post_1' }, 'https://pikapp.example/#profile'), '/?post=post_1');
  assert.equal(destination('profile', { username: 'pika_dev' }, 'https://pikapp.example/?post=old'), '/#profile/pika_dev');
  assert.equal(destination('home', {}, 'https://pikapp.example/#explore'), '/');
});
