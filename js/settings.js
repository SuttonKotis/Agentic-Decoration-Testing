import { NOTES } from './config.js';
import { digitsOnly } from './output-naming.js';

export const SETTINGS_KEY = 'decoration-preview-settings:' + new URL('../', import.meta.url).pathname;
export const MODELS = Object.freeze(['gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst']);
export const DEFAULT_SETTINGS = Object.freeze({
  decorationType: 'embroidery', model: 'gpt-image-2', effort: 'high',
  transparency: true, framing: 'solo', resolution: '1k', notes: '',
  designWidthInches: '', designHeightInches: '',
  outputName: '', outputNumber: '',
});

export function effortsForModel(model) {
  return model === 'gpt-image-2' ? ['low', 'medium', 'high'] : ['low', 'medium', 'high', 'xhigh', 'max'];
}

/** An explicit allowlist. Credentials, login names, images, and arbitrary state never enter preferences. */
export function normalizeSettings(raw = {}) {
  const settings = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return settings;
  if (MODELS.includes(raw.model)) settings.model = raw.model;
  if (effortsForModel(settings.model).includes(raw.effort)) settings.effort = raw.effort;
  if (typeof raw.transparency === 'boolean') settings.transparency = raw.transparency;
  if (['solo', 'at-size'].includes(raw.framing)) settings.framing = raw.framing;
  if (['source', '1k', '2k', 'maximum'].includes(raw.resolution)) settings.resolution = raw.resolution;
  for (const key of ['designWidthInches', 'designHeightInches']) {
    if (typeof raw[key] === 'string') settings[key] = raw[key].trim();
  }
  if (typeof raw.notes === 'string') settings.notes = raw.notes.slice(0, NOTES.maxLength);
  if (typeof raw.outputName === 'string') settings.outputName = raw.outputName;
  if (typeof raw.outputNumber === 'string') settings.outputNumber = digitsOnly(raw.outputNumber);
  return settings;
}

export function loadSettings(storage = globalThis.localStorage) {
  const stored = storage.getItem(SETTINGS_KEY);
  if (!stored) return normalizeSettings();
  const parsed = JSON.parse(stored);
  if (parsed?.version !== 1) throw new Error('Saved settings could not be read. Defaults are in use.');
  return normalizeSettings(parsed.settings);
}

export function rememberSettings(settings, storage = globalThis.localStorage) {
  storage.setItem(SETTINGS_KEY, JSON.stringify({ version: 1, settings: normalizeSettings(settings) }));
}

export function outputMode(settings) {
  return settings.transparency ? (settings.framing === 'solo' ? 'Solo embroidery' : 'At-size overlay') : 'On product';
}
