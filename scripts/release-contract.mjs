import { createHash } from 'node:crypto';
import { validatePackageContents } from './package-contract.mjs';

const message = 'Release candidate verification failed.';
const sha256 = /^[a-f0-9]{64}$/;
const candidateKeys = ['format', 'version', 'tag', 'sourceCommit', 'node', 'publication', 'packagePrivate'];
const reviewKeys = ['format', 'repository', 'version', 'sourceCommit', 'node', 'platform', 'imageId', 'checksums'];

function deny() { throw new Error(message); }
function sameKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\n') === [...keys].sort().join('\n');
}
function requireKeys(value, keys) { if (!sameKeys(value, keys)) deny(); }

function validVersion(value) {
  if (typeof value !== 'string' || value.length > 64) return false;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*))?$/.exec(value);
  if (!match || match.slice(1, 4).some(part => !Number.isSafeInteger(Number(part)))) return false;
  return !match[4]?.split('.').some(label => /^\d+$/.test(label) && /^0\d/.test(label));
}

export function candidateFileNames(version) {
  if (!validVersion(version)) deny();
  return ['candidate.json', 'image.json', 'image.tar', `mail-agent-${version}.tgz`, 'pack.json', 'SHA256SUMS'];
}

function validNode(value) {
  if (typeof value !== 'string' || value.length > 40) return false;
  const match = /^>=24\.(0|[1-9]\d*)\.(0|[1-9]\d*) <25$/.exec(value);
  return Boolean(match && Number.isSafeInteger(Number(match[1]))
    && Number.isSafeInteger(Number(match[2])) && Number(match[1]) >= 21);
}

function reviewIdentity(review) {
  requireKeys(review, reviewKeys);
  if (review.format !== 1 || !validVersion(review.version) || !validNode(review.node)) deny();
  if (typeof review.repository !== 'string'
      || !/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9._-]{0,99}$/.test(review.repository)) deny();
  if (typeof review.sourceCommit !== 'string' || !/^[a-f0-9]{40}$/.test(review.sourceCommit)) deny();
  if (typeof review.imageId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(review.imageId)) deny();
  if (!['linux/amd64', 'linux/arm64'].includes(review.platform)) deny();
  const names = candidateFileNames(review.version), checked = names.filter(name => name !== 'SHA256SUMS');
  requireKeys(review.checksums, checked);
  if (checked.some(name => !sha256.test(review.checksums[name]))) deny();
  return names;
}

function checksumEntries(text, names) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 2048 || !text.endsWith('\n')) deny();
  const lines = text.slice(0, -1).split('\n'), result = {};
  if (lines.length !== names.length) deny();
  for (const line of lines) {
    const match = /^([a-f0-9]{64}) {2}([A-Za-z0-9._-]+)$/.exec(line);
    if (!match || !names.includes(match[2]) || Object.hasOwn(result, match[2])) deny();
    result[match[2]] = match[1];
  }
  return result;
}

function verifyHashes(input, names) {
  requireKeys(input.hashes, names); requireKeys(input.sizes, names);
  const checked = names.filter(name => name !== 'SHA256SUMS');
  const declared = checksumEntries(input.checksumText, checked);
  for (const name of names) {
    if (!sha256.test(input.hashes[name]) || !Number.isSafeInteger(input.sizes[name]) || input.sizes[name] <= 0) deny();
  }
  for (const name of checked) {
    if (input.hashes[name] !== declared[name] || declared[name] !== input.review.checksums[name]) deny();
  }
}

function verifyCandidate(candidate, review) {
  requireKeys(candidate, candidateKeys);
  for (const key of ['version', 'sourceCommit', 'node']) if (candidate[key] !== review[key]) deny();
  if (candidate.format !== 1 || candidate.tag !== `v${review.version}`
      || candidate.publication !== 'not-published' || candidate.packagePrivate !== true) deny();
}

function singleRecord(value) {
  if (!Array.isArray(value) || value.length !== 1 || value[0] === null
      || typeof value[0] !== 'object' || Array.isArray(value[0])) deny();
  return value[0];
}

function verifyPackageIdentity(pack, review, sizes, digests) {
  if (pack.name !== 'mail-agent' || pack.version !== review.version || pack.id !== `mail-agent@${review.version}`
      || pack.filename !== `mail-agent-${review.version}.tgz`) deny();
  requireKeys(digests, ['sha1', 'sha512']);
  if (!/^[a-f0-9]{40}$/.test(digests.sha1 ?? '') || !/^[A-Za-z0-9+/]{86}==$/.test(digests.sha512 ?? '')) deny();
  if (pack.shasum !== digests.sha1 || pack.integrity !== `sha512-${digests.sha512}`
      || pack.size !== sizes[pack.filename]) deny();
}

function verifyPackageFiles(pack) {
  if (!Array.isArray(pack.files) || pack.files.length > 256
      || !Array.isArray(pack.bundled) || pack.bundled.length) deny();
  const sources = pack.files.filter(file => /^src\/[a-z0-9-]+\.mjs$/.test(file?.path ?? '')).map(file => file.path.slice(4));
  const summary = validatePackageContents(pack.files, sources);
  for (const file of pack.files) {
    if (!Number.isSafeInteger(file.mode) || file.mode < 0 || file.mode > 0o777 || (file.mode & 0o022)) deny();
  }
  if (pack.entryCount !== summary.files || pack.unpackedSize !== summary.unpackedBytes) deny();
}

function verifyImage(image, review) {
  if (image.Os !== 'linux' || !['amd64', 'arm64'].includes(image.Architecture)) deny();
  if (image.Id !== review.imageId || `${image.Os}/${image.Architecture}` !== review.platform
      || image.Config?.User !== '1000:1000') deny();
  const labels = image.Config.Labels;
  if (labels?.['org.opencontainers.image.revision'] !== review.sourceCommit
      || labels?.['org.opencontainers.image.version'] !== review.version) deny();
}

function reviewManifest(input, names) {
  const { review } = input;
  const result = { format: 1, status: 'prepared-not-approved', offline: true,
    repository: review.repository, version: review.version, tag: `v${review.version}`,
    sourceCommit: review.sourceCommit, node: review.node, platform: review.platform,
    imageId: review.imageId, image: `ghcr.io/${review.repository}:${review.version}`,
    files: names.map(name => ({ name, bytes: input.sizes[name], sha256: input.hashes[name] })),
    liveProvenanceVerified: false, archiveLayoutVerified: false, savedImageIdentityVerified: false,
    publicationApproved: false, publicationVerified: false };
  return { ...result, manifestDigest: createHash('sha256').update(JSON.stringify(result)).digest('hex') };
}

export function verifyReleaseContract(input) {
  try {
    const names = reviewIdentity(input.review);
    verifyHashes(input, names); verifyCandidate(input.candidate, input.review);
    const pack = singleRecord(input.pack);
    verifyPackageIdentity(pack, input.review, input.sizes, input.packageDigests);
    verifyPackageFiles(pack); verifyImage(singleRecord(input.image), input.review);
    return reviewManifest(input, names);
  } catch { deny(); }
}
