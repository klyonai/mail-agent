import test from 'node:test';
import assert from 'node:assert/strict';
import { runReleaseVerification } from '../scripts/release-verify.mjs';

test('release verifier help is source-only and has no publication action', async () => {
  const output = [], errors = [];
  const result = await runReleaseVerification(['--help'], {
    write: value => output.push(value), writeError: value => errors.push(value),
  });
  assert.equal(result, 0);
  assert.match(output.join(''), /--directory CANDIDATE --review REVIEW.json/);
  assert.match(output.join(''), /Read-only, offline/);
  assert.equal(errors.length, 0);
});

test('release verifier rejects missing, unknown and private input without leaking it', async () => {
  for (const args of [[], ['--directory'], ['--publish'], ['--review', '/synthetic/private-secret.json'],
    ['--directory', '/synthetic/private-candidate', '--review', '/synthetic/private-secret.json']]) {
    const output = [], errors = [];
    const result = await runReleaseVerification(args, {
      write: value => output.push(value), writeError: value => errors.push(value),
    });
    assert.equal(result, 1);
    assert.equal(output.length, 0);
    assert.equal(errors.join(''), 'Release candidate verification failed.\n');
  }
});
