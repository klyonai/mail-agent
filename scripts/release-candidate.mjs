import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function candidateMetadata(metadata, env) {
  const version = env.RELEASE_VERSION;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?$/.test(version)
      || version !== metadata.version || env.GITHUB_REF_TYPE !== 'tag' || env.GITHUB_REF_NAME !== `v${version}`
      || !/^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? '')) throw new Error('Candidate requires its exact version tag and source commit.');
  return { format: 1, version, tag: env.GITHUB_REF_NAME, sourceCommit: env.GITHUB_SHA,
    node: metadata.engines.node, publication: 'not-published', packagePrivate: metadata.private === true };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const candidate = candidateMetadata(metadata, process.env);
  await mkdir('release', { recursive: true });
  await writeFile('release/candidate.json', `${JSON.stringify(candidate, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}
