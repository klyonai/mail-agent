import { createHash } from 'node:crypto';

export const IMAGE_BOUNDS = Object.freeze({ count: 4, fileBytes: 5 * 1024 * 1024, totalBytes: 10 * 1024 * 1024, pixels: 12000000, hardPixels: 20000000 });
export class ImageError extends Error {
  constructor(code = 'IMAGE_INVALID') { super('Image request could not be processed.'); this.name = 'ImageError'; this.code = code; }
}
export function imageFail(code) { throw new ImageError(code); }
export function imageCancelled(signal) { if (signal?.aborted) imageFail('IMAGE_CANCELLED'); }
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function positive(value, maximum) { return Number.isSafeInteger(value) && value > 0 && value <= maximum; }
function dimensions(width, height, maxPixels) {
  if (!positive(width, maxPixels) || !positive(height, maxPixels) || width * height > maxPixels) imageFail('IMAGE_TOO_LARGE');
  return { width, height };
}
function pngHeader(data, maxPixels) {
  if (data.length !== 13) imageFail();
  const colorDepths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!colorDepths[data[9]]?.includes(data[8]) || data[10] !== 0 || data[11] !== 0 || data[12] > 1) imageFail();
  return { ...dimensions(data.readUInt32BE(0), data.readUInt32BE(4), maxPixels), color: data[9] };
}
function pngChunk(bytes, offset) {
  if (offset + 12 > bytes.length) imageFail();
  const length = bytes.readUInt32BE(offset), end = offset + length + 12;
  if (end > bytes.length) imageFail();
  const name = bytes.toString('ascii', offset + 4, offset + 8);
  if (!/^[A-Za-z]{4}$/.test(name) || crc(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) imageFail();
  return { name, data: bytes.subarray(offset + 8, end - 4), end };
}
function pngTransition(state, chunk, maxPixels) {
  const { name, data } = chunk;
  if (['acTL', 'fcTL', 'fdAT'].includes(name)) imageFail('IMAGE_UNSUPPORTED');
  if (name === 'IHDR') {
    if (state.header || state.chunks !== 1) imageFail();
    state.header = pngHeader(data, maxPixels); return;
  }
  if (!state.header) imageFail();
  if (name === 'PLTE') return pngPalette(state, data);
  if (name === 'IDAT') return pngData(state, data);
  if (state.data) state.dataEnded = true;
  if (name === 'IEND') return pngEnd(state, data);
  if (name[0] === name[0].toUpperCase()) imageFail('IMAGE_UNSUPPORTED');
}
function pngEnd(state, data) {
  if (data.length || !state.data) imageFail();
  state.ended = true;
}
function pngPalette(state, data) {
  if (state.palette || state.data || !data.length || data.length % 3 || data.length > 768) imageFail();
  if ([0, 4].includes(state.header.color)) imageFail();
  state.palette = true;
}
function pngData(state, data) {
  if (state.dataEnded || (state.header.color === 3 && !state.palette)) imageFail();
  state.dataBytes += data.length;
  state.data = state.dataBytes > 0;
}
function png(bytes, maxPixels) {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) imageFail();
  const state = { chunks: 0, dataBytes: 0 };
  let offset = 8;
  while (offset < bytes.length && !state.ended) {
    if (++state.chunks > 4096) imageFail();
    const chunk = pngChunk(bytes, offset); pngTransition(state, chunk, maxPixels); offset = chunk.end;
  }
  if (!state.ended || offset !== bytes.length) imageFail();
  return { width: state.header.width, height: state.header.height };
}
function jpegSegment(bytes, offset) {
  if (offset + 2 > bytes.length) imageFail();
  const length = bytes.readUInt16BE(offset), end = offset + length;
  if (length < 2 || end > bytes.length) imageFail();
  return { data: bytes.subarray(offset + 2, end), end };
}
function jpegFrame(data, maxPixels) {
  const components = data[5];
  if (data[0] !== 8 || ![1, 3].includes(components) || data.length !== 6 + 3 * components) imageFail('IMAGE_UNSUPPORTED');
  const componentIds = [];
  for (let offset = 6; offset < data.length; offset += 3) {
    const horizontal = data[offset + 1] >>> 4, vertical = data[offset + 1] & 15;
    if (!horizontal || horizontal > 4 || !vertical || vertical > 4 || data[offset + 2] > 3) imageFail();
    componentIds.push(data[offset]);
  }
  if (new Set(componentIds).size !== components) imageFail();
  return { ...dimensions(data.readUInt16BE(3), data.readUInt16BE(1), maxPixels), components, componentIds };
}
function jpegScan(data, frame) {
  if (!frame || data[0] !== frame.components || data.length !== 4 + 2 * data[0]) imageFail();
  if (data.at(-3) !== 0 || data.at(-2) !== 63 || data.at(-1) !== 0) imageFail('IMAGE_UNSUPPORTED');
  const ids = [];
  for (let offset = 1; offset < data.length - 3; offset += 2) {
    if (!frame.componentIds.includes(data[offset]) || data[offset + 1] >>> 4 > 3 || (data[offset + 1] & 15) > 3) imageFail();
    ids.push(data[offset]);
  }
  if (new Set(ids).size !== frame.components) imageFail();
}
function entropyEnd(bytes, offset) {
  const start = offset;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 255) continue;
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 0 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 && offset === bytes.length && offset - start > 2) return;
    imageFail();
  }
  imageFail();
}
function jpegMarker(state, marker, data, maxPixels) {
  if (marker === 0xc0) {
    if (state.frame) imageFail();
    state.frame = jpegFrame(data, maxPixels); return;
  }
  if (marker === 0xda) { jpegScan(data, state.frame); state.scan = true; return; }
  const metadata = marker >= 0xe0 && marker <= 0xef;
  if (!metadata && ![0xdb, 0xc4, 0xdd, 0xfe].includes(marker)) imageFail('IMAGE_UNSUPPORTED');
}
function jpeg(bytes, maxPixels) {
  if (bytes[0] !== 255 || bytes[1] !== 0xd8) imageFail();
  const state = { segments: 0 }; let offset = 2;
  while (offset < bytes.length && !state.scan) {
    if (++state.segments > 4096 || bytes[offset++] !== 255) imageFail();
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++], segment = jpegSegment(bytes, offset);
    jpegMarker(state, marker, segment.data, maxPixels); offset = segment.end;
  }
  if (!state.scan) imageFail();
  entropyEnd(bytes, offset);
  return { width: state.frame.width, height: state.frame.height };
}

export function validateImage(value, { mediaType, maxBytes = IMAGE_BOUNDS.fileBytes, maxPixels = IMAGE_BOUNDS.pixels } = {}) {
  if (!positive(maxBytes, IMAGE_BOUNDS.fileBytes) || !positive(maxPixels, IMAGE_BOUNDS.hardPixels)) imageFail('IMAGE_INVALID_LIMITS');
  if (!(value instanceof Uint8Array)) imageFail();
  if (!value.length || value.length > maxBytes) imageFail('IMAGE_TOO_LARGE');
  if (!['image/png', 'image/jpeg'].includes(mediaType)) imageFail('IMAGE_UNSUPPORTED');
  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const shape = mediaType === 'image/png' ? png(bytes, maxPixels) : jpeg(bytes, maxPixels);
  return { mediaType, size: bytes.length, ...shape, sha256: createHash('sha256').update(bytes).digest('hex') };
}
