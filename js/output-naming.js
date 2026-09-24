/** Output labels are user-owned, not inferred from uploads or incremented. */
export function digitsOnly(value) {
  return typeof value === 'string' ? value.replace(/[^0-9]/g, '') : '';
}

export function namingError(settings) {
  const name = filenamePart(settings.outputName || '');
  if (!name) return 'Enter a Name for the output.';
  if (settings.outputNumber && !/^[0-9]+$/.test(settings.outputNumber)) return 'Use digits only for the optional number.';
  return '';
}

function filenamePart(value) {
  // Keep letters, numbers, spaces, punctuation, and Unicode. Only replace
  // characters that cannot safely be used in a downloaded filename.
  const part = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/[\u202a-\u202e\u2066-\u2069]/g, '');
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) ? '_' + part : part;
}

export function namedOutputFilename(settings, { preview = false } = {}) {
  const name = filenamePart(settings.outputName || '');
  const number = digitsOnly(settings.outputNumber);
  const decoration = filenamePart(settings.decorationType || 'embroidery');
  if (!preview && !name) throw new Error('Enter a Name for the output.');
  return `${name || '[Name]'}${number ? '.' + number : ''}.${decoration}.png`;
}

/** Existing records keep their original filename; selecting one never renames it. */
export function historyOutputName(entry) {
  return entry.details?.filename || entry.sourceName || 'Preview';
}
