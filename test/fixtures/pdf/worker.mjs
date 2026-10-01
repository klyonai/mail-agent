import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const maximum = 32 * 1024 * 1024;
const chunks = [];
let received = 0;
for await (const chunk of process.stdin) {
  received += chunk.length;
  if (received > maximum) process.exit(3);
  chunks.push(chunk);
}

const mode = process.argv[2] ?? 'success';
if (mode === 'hang') {
  setInterval(() => {}, 60_000);
} else if (mode === 'oversized-response') {
  process.stdout.write('x'.repeat(16 * 1024 * 1024));
} else if (mode === 'malformed-json') {
  process.stdout.write('{invalid response}\n');
} else {
  let request;
  try { request = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { process.exit(4); }
  const png = await readFile(fileURLToPath(new URL('../images/synthetic-note.png', import.meta.url)));
  const page = { pageNumber: 1, mediaType: 'image/png', data: png.toString('base64') };
  const response = {
    version: 1, complete: true, jobId: request.jobId, inputSha256: request.inputSha256,
    processorDigest: request.processorDigest, pageCount: 1, encrypted: false, pages: [page],
  };
  if (mode === 'wrong-job') response.jobId = '00000000-0000-4000-8000-000000000001';
  if (mode === 'wrong-input') response.inputSha256 = '0'.repeat(64);
  if (mode === 'wrong-processor') response.processorDigest = '0'.repeat(64);
  if (mode === 'partial') { response.pageCount = 2; }
  if (mode === 'encrypted') { response.encrypted = true; response.pages = []; response.pageCount = 0; }
  if (mode === 'invalid-base64') response.pages[0].data = 'not base64!';
  if (mode === 'too-many-pages') { response.pageCount = 5; }
  process.stdout.write(`${JSON.stringify(response)}\n`);
  if (mode === 'nonzero') process.exitCode = 9;
}
