import {join,dirname,basename,resolve} from 'node:path';

export function restoreReservationPath(directory) {
  const root=resolve(directory);
  return join(dirname(root),`.${basename(root)}.restore-incomplete`);
}
