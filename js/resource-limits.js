/** App safety budgets, not provider quotas. Check before parsing or decoding. */
export const RESOURCE_LIMITS = Object.freeze({
  imagePixels: 32_000_000,
  imageEdge: 16384,
  providerImageBytes: 96 * 1024 * 1024,
  imageResponseBytes: 128 * 1024 * 1024,
  modelResponseBytes: 4 * 1024 * 1024,
  errorResponseBytes: 64 * 1024,
  errorMessageCharacters: 2000,
  // A local at-size export may be larger than the provider's render.
  localImageBytes: 128 * 1024 * 1024,
  sourceBytes: 20 * 1024 * 1024,
});

export class ResourceLimitError extends Error {
  constructor(message) { super(message); this.name = 'ResourceLimitError'; }
}

const unreadable = () => new Error('Image dimensions could not be read safely. Re-export as PNG, JPEG or WebP and try again.');

export function assertImageDimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw unreadable();
  if (width > RESOURCE_LIMITS.imageEdge || height > RESOURCE_LIMITS.imageEdge || width * height > RESOURCE_LIMITS.imagePixels) {
    throw new ResourceLimitError('This image exceeds the 32-megapixel or 16,384-pixel edge limit. Resize it before trying again.');
  }
  return { width, height };
}

/** Header preflight only; the browser still verifies/decodes the image itself. */
export function readImageDimensions(bytes, type) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at, text) => [...text].every((character, index) => bytes[at + index] === character.charCodeAt(0));
  if (type === 'image/png') {
    if (bytes.length < 33 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
      || view.getUint32(8) !== 13 || !tag(12, 'IHDR')) throw unreadable();
    return assertImageDimensions(view.getUint32(16), view.getUint32(20));
  }
  if (type === 'image/jpeg') {
    if (bytes[0] !== 255 || bytes[1] !== 216) throw unreadable();
    let offset = 2;
    while (offset + 1 < bytes.length) {
      if (bytes[offset++] !== 255) throw unreadable();
      while (bytes[offset] === 255) offset += 1;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218 || marker === undefined) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) {
        if (length < 8) break;
        return assertImageDimensions(view.getUint16(offset + 5), view.getUint16(offset + 3));
      }
      offset += length;
    }
    throw unreadable();
  }
  if (type === 'image/webp') {
    if (bytes.length < 25 || !tag(0, 'RIFF') || !tag(8, 'WEBP')) throw unreadable();
    const length = view.getUint32(16, true);
    if (tag(12, 'VP8X') && length === 10 && bytes.length >= 30) {
      const uint24 = (at) => bytes[at] + bytes[at + 1] * 256 + bytes[at + 2] * 65536;
      return assertImageDimensions(uint24(24) + 1, uint24(27) + 1);
    }
    if (tag(12, 'VP8L') && length >= 5 && bytes[20] === 47) {
      const packed = view.getUint32(21, true);
      return assertImageDimensions((packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1);
    }
    if (tag(12, 'VP8 ') && length >= 10 && bytes.length >= 30
      && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) {
      return assertImageDimensions(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
    }
  }
  throw unreadable();
}

export async function inspectImageBlob(blob, { maxBytes = RESOURCE_LIMITS.localImageBytes } = {}) {
  if (!(blob instanceof Blob) || !blob.size) throw unreadable();
  if (blob.size > maxBytes) throw new ResourceLimitError('This image exceeds the local image byte limit. Use a smaller image.');
  // JPEG dimensions follow variable-length metadata; its bounded scan never
  // decodes pixels. PNG/WebP put their dimensions in the initial header.
  const headerBytes = { 'image/png': 33, 'image/webp': 30, 'image/jpeg': RESOURCE_LIMITS.sourceBytes }[blob.type];
  if (!headerBytes) throw unreadable();
  return readImageDimensions(new Uint8Array(await blob.slice(0, headerBytes).arrayBuffer()), blob.type);
}

export function decodeBoundedBase64(base64) {
  if (base64.length > Math.ceil(RESOURCE_LIMITS.providerImageBytes / 3) * 4) {
    throw new ResourceLimitError('The returned image exceeds the 96 MiB image limit.');
  }
  const binary = atob(base64);
  if (binary.length > RESOURCE_LIMITS.providerImageBytes) throw new ResourceLimitError('The returned image exceeds the 96 MiB image limit.');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Enforce actual streamed bytes too: Content-Length may be absent or wrong. */
export async function readBoundedText(response, maxBytes, signal = null) {
  const tooLarge = () => new ResourceLimitError('The response exceeds the local response byte limit.');
  const cancel = (reader) => { void reader.cancel().catch(() => {}); };
  if (Number(response.headers.get('content-length')) > maxBytes) {
    if (response.body) cancel(response.body);
    throw tooLarge();
  }
  if (!response.body) { signal?.throwIfAborted(); return ''; }
  const reader = response.body.getReader();
  const abort = () => cancel(reader);
  signal?.addEventListener('abort', abort, { once: true });
  let size = 0;
  const parts = [];
  const decoder = new TextDecoder();
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw tooLarge();
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join('');
  } catch (error) {
    cancel(reader);
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
