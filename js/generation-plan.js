import { normalizeSettings, outputMode } from './settings.js?v=20260923-naming';
import { buildPrompt } from './prompt.js?v=embroidery-20260923-3';
import { planOutput } from './size.js';

/** Preflight every output before any paid request; overrides never alter preferences. */
export function planGeneration(source, rawSettings, paired = false) {
  const captured = normalizeSettings(rawSettings);
  const variants = paired ? [
    { role: 'product', settings: { ...captured, transparency: false } },
    { role: 'solo', settings: { ...captured, transparency: true, framing: 'solo', resolution: 'maximum' } },
  ] : [{ role: 'preview', settings: captured }];

  return Object.freeze(variants.map(({ role, settings }) => {
    let plan;
    try { plan = planOutput(source.width, source.height, settings); }
    catch (error) {
      if (paired) throw new Error((role === 'product' ? 'Product preview: ' : 'Solo: ') + error.message);
      throw error;
    }
    const prompt = buildPrompt(settings.notes, settings);
    return Object.freeze({
      role, label: outputMode(settings), plan: Object.freeze(plan), prompt: Object.freeze(prompt),
      settings: Object.freeze({ ...settings, notes: prompt.notes }),
    });
  }));
}
