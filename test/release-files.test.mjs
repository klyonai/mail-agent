import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { writeFileSync, utimesSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readReleaseFiles, readReleaseReview } from '../scripts/release-files.mjs';

const names = ['candidate.json', 'pack.json', 'image.json', 'SHA256SUMS', 'mail-agent-0.1.0.tgz', 'image.tar'];
const message = 'Release files are invalid.';
const hash = (algorithm, bytes, encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
async function fixture(callback) {
  const root = await mkdtemp(join(tmpdir(), 'release-files-test-'));
  await chmod(root, 0o700);
  const data = Object.fromEntries(names.map(name => [name, Buffer.from(name.endsWith('.json') ? '{"synthetic":true}\n' : `synthetic ${name}\n`)]));
  data['image.tar'] = Buffer.alloc(196 * 1024 + 1, 27);
  data['mail-agent-0.1.0.tgz'] = Buffer.alloc(128 * 1024 + 3, 17);
  try {
    for (const name of names) await writeFile(join(root, name), data[name], { mode: 0o600 });
    await callback(root, data);
  } finally { await rm(root, { recursive: true, force: true }); }
}
const denied = promise => assert.rejects(promise, error => error.message === message && !error.cause && !error.code);

test('release reader hashes exactly six private files and buffers only text metadata', async () => {
  await fixture(async (root, data) => {
    const result = await readReleaseFiles(root, names);
    assert.deepEqual(result.hashes, Object.fromEntries(names.map(name => [name, hash('sha256', data[name])])));
    assert.deepEqual(result.sizes, Object.fromEntries(names.map(name => [name, data[name].length])));
    assert.deepEqual(result.contents, Object.fromEntries(names.slice(0, 4).map(name => [name, data[name].toString('utf8')])));
    assert.deepEqual(result.packageDigests, { sha1: hash('sha1', data[names[4]]), sha512: hash('sha512', data[names[4]], 'base64') });
  });
});

test('release reader rejects malformed inventories, missing files and extras with sanitized errors', async () => {
  await fixture(async root => {
    for (const inventory of [null, [], names.slice(1), [...names, names[0]], [names[0], ...names.slice(0, 5)],
      names.map(name => name === 'image.tar' ? '../image.tar' : name), names.map(name => name === 'image.tar' ? '/image.tar' : name),
      names.map(name => name === 'image.tar' ? 'private-secret' : name), names.map(name => name.endsWith('.tgz') ? 'mail-agent-../secret.tgz' : name)]) {
      await denied(readReleaseFiles(root, inventory));
    }
    await writeFile(join(root, 'unexpected-private.txt'), 'private', { mode: 0o600 });
    await denied(readReleaseFiles(root, names));
    await rm(join(root, 'unexpected-private.txt'));
    await rm(join(root, 'candidate.json'));
    await denied(readReleaseFiles(root, names));
  });
});

test('release reader rejects accessible directories and files, symlinks, hardlinks and nonfiles', async () => {
  await fixture(async root => {
    await chmod(root, 0o750); await denied(readReleaseFiles(root, names)); await chmod(root, 0o700);
    const path = join(root, 'image.tar');
    await chmod(path, 0o640); await denied(readReleaseFiles(root, names)); await chmod(path, 0o600);
    const outside = `${root}-link`;
    try {
      await symlink(root, outside); await denied(readReleaseFiles(outside, names)); await rm(outside);
      await link(path, outside); await denied(readReleaseFiles(root, names)); await rm(outside);
      await rename(path, outside); await symlink(outside, path); await denied(readReleaseFiles(root, names));
      await rm(path); await rename(outside, path);
      await rm(path); await mkdir(path, { mode: 0o700 }); await denied(readReleaseFiles(root, names));
    } finally { await rm(outside, { force: true }); }
  });
});

test('release reader enforces separate sparse image/package and metadata/checksum byte limits', async () => {
  for (const [name, limit] of [['image.tar', 1024 ** 3], ['mail-agent-0.1.0.tgz', 32 * 1024 ** 2],
    ['candidate.json', 1024 ** 2], ['pack.json', 1024 ** 2], ['image.json', 1024 ** 2], ['SHA256SUMS', 2048]]) {
    await fixture(async root => {
      await truncate(join(root, name), limit + 1);
      await denied(readReleaseFiles(root, names));
    });
  }
});

test('release reader accepts metadata at its exact bound and rejects invalid UTF-8', async () => {
  await fixture(async root => {
    await writeFile(join(root, 'candidate.json'), 'x'.repeat(1024 ** 2));
    const result = await readReleaseFiles(root, names);
    assert.equal(result.sizes['candidate.json'], 1024 ** 2);
    assert.equal(result.contents['candidate.json'].length, 1024 ** 2);
    await writeFile(join(root, 'pack.json'), Buffer.from([0xc3, 0x28]));
    await denied(readReleaseFiles(root, names));
  });
});

test('release reader fails closed for cancellation before or during bounded reads', async () => {
  await fixture(async root => {
    await denied(readReleaseFiles(root, names, { signal: AbortSignal.abort(new Error('private abort reason')) }));
    let checks = 0;
    const stopAt = 2 + names.length + 1 + 3; // After enumeration and the first streamed chunk.
    const signal = { get aborted() { return ++checks >= stopAt; } };
    await denied(readReleaseFiles(root, names, { signal }));
    assert.ok(checks >= stopAt);
  });
});

test('release reader detects a same-size mutation using explicit metadata changes', async () => {
  await fixture(async (root, data) => {
    let changed = false;
    const path = join(root, 'candidate.json');
    const signal = { get aborted() {
      if (!changed) {
        changed = true;
        writeFileSync(path, Buffer.alloc(data['candidate.json'].length, 0x78));
        utimesSync(path, 1, 2);
      }
      return false;
    } };
    // Change after initial file validation, during streaming, rather than relying on timer or natural mtimes.
    let checks = 0;
    const delayed = { get aborted() { return ++checks === 2 + names.length + 1 + 2 ? signal.aborted : false; } };
    await denied(readReleaseFiles(root, names, { signal: delayed }));
    assert.equal(changed, true);
  });
});


test('release reader detects pathname replacement and extra entries during streaming', async () => {
  for (const replace of [false, true]) await fixture(async root => {
    const original = `${root}-original`;
    let checks = 0;
    const signal = { get aborted() {
      if (++checks === 2 + names.length + 1 + 2) {
        if (replace) {
          // Use a different inode, independent of timestamp resolution.
          writeFileSync(original, 'synthetic replacement');
          renameSync(original, join(root, 'candidate.json'));
        } else writeFileSync(join(root, 'new-entry'), 'synthetic extra');
      }
      return false;
    } };
    try { await denied(readReleaseFiles(root, names, { signal })); }
    finally { await rm(original, { force: true }); }
  });
});

test('release reader rejects a trailing-newline basename even when that file exists', async () => {
  await fixture(async root => {
    const unsafe = 'mail-agent-0.1.0.tgz\n';
    await rename(join(root, 'mail-agent-0.1.0.tgz'), join(root, unsafe));
    await denied(readReleaseFiles(root, names.map(name => name.endsWith('.tgz') ? unsafe : name)));
  });
});

test('release review reads bounded private UTF-8 without interpreting JSON', async () => {
  await fixture(async root => {
    const filename = join(root, 'operator chosen review.json');
    const content = '{"synthetic":"review — complete"}\n';
    await writeFile(filename, content, { mode: 0o600 });
    assert.equal(await readReleaseReview(filename), content);
    await writeFile(filename, 'x'.repeat(64 * 1024));
    assert.equal((await readReleaseReview(filename)).length, 64 * 1024);
    await writeFile(filename, 'not-json');
    assert.equal(await readReleaseReview(filename), 'not-json');
  });
});

test('release review rejects oversize files, permission exposure, links and cancellation', async () => {
  await fixture(async root => {
    const filename = join(root, 'review.json'), second = join(root, 'review-copy.json');
    await writeFile(filename, 'x'.repeat(64 * 1024 + 1), { mode: 0o600 });
    await denied(readReleaseReview(filename));
    await writeFile(filename, '{}');
    await chmod(filename, 0o640); await denied(readReleaseReview(filename)); await chmod(filename, 0o600);
    await link(filename, second); await denied(readReleaseReview(filename)); await rm(second);
    await symlink(filename, second); await denied(readReleaseReview(second));
    await denied(readReleaseReview(filename, { signal: AbortSignal.abort('private-reason') }));
    await denied(readReleaseReview(join(root, 'missing-private-review.json')));
    await denied(readReleaseReview(root));
  });
});

test('release readers sanitize errors from malformed options and option getters', async () => {
  await fixture(async root => {
    const filename = join(root, 'candidate.json');
    for (const options of [null, { get signal() { throw new Error('private option data'); } }]) {
      await denied(readReleaseFiles(root, names, options));
      await denied(readReleaseReview(filename, options));
    }
  });
});

test('release enumeration checks cancellation per entry and rejects within seven entries', async () => {
  await fixture(async root => {
    await writeFile(join(root, 'extra-a'), 'synthetic', { mode: 0o600 });
    await writeFile(join(root, 'extra-b'), 'synthetic', { mode: 0o600 });
    let checks = 0;
    const signal = { get aborted() { checks++; return false; } };
    await denied(readReleaseFiles(root, names, { signal }));
    // Two setup checks precede enumeration; every attempted entry has a cancellation check.
    assert.ok(checks >= 3, 'enumeration must check cancellation before reading entries');
    assert.ok(checks <= 2 + 7, 'reject before attempting more than seven entries');
  });
  await fixture(async root => {
    let checks = 0;
    const signal = { get aborted() { return ++checks === 3; } };
    await denied(readReleaseFiles(root, names, { signal }));
    assert.equal(checks, 3);
  });
});
