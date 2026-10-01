import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readReleaseFiles, readReleaseReview } from './release-files.mjs';
import { candidateFileNames, verifyReleaseContract } from './release-contract.mjs';

const message = 'Release candidate verification failed.';

export async function verifyReleaseDirectory(directory, reviewFile, { signal = AbortSignal.timeout(120000) } = {}) {
  try {
    const review = JSON.parse(await readReleaseReview(reviewFile, { signal }));
    const files = await readReleaseFiles(directory, candidateFileNames(review.version), { signal });
    return verifyReleaseContract({ review, hashes: files.hashes, sizes: files.sizes,
      packageDigests: files.packageDigests, checksumText: files.contents.SHA256SUMS,
      candidate: JSON.parse(files.contents['candidate.json']), pack: JSON.parse(files.contents['pack.json']),
      image: JSON.parse(files.contents['image.json']) });
  } catch { throw new Error(message); }
}

export async function runReleaseVerification(args, {
  write = value => process.stdout.write(value), writeError = value => process.stderr.write(value),
} = {}) {
  try {
    const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
      directory: { type: 'string' }, review: { type: 'string' }, help: { type: 'boolean' },
    } });
    if (values.help && args.length === 1) {
      write('node scripts/release-verify.mjs --directory CANDIDATE --review REVIEW.json\nRead-only, offline source-checkout preparation; no publication or approval.\n');
      return 0;
    }
    if (!values.directory || !values.review || values.help) throw new Error(message);
    const manifest = await verifyReleaseDirectory(values.directory, values.review);
    write(`${JSON.stringify(manifest)}\n`);
    return 0;
  } catch { writeError(`${message}\n`); return 1; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runReleaseVerification(process.argv.slice(2));
}
