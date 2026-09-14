/**
 * Form checks that run before any paid generation attempt, plus the redaction
 * helper that keeps a pasted key out of anything the page displays.
 */

import { NOTES, UPLOAD } from './config.js';

const MIN_KEY_LENGTH = 20;
const MAX_NAME_LENGTH = 80;

/** Anything shaped like an OpenAI key, whether or not it is the pasted one. */
const KEY_SHAPED = /\bsk-[A-Za-z0-9_-]{8,}/g;

/**
 * Replace the supplied key, and anything else key-shaped, with a placeholder.
 * Provider error text can quote part of a key back at us, so run every message
 * through this before it reaches the DOM.
 *
 * @param {unknown} text
 * @param {string} [apiKey]
 */
export function redactSecrets(text, apiKey = '') {
  if (typeof text !== 'string' || text.length === 0) return '';
  let safe = text;
  if (typeof apiKey === 'string' && apiKey.length >= 8) {
    safe = safe.split(apiKey).join('[redacted]');
    // Providers often echo a masked form: first characters, stars, last characters.
    const head = apiKey.slice(0, 8);
    if (head.length === 8) {
      safe = safe.replace(new RegExp(`${escapeForRegExp(head)}[^\\s"']*`, 'g'), '[redacted]');
    }
  }
  return safe.replace(KEY_SHAPED, '[redacted]');
}

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

/**
 * @param {string} rawName
 * @returns {{ ok: boolean, value: string, message?: string }}
 */
export function validateName(rawName) {
  const value = typeof rawName === 'string' ? rawName.trim().replace(/\s+/g, ' ') : '';
  if (!value) {
    return { ok: false, value: '', message: 'Enter your name so results can be attributed to you.' };
  }
  if (value.length > MAX_NAME_LENGTH) {
    return {
      ok: false,
      value,
      message: `Use ${MAX_NAME_LENGTH} characters or fewer for your name.`,
    };
  }
  return { ok: true, value };
}

/**
 * Structural checks only. Whether the provider accepts the key is answered by
 * the provider, not here.
 *
 * @param {string} rawKey
 * @returns {{ ok: boolean, value: string, message?: string, warning?: string }}
 */
export function validateApiKey(rawKey) {
  const value = typeof rawKey === 'string' ? rawKey.trim() : '';
  if (!value) {
    return { ok: false, value: '', message: 'Paste the API key you were assigned.' };
  }
  if (/\s/.test(value)) {
    return {
      ok: false,
      value: '',
      message: 'That key contains a space or line break. Paste the key on its own.',
    };
  }
  if (value.length < MIN_KEY_LENGTH) {
    return {
      ok: false,
      value: '',
      message: 'That is shorter than an API key. Check that the whole key was copied.',
    };
  }
  if (!/^[\x21-\x7e]+$/.test(value)) {
    return {
      ok: false,
      value: '',
      message: 'That key contains characters an API key cannot contain.',
    };
  }
  if (!value.startsWith('sk-')) {
    return {
      ok: true,
      value,
      warning: 'This does not look like an OpenAI key, which normally starts with "sk-".',
    };
  }
  return { ok: true, value };
}

/**
 * @param {{ name?: string, type?: string, size?: number }} file
 * @returns {{ ok: boolean, message?: string }}
 */
export function validateImageFile(file) {
  if (!file) {
    return { ok: false, message: 'Choose the product mockup you want previewed.' };
  }
  const type = (file.type || '').toLowerCase();
  if (!UPLOAD.acceptedTypes.includes(type)) {
    return {
      ok: false,
      message: `${describeFileType(file)} is not a supported format. Upload a PNG, JPEG or WebP image.`,
    };
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return { ok: false, message: 'That file is empty. Choose the mockup file again.' };
  }
  if (file.size > UPLOAD.maxBytes) {
    return {
      ok: false,
      message:
        `That file is ${formatBytes(file.size)}. This app accepts up to ` +
        `${formatBytes(UPLOAD.maxBytes)} (the provider's own limit is ` +
        `${formatBytes(UPLOAD.providerMaxBytes)}).`,
    };
  }
  return { ok: true };
}

function describeFileType(file) {
  if (file.type) return `"${file.type}"`;
  const extension = (file.name || '').split('.').pop();
  return extension && extension !== file.name ? `".${extension}"` : 'That file';
}

/**
 * The cap is enforced by maxlength in the markup; this is the check that runs
 * regardless of how the value got there.
 *
 * @param {string} rawNotes
 */
export function validateNotes(rawNotes) {
  const value = typeof rawNotes === 'string' ? rawNotes : '';
  if (value.length > NOTES.maxLength) {
    return {
      ok: false,
      value: value.slice(0, NOTES.maxLength),
      message: `Additional instructions are limited to ${NOTES.maxLength} characters.`,
    };
  }
  return { ok: true, value };
}

/** Flags a source too small to judge embroidery detail on. Advisory, not blocking. */
export function sourceSizeAdvice(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return '';
  }
  if (Math.max(width, height) < UPLOAD.smallSourceEdge) {
    return (
      `This mockup is only ${width} by ${height} pixels. Small sources make ` +
      'embroidery detail and small lettering hard to judge.'
    );
  }
  return '';
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown size';
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
