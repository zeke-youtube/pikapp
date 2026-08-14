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

test('PikaMail application sender claim and real tester remain usable on narrow mobile layouts', async () => {
  const [css, source] = await Promise.all([
    readFile(new URL('../public/css/style.css', import.meta.url), 'utf8'),
    readFile(new URL('../public/js/mail.js', import.meta.url), 'utf8')
  ]);
  assert.match(css, /\.api-email-control\{[^}]*min-width:0/);
  assert.match(css, /@media\(max-width:430px\)\{[^}]*\.api-email-form>button/);
  assert.doesNotMatch(css, /\.developer-tester\{display:none\}/);
  assert.match(source, /Claim API email/);
  assert.match(source, /from\.input\.readOnly=true/);
  assert.match(source, /Claim an API email before sending mail\./);
  assert.doesNotMatch(source, /admin must assign one/);
});
