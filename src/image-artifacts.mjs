import { createArtifactFiles } from './artifact-files.mjs';
import { IMAGE_BOUNDS, imageCancelled, validateImage } from './image-validation.mjs';

export function createImageArtifacts(options) {
  const files = createArtifactFiles({ ...options, validateBytes: (bytes, handle) =>
    validateImage(bytes, { mediaType: handle.mediaType, maxPixels: IMAGE_BOUNDS.hardPixels }) });
  return { ...files, async put(bytes, { mediaType, source, limits, signal } = {}) {
    imageCancelled(signal);
    const metadata = validateImage(bytes, { ...limits, mediaType });
    return files.put(bytes, { metadata, source, signal });
  } };
}
