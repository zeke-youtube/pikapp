import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('AI and Search controls keep flexible inputs and non-wrapping action buttons', async () => {
  const css = await readFile(new URL('../public/css/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.search-form input\{[^}]*min-width:0;[^}]*flex:1 1 auto/);
  assert.match(css, /\.search-form button\{[^}]*white-space:nowrap;[^}]*flex:0 0 auto/);
  assert.match(css, /\.chat-form textarea\{[^}]*min-width:0;[^}]*flex:1 1 auto/);
  assert.match(css, /\.chat-form>button\{[^}]*white-space:nowrap;[^}]*flex:0 0 auto/);
  assert.doesNotMatch(css, /\.search-form\{flex-wrap:wrap\}/);
});

test('Search uses one native form submission path with mobile keyboard hints', async () => {
  const source = await readFile(new URL('../public/js/search.js', import.meta.url), 'utf8');
  assert.match(source, /<form class="search-form" role="search">/);
  assert.match(source, /type="search" inputmode="search" enterkeyhint="search"/);
  assert.match(source, /<button type="submit">Search<\/button>/);
  assert.match(source, /\.onsubmit=/);
  assert.doesNotMatch(source, /keydown|keyup/);
});
