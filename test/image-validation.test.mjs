import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validateImage, ImageError } from '../src/image-validation.mjs';

const fixture = name => readFile(new URL(`./fixtures/images/synthetic-note.${name}`, import.meta.url));

test('representative synthetic PNG and JPEG return bounded structural provenance', async () => {
  for (const [extension, mediaType] of [['png', 'image/png'], ['jpg', 'image/jpeg']]) {
    const bytes = await fixture(extension);
    assert.deepEqual(validateImage(bytes, { mediaType }), {
      mediaType, size: bytes.length, width: 128, height: 48,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
});

test('rejects type mismatch, unknown types, malformed input and hard ceilings safely', async () => {
  const png = await fixture('png');
  for (const [bytes, options] of [
    [png, { mediaType: 'image/jpeg' }], [png, { mediaType: 'application/pdf' }],
    [png, { mediaType: 'image/png', maxBytes: png.length - 1 }],
    [png, { mediaType: 'image/png', maxPixels: 128 * 48 - 1 }],
    [png, { mediaType: 'image/png', maxPixels: 20000001 }],
    [png, { mediaType: 'image/png', maxBytes: 5242881 }],
    ['private file contents', { mediaType: 'image/png' }],
  ]) assert.throws(() => validateImage(bytes, options), error => error instanceof ImageError && !String(error).includes('private'));
});

test('PNG rejects corrupt CRC, truncation, trailing bytes, zero dimensions and animation chunks', async () => {
  const png = await fixture('png');
  const corrupt = Buffer.from(png); corrupt[20] ^= 1;
  const zero = Buffer.from(png); zero.writeUInt32BE(0, 16);
  const animated = Buffer.from(png); animated.write('acTL', 12, 'ascii');
  for (const bytes of [corrupt, zero, animated, png.subarray(0, -1), Buffer.concat([png, Buffer.from('hidden')])]) {
    assert.throws(() => validateImage(bytes, { mediaType: 'image/png' }), ImageError);
  }
});

test('JPEG rejects truncation, appended payload, repeated frames and impossible segment lengths', async () => {
  const jpg = await fixture('jpg');
  const badLength = Buffer.from(jpg); badLength.writeUInt16BE(65535, 4);
  const frame = jpg.indexOf(Buffer.from([0xff, 0xc0]));
  const frameLength = jpg.readUInt16BE(frame + 2) + 2;
  const duplicate = Buffer.concat([jpg.subarray(0, frame), jpg.subarray(frame, frame + frameLength), jpg.subarray(frame)]);
  const progressive = Buffer.from(jpg); progressive[frame + 1] = 0xc2;
  const scan = jpg.indexOf(Buffer.from([0xff, 0xda]));
  const badScan = Buffer.from(jpg); badScan[scan + 4] = 1;
  const noEntropy = Buffer.concat([jpg.subarray(0, scan + 2 + jpg.readUInt16BE(scan + 2)), Buffer.from([0xff, 0xd9])]);
  for (const bytes of [badLength, duplicate, progressive, badScan, noEntropy, jpg.subarray(0, -2), Buffer.concat([jpg, Buffer.from('private')])]) {
    assert.throws(() => validateImage(bytes, { mediaType: 'image/jpeg' }), ImageError);
  }
});
