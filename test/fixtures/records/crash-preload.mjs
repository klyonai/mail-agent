// Test-only synchronization around the shipped adapter's actual filesystem calls.
// No production hook or timeout selects the crash position.
import { promises as filesystem } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { isAbsolute, join } from 'node:path';

Date.now = () => 1_800_000_000_000;

const mode = process.env.RECORDS_CRASH_MODE ?? 'none';
const root = process.env.RECORDS_CRASH_ROOT;
const enabled = ['before-publication', 'after-publication'].includes(mode);
if (enabled && (typeof root !== 'string' || !isAbsolute(root))) throw new Error('Invalid synthetic crash scope.');

async function waitAtBoundary() {
  await new Promise(resolve => process.stderr.write(`RECORDS_CRASH_BOUNDARY:${mode}\n`, resolve));
  await new Promise(() => {});
}

if (enabled) {
  const directory = join(root, 'records', 'record-a');
  const destination = join(directory, 'record.json');
  const originalRename = filesystem.rename, originalOpen = filesystem.open;
  let published = false, reached = false;
  filesystem.rename = async (from, to) => {
    if (to === destination && mode === 'before-publication') await waitAtBoundary();
    const result = await originalRename(from, to);
    if (to === destination) published = true;
    return result;
  };
  filesystem.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] !== directory) return handle;
    const originalSync = handle.sync.bind(handle);
    handle.sync = async () => {
      const result = await originalSync();
      if (published && !reached && mode === 'after-publication') {
        reached = true;
        await waitAtBoundary();
      }
      return result;
    };
    return handle;
  };
  syncBuiltinESMExports();
}
