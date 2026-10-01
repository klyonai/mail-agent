import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildTextAttachmentReply, AttachmentReplyError } from '../src/attachment-reply.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const wrap = value => value.match(/.{1,76}/g)?.join('\r\n');
const makeInputs = (overrides = {}) => {
  const bytes = Buffer.from('Synthetic transcript\n');
  return {
    message: { id: 'immutable-message-id', conversationId: 'thread-id', sender: 'reader@example.test',
      replyTo: 'reader@example.test', authenticated: true, subject: 'Synthetic request' },
    bodyText: 'The image says hello.',
    artifact: { bytes, name: 'transcription.txt', contentType: 'text/plain', sha256: hash(bytes), expiresAt: 2000 },
    now: 1000,
    ...overrides,
  };
};

function parseMime(payload) {
  assert.equal(payload.contentType, 'text/plain');
  const mime = Buffer.from(payload.body, 'base64').toString('utf8');
  const boundary = mime.match(/boundary="([^"]+)"/)?.[1];
  assert.ok(boundary);
  return { mime, boundary };
}

function decodeSubject(mime) {
  const folded = mime.match(/^Subject: ([^\r\n]*(?:\r\n [^\r\n]*)*)/m)?.[1]?.replace(/\r\n /g, '');
  assert.ok(folded);
  return folded.replace(/=\?UTF-8\?B\?([^?]+)\?=/g, (_, encoded) => Buffer.from(encoded, 'base64').toString('utf8'));
}

test('builds bounded direct-thread MIME reply with exact text artifact and provenance hashes', () => {
  const input = makeInputs();
  const payload = buildTextAttachmentReply(input);
  assert.equal(payload.recipient, 'reader@example.test');
  assert.equal(payload.inReplyTo, 'immutable-message-id');
  assert.equal(payload.conversationId, 'thread-id');
  assert.deepEqual(payload.artifact, { name: 'transcription.txt', contentType: 'text/plain',
    size: input.artifact.bytes.length, sha256: input.artifact.sha256 });
  assert.equal(payload.payloadSha256, hash(Buffer.from(payload.body, 'base64')));
  const { mime, boundary } = parseMime(payload);
  assert.match(mime, /To: reader@example\.test\r\n/);
  assert.match(mime, /Subject: Re: Synthetic request\r\n/);
  assert.match(mime, /Content-Disposition: attachment; filename="transcription\.txt"/);
  assert.ok(mime.includes(Buffer.from('The image says hello.').toString('base64')));
  assert.ok(mime.includes(input.artifact.bytes.toString('base64')));
  assert.match(mime, new RegExp(`--${boundary}--\\r\\n$`));
});

test('input mutation after construction does not change the serialized payload', () => {
  const input = makeInputs();
  const payload = buildTextAttachmentReply(input);
  input.artifact.bytes.fill(0);
  assert.ok(Buffer.from(payload.body, 'base64').toString('utf8').includes(wrap(Buffer.from('Synthetic transcript\n').toString('base64'))));
});

test('identical intent produces identical MIME while changes to body, file or thread change its hash', () => {
  const input = makeInputs();
  const first = buildTextAttachmentReply(input);
  assert.deepEqual(buildTextAttachmentReply(input), first);
  for (const changed of [
    { ...input, bodyText: 'A changed answer.' },
    { ...input, artifact: { ...input.artifact, bytes: Buffer.from('Changed file.\n'), sha256: hash(Buffer.from('Changed file.\n')) } },
    { ...input, message: { ...input.message, conversationId: 'other-thread' } },
  ]) assert.notEqual(buildTextAttachmentReply(changed).payloadSha256, first.payloadSha256);
});

test('encodes and folds non-ASCII subject headers within MIME line bounds', () => {
  const subject = 'Grüße aus Köln – ' + 'ä'.repeat(80);
  const payload = buildTextAttachmentReply(makeInputs({ message: { ...makeInputs().message, subject } }));
  const { mime } = parseMime(payload);
  assert.equal(decodeSubject(mime), `Re: ${subject}`);
  assert.match(mime, /Subject: Re: =\?UTF-8\?B\?/);
  assert.ok([...mime.matchAll(/=\?UTF-8\?B\?[^?]+\?=/g)].every(([word]) => word.length <= 75));
  assert.ok(mime.split('\r\n').every(line => Buffer.byteLength(line) <= 998));
});

test('rejects changed artifact hashes, non-text media and expired artifacts', () => {
  const valid = makeInputs();
  assert.throws(() => buildTextAttachmentReply({ ...valid, artifact: { ...valid.artifact, sha256: '0'.repeat(64) } }), AttachmentReplyError);
  assert.throws(() => buildTextAttachmentReply({ ...valid, artifact: { ...valid.artifact, contentType: 'image/png' } }), AttachmentReplyError);
  assert.throws(() => buildTextAttachmentReply({ ...valid, now: valid.artifact.expiresAt }), AttachmentReplyError);
});

test('rejects missing authenticated identity, changed reply destination and missing thread binding', () => {
  const valid = makeInputs();
  for (const message of [
    { ...valid.message, authenticated: false },
    { ...valid.message, replyTo: 'elsewhere@example.test' },
    { ...valid.message, id: '' },
    { ...valid.message, conversationId: '' },
  ]) assert.throws(() => buildTextAttachmentReply({ ...valid, message }), AttachmentReplyError);
});

test('rejects unsafe filename, invalid UTF-8, control bytes and oversized inputs', () => {
  const valid = makeInputs();
  for (const name of ['../transcription.txt', 'note.pdf', 'x\r\nBcc: bad@example.test.txt', '']) {
    assert.throws(() => buildTextAttachmentReply({ ...valid, artifact: { ...valid.artifact, name } }), AttachmentReplyError);
  }
  for (const bytes of [Buffer.from([0xff]), Buffer.from('hello\0world')]) {
    assert.throws(() => buildTextAttachmentReply({ ...valid, artifact: { ...valid.artifact, bytes, sha256: hash(bytes) } }), AttachmentReplyError);
  }
  assert.throws(() => buildTextAttachmentReply({ ...valid, maxBytes: 4 }), AttachmentReplyError);
  assert.throws(() => buildTextAttachmentReply({ ...valid, bodyText: 'long', maxBodyBytes: 3 }), AttachmentReplyError);
});

test('does not mutate inputs and reports only fixed validation errors', () => {
  const valid = makeInputs();
  const before = structuredClone({ ...valid, artifact: { ...valid.artifact, bytes: valid.artifact.bytes.toString('base64') } });
  assert.throws(() => buildTextAttachmentReply({ ...valid, message: { ...valid.message, subject: 'x\r\nBcc: hidden@example.test' } }), error => {
    assert.ok(error instanceof AttachmentReplyError);
    assert.equal(error.message, 'Attachment reply request is invalid.');
    assert.doesNotMatch(JSON.stringify(error), /hidden|Synthetic transcript|reader@example/);
    return true;
  });
  assert.equal(valid.artifact.bytes.toString('base64'), before.artifact.bytes);
});
