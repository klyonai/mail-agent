import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidateFileNames, verifyReleaseContract } from '../scripts/release-contract.mjs';
import { verifyReleaseDirectory } from '../scripts/release-verify.mjs';

const metadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function fixture() {
  const version = '0.1.0', sourceCommit = 'a'.repeat(40), imageId = `sha256:${'b'.repeat(64)}`;
  const names = candidateFileNames(version);
  const checksums = Object.fromEntries(names.filter(name => name !== 'SHA256SUMS').map(name => [name, 'c'.repeat(64)]));
  const files = [...new Set(['package.json', 'README.md', 'LICENSE', 'src/cli.mjs',
    ...metadata.files.filter(name => name !== 'src/*.mjs')])].map(path => ({ path, size: 1, mode: 0o644 }));
  const pack = [{ id: 'mail-agent@0.1.0', name: 'mail-agent', version, size: 256,
    unpackedSize: files.length, filename: 'mail-agent-0.1.0.tgz', shasum: 'd'.repeat(40),
    integrity: `sha512-${Buffer.alloc(64).toString('base64')}`, files, entryCount: files.length, bundled: [] }];
  const candidate = { format: 1, version, tag: `v${version}`, sourceCommit, node: '>=24.21.0 <25',
    publication: 'not-published', packagePrivate: true };
  const review = { format: 1, repository: 'example/mail-agent', version, sourceCommit,
    node: candidate.node, imageId, platform: 'linux/amd64', checksums };
  const image = [{ Id: imageId, Os: 'linux', Architecture: 'amd64', Config: { User: '1000:1000',
    Labels: { 'org.opencontainers.image.revision': sourceCommit, 'org.opencontainers.image.version': version } } }];
  const hashes = { ...checksums, SHA256SUMS: 'e'.repeat(64) };
  const sizes = Object.fromEntries(names.map(name => [name, name.endsWith('.tgz') ? 256 : 128]));
  return { review, candidate, pack, image, hashes, sizes,
    checksumText: Object.entries(checksums).map(([name, hash]) => `${hash}  ${name}\n`).join(''),
    packageDigests: { sha1: pack[0].shasum, sha512: Buffer.alloc(64).toString('base64') } };
}

test('release verification binds reviewed bytes and metadata without granting publication authority', () => {
  const value = fixture(), result = verifyReleaseContract(value);
  assert.equal(result.status, 'prepared-not-approved');
  assert.equal(result.offline, true);
  assert.equal(result.repository, value.review.repository);
  assert.equal(result.imageId, value.review.imageId);
  assert.equal(result.image, 'ghcr.io/example/mail-agent:0.1.0');
  assert.equal(result.files.length, 6);
  assert.match(result.manifestDigest, /^[a-f0-9]{64}$/);
  assert.equal(result.liveProvenanceVerified, false);
  assert.equal(result.savedImageIdentityVerified, false);
  assert.equal(result.publicationApproved, false);
  assert.equal(result.publicationVerified, false);
  const reordered = fixture();
  reordered.review.checksums = Object.fromEntries(Object.entries(reordered.review.checksums).reverse());
  assert.deepEqual(verifyReleaseContract(reordered), result);
});

test('review identity rejects unsupported nodes, unsafe destinations, missing or unknown fields', () => {
  for (const update of [{ format: 2 }, { repository: 'EXAMPLE/mail-agent' }, { repository: '../mail-agent' },
    { version: '$(print-secret)' }, { version: '01.1.0' }, { version: '0.1.0-01' },
    { version: '9007199254740992.1.0' }, { node: '>=24.9007199254740992.0 <25' },
    { sourceCommit: 'a'.repeat(39) }, { imageId: '../image' }, { node: '>=23 <25' },
    { platform: 'windows/amd64' }, { approved: true }]) {
    const value = fixture(); Object.assign(value.review, update);
    assert.throws(() => verifyReleaseContract(value), /Release candidate verification failed\./);
  }
  const missing = fixture(); delete missing.review.sourceCommit;
  assert.throws(() => verifyReleaseContract(missing));
});

test('artifact mutations and checksum ambiguity fail closed', () => {
  const mutations = [
    value => { value.hashes['image.tar'] = 'f'.repeat(64); },
    value => { delete value.review.checksums['image.tar']; },
    value => { value.review.checksums['private.env'] = 'c'.repeat(64); },
    value => { value.checksumText += value.checksumText.split('\n')[0] + '\n'; },
    value => { value.checksumText = value.checksumText.replace('image.tar', '../image.tar'); },
    value => { value.checksumText = value.checksumText.replace('  image.tar', ' *image.tar'); },
    value => { value.packageDigests.sha1 = 'f'.repeat(40); },
    value => { value.packageDigests.sha512 = Buffer.alloc(64, 1).toString('base64'); },
    value => { value.sizes['mail-agent-0.1.0.tgz']++; },
    value => { value.hashes['extra.json'] = 'f'.repeat(64); },
  ];
  for (const mutate of mutations) {
    const value = fixture(); mutate(value);
    assert.throws(() => verifyReleaseContract(value), /Release candidate verification failed\./);
  }
});

test('candidate, package and declared image must agree with the exact reviewed identity', () => {
  const mutations = [
    value => { value.candidate.sourceCommit = 'f'.repeat(40); },
    value => { value.candidate.tag = 'v0.1.1'; },
    value => { value.candidate.packagePrivate = false; },
    value => { value.candidate.publication = 'published'; },
    value => { value.candidate.secret = 'synthetic-private-value'; },
    value => { value.pack.push(value.pack[0]); },
    value => { value.pack[0].version = '0.1.1'; },
    value => { value.pack[0].files[0].path = '../private.env'; },
    value => { value.pack[0].files.push({ path: 'private.env', size: 1, mode: 0o644 }); },
    value => { value.pack[0].files[0].mode = 0o4755; },
    value => { value.pack[0].unpackedSize++; },
    value => { value.image[0].Id = `sha256:${'f'.repeat(64)}`; },
    value => { value.image[0].Architecture = 'arm64'; },
    value => { value.image[0].Architecture = ['amd64']; },
    value => { value.image[0].Os = ['linux']; },
    value => { value.image[0].Config.User = 'root'; },
    value => { value.image[0].Config.Labels['org.opencontainers.image.revision'] = 'f'.repeat(40); },
  ];
  for (const mutate of mutations) {
    const value = fixture(); mutate(value);
    assert.throws(() => verifyReleaseContract(value), /Release candidate verification failed\./);
  }
});

test('offline directory verification composes actual file reads, digests and metadata without changing bytes', async () => {
  const value = fixture(), root = await mkdtemp(join(tmpdir(), 'release-verifier-test-'));
  const directory = join(root, 'candidate'), reviewFile = join(root, 'review.json');
  try {
    await chmod(root, 0o700); await mkdir(directory, { mode: 0o700 });
    const tarball = Buffer.alloc(256, 17), image = Buffer.alloc(32, 23);
    value.pack[0].shasum = createHash('sha1').update(tarball).digest('hex');
    value.pack[0].integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
    // Synthetic archive bytes test composition only; layout/load qualification stays explicitly false.
    const bytes = { 'candidate.json': Buffer.from(JSON.stringify(value.candidate)),
      'pack.json': Buffer.from(JSON.stringify(value.pack)), 'image.json': Buffer.from(JSON.stringify(value.image)),
      'mail-agent-0.1.0.tgz': tarball, 'image.tar': image };
    value.review.checksums = Object.fromEntries(Object.entries(bytes).map(([name, data]) =>
      [name, createHash('sha256').update(data).digest('hex')]));
    bytes.SHA256SUMS = Buffer.from(Object.entries(value.review.checksums).map(([name, hash]) => `${hash}  ${name}\n`).join(''));
    for (const [name, data] of Object.entries(bytes)) await writeFile(join(directory, name), data, { mode: 0o600 });
    await writeFile(reviewFile, JSON.stringify(value.review), { mode: 0o600 });
    const result = await verifyReleaseDirectory(directory, reviewFile);
    assert.equal(result.status, 'prepared-not-approved');
    assert.equal(result.archiveLayoutVerified, false);
    assert.equal(result.savedImageIdentityVerified, false);
    for (const [name, data] of Object.entries(bytes)) assert.deepEqual(await readFile(join(directory, name)), data);
    await writeFile(join(directory, 'image.tar'), Buffer.alloc(32, 24));
    await assert.rejects(verifyReleaseDirectory(directory, reviewFile), { message: 'Release candidate verification failed.' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
