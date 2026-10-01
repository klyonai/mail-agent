import { contentClassification } from './policy.mjs';

export const UNSUPPORTED_REPLY = 'This inbox currently supports plain text email requests only. Attachments, including inline images, and other document formats cannot be processed. Please resend your request as plain text in the email body without attachments.';

function metadataKind(metadata) {
  const allowed = ['none', 'inline-artifact', 'document', 'unknown'];
  if (!Number.isSafeInteger(metadata?.count) || metadata.count < 0) return 'unknown';
  if (metadata.kind === 'none' && metadata.count !== 0) return 'unknown';
  return allowed.includes(metadata.kind) ? metadata.kind : 'unknown';
}

/** Only the already-authorized runtime may request metadata. Never fetch attachment bodies. */
export async function classifyRequest(mail, client, read, signal) {
  const known = contentClassification(mail);
  if (known !== 'unchecked') return known;
  if (!client.getAttachmentMetadata) return 'unknown';
  try {
    const metadata = await read(signal => client.getAttachmentMetadata(mail.id, { signal }));
    return metadataKind(metadata);
  } catch(error) {
    if (signal?.aborted) throw new Error('Request classification cancelled.', {cause:error});
    if (error.deferred === true || Number.isSafeInteger(error.retryNotBefore)) throw error;
    return 'unknown';
  }
}
