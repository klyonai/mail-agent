import { createHash } from 'node:crypto';

const MAX_ATTACHMENT_BYTES = 2_000_000;
const MAX_BODY_BYTES = 64_000;
const filenamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.txt$/;
const addressPattern = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,63}$/i;

export class AttachmentReplyError extends Error {
  constructor() {
    super('Attachment reply request is invalid.');
    this.name = 'AttachmentReplyError';
    this.code = 'invalid-attachment-reply';
  }
}

function invalid() { throw new AttachmentReplyError(); }

function bytesOf(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) invalid();
  return Buffer.from(value);
}

function validIdentifier(value) { return typeof value === 'string' && value.length > 0 && value.length <= 512; }

function hasHeaderControl(value) {
  return [...value].some(character => {
    const code = character.codePointAt(0);
    return code < 32 || code === 127;
  });
}

function validateIdentity(message) {
  if (!message || !validIdentifier(message.id) || !validIdentifier(message.conversationId)
    || message.authenticated !== true || typeof message.sender !== 'string' || !addressPattern.test(message.sender)) invalid();
  const recipient = message.sender.toLowerCase();
  if (message.replyTo !== undefined && (typeof message.replyTo !== 'string' || message.replyTo.toLowerCase() !== recipient)) invalid();
  return recipient;
}

function validateSubject(message) {
  const subject = message.subject ?? '';
  if (typeof subject !== 'string' || Buffer.byteLength(subject) > 512 || hasHeaderControl(subject)) invalid();
  return subject;
}

function validateMessage(message) {
  return { recipient: validateIdentity(message), subject: validateSubject(message) };
}

function validateText(value, maxBytes) {
  if (typeof value !== 'string' || value.includes('\u0000')) invalid();
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.toString('utf8') !== value || bytes.byteLength > maxBytes) invalid();
  return bytes;
}

function validateArtifactMetadata(artifact, now) {
  if (!artifact || artifact.contentType !== 'text/plain' || typeof artifact.name !== 'string'
    || !filenamePattern.test(artifact.name) || !Number.isSafeInteger(artifact.expiresAt) || artifact.expiresAt <= now
    || typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(artifact.sha256)) invalid();
}

function validateArtifact(artifact, now, maxBytes) {
  validateArtifactMetadata(artifact, now);
  const bytes = bytesOf(artifact.bytes);
  if (!bytes.length || bytes.length > maxBytes) invalid();
  if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256.toLowerCase()) invalid();
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) invalid();
  if (text.includes('\u0000')) invalid();
  return { bytes, name: artifact.name };
}

function wrapBase64(value) {
  return value.match(/.{1,76}/g)?.join('\r\n') ?? '';
}

function hasNonAscii(value) { return [...value].some(character => character.codePointAt(0) > 127); }

function encodeSubject(value) {
  if (!hasNonAscii(value)) return value;
  const chunks = [];
  let chunk = '';
  let size = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (size + bytes > 42) {
      chunks.push(chunk);
      chunk = '';
      size = 0;
    }
    chunk += character;
    size += bytes;
  }
  if (chunk) chunks.push(chunk);
  return chunks.map(part => `=?UTF-8?B?${Buffer.from(part, 'utf8').toString('base64')}?=`).join('\r\n ');
}

function deterministicBoundary({ message, recipient, subject, bodyBytes, artifact }) {
  const intent = [message.id, message.conversationId, recipient, subject,
    createHash('sha256').update(bodyBytes).digest('hex'), artifact.name, artifact.sha256.toLowerCase()];
  return `mail-agent-${createHash('sha256').update(JSON.stringify(intent)).digest('hex').slice(0, 42)}`;
}

function mimeMessage({ boundary, recipient, subject, bodyBytes, artifactBytes, filename }) {
  const body = wrapBase64(bodyBytes.toString('base64'));
  const attachment = wrapBase64(artifactBytes.toString('base64'));
  return [
    `To: ${recipient}`,
    `Subject: Re: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    'Content-Transfer-Encoding: base64',
    '',
    attachment,
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

/** Create a bounded direct-thread MIME reply. This pure helper performs no file or network IO. */
export function buildTextAttachmentReply({ message, bodyText, artifact, now = Date.now(), maxBytes = MAX_ATTACHMENT_BYTES,
  maxBodyBytes = MAX_BODY_BYTES } = {}) {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_ATTACHMENT_BYTES
    || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > MAX_BODY_BYTES) invalid();
  const { recipient, subject } = validateMessage(message);
  const bodyBytes = validateText(bodyText, maxBodyBytes);
  const checkedArtifact = validateArtifact(artifact, now, maxBytes);
  const boundary = deterministicBoundary({ message, recipient, subject, bodyBytes, artifact: { ...artifact, sha256: createHash('sha256').update(checkedArtifact.bytes).digest('hex') } });
  const mime = Buffer.from(mimeMessage({ boundary, recipient, subject, bodyBytes,
    artifactBytes: checkedArtifact.bytes, filename: checkedArtifact.name }), 'utf8');
  const payload = mime.toString('base64');
  return {
    contentType: 'text/plain', body: payload,
    recipient, inReplyTo: message.id, conversationId: message.conversationId,
    artifact: { name: checkedArtifact.name, contentType: 'text/plain', size: checkedArtifact.bytes.length,
      sha256: artifact.sha256.toLowerCase() },
    payloadSha256: createHash('sha256').update(mime).digest('hex'),
  };
}
