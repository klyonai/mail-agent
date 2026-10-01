import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePackageLinks } from '../scripts/package-links.mjs';

const message = 'Package documentation links are invalid.';
const check = (text, inventory = ['docs/guide.md', 'README.md']) =>
  validatePackageLinks([{ path: 'docs/guide.md', text }], inventory);

test('package links resolve relative files, URL escapes, queries and directory descendants', () => {
  const documents = [{ path: 'docs/guide.md', text: [
    '[readme](../README.md#usage)', '[space](<operator%20guide.md?mode=local#setup>)',
    '![fixture](../images/note.png "synthetic fixture")', '[recipe](../examples/text-inbox/)',
    '[current](#details)', '[web](https://example.org/reference)', '[contact](mailto:security@example.org)',
  ].join('\n') }];
  const inventory = new Set(['docs/guide.md', 'README.md', 'docs/operator guide.md',
    'images/note.png', 'examples/text-inbox/agent.yaml']);
  assert.deepEqual(validatePackageLinks(documents, inventory), { documents: 1, localLinks: 4 });
  assert.deepEqual(check('[self](?view=local#section)'), { documents: 1, localLinks: 1 });
});

test('empty documents and documents without inline links are valid', () => {
  assert.deepEqual(validatePackageLinks([], []), { documents: 0, localLinks: 0 });
  assert.deepEqual(check('A plain guide and `code`.'), { documents: 1, localLinks: 0 });
});

test('missing files and directories fail without echoing a document or target', () => {
  for (const text of ['[private](private-secret.md)', '[directory](../missing/)',
    '![private](hidden.png)', '[encoded](missing%20file.md)']) {
    assert.throws(() => check(text), error => error.message === message && !error.cause);
  }
});

test('absolute targets, root escapes, unexpected schemes and hostile encoded paths fail closed', () => {
  for (const target of ['/README.md', '//private.example/path', '../../README.md',
    '%2fREADME.md', '%2e%2e/%2e%2e/README.md', 'file:private.txt', 'javascript:alert',
    'data:text/plain,private', 'ftp://example.org/file', 'C:/private/file',
    '..%5cREADME.md', 'guide%00.md', '%GG', 'guide%0a.md']) {
    assert.throws(() => check(`[target](${target})`), { message });
  }
});

test('invalid or excessive inputs fail with the same safe error', () => {
  for (const documents of [null, {}, [{ path: '../guide.md', text: '' }],
    [{ path: 'docs/missing.md', text: '' }], [{ path: 'docs/guide.md', text: null }],
    [{ path: 'docs/guide.md', text: 'x'.repeat(1_048_577) }],
    Array.from({ length: 257 }, () => ({ path: 'docs/guide.md', text: '' }))]) {
    assert.throws(() => validatePackageLinks(documents, ['docs/guide.md']), { message });
  }
  for (const inventory of [null, 'README.md', ['../README.md'], ['/README.md'], ['README.md', 'README.md']]) {
    assert.throws(() => validatePackageLinks([], inventory), { message });
  }
  assert.throws(() => check(`[oversized](${'x'.repeat(4097)})`), { message });
  assert.throws(() => check('[root](../)'), { message });
});
