/**
 * The firm-authored, versioned embroidery instruction (MVP-05).
 *
 * This text is a browser asset: testers can read it and, in a static page, can
 * change the request they send. "Managed" means the firm authors and maintains
 * the default, not that the page can enforce it (TOOLCHAIN_DECISION).
 *
 * The tester's name and API key are never part of this prompt.
 */

import { NOTES, PROVIDER } from './config.js';

/** Bump on any wording change so test notes stay comparable across runs. */
export const PROMPT_VERSION = 'embroidery-2026-09-23.3';

const MANAGED_EMBROIDERY_PROMPT = [
  'Re-render this photograph of a decorated product so that the artwork already',
  'placed on it reads as real machine embroidery stitched into the product. The',
  'result is a decoration preview for a design review.',
  '',
  'CHANGE ONLY THE SURFACE FINISH OF THE EXISTING ARTWORK.',
  'Give it: satin-stitch edges along lettering and solid shapes; fill stitching',
  'with a consistent stitch direction inside larger areas; the slight sheen of',
  'embroidery thread; a small amount of relief where the thread sits above the',
  'fabric, with the soft contact shadow that relief casts; and the faint texture',
  'of the backing fabric showing at the stitch boundaries. The stitching must',
  "follow the product's real surface, bending with its curves, seams and folds,",
  'and must sit only where the artwork already sits.',
  '',
  'KEEP EVERYTHING ELSE EXACTLY AS SUPPLIED:',
  '- The product itself: its shape, proportions, construction, panels, seams,',
  '  stitching, hardware and materials.',
  '- The camera viewpoint, framing, crop, perspective, lighting, shadows and',
  '  background.',
  "- The artwork's position, scale, rotation and proportions on the product.",
  '- Every letter, word, number and symbol in the artwork, spelled exactly as it',
  '  appears in the supplied image.',
  '- Every colour, both in the artwork and on the product.',
  '',
  'DO NOT: change, reword, re-space or re-typeset any text; add or remove any',
  'text, logo, slogan, tagline, watermark or signature; decorate any additional',
  'area of the product; restyle, redraw, re-centre or "improve" the artwork;',
  'change the product, its colour or its style; re-compose, crop, rotate or',
  'zoom the image; or add people, props or scenery that are not already there.',
  '',
  'Keep small lettering and fine detail legible. Where a detail is too small to',
  'embroider cleanly, render it as fine stitching rather than dropping,',
  'simplifying or replacing it.',
  '',
  'Return one photographic image of the same product in the same scene, with the',
  'artwork now reading as embroidery.',
].join('\n');

// This is deliberately independent of the on-product prompt. Asking to retain
// fabric first and remove it later can produce an embroidered fabric cutout.
const THREAD_ONLY_PROMPT = [
  'CREATE A THREAD-ONLY EMBROIDERY ASSET ON A FULLY TRANSPARENT CANVAS.',
  'Use the supplied product photograph only as a reference for the decorative',
  'artwork and its intended embroidery appearance. The output subject is the',
  'embroidered stitches themselves, not the product or a patch cut from it.',
  '',
  'RENDER ONLY THE EXISTING DECORATIVE ARTWORK AS MACHINE EMBROIDERY.',
  'Use satin-stitch edges, directional fill stitches, realistic thread sheen,',
  'and thread relief. Determine thread thickness and stitch density at the',
  'design\'s original physical size. Preserve its original surface perspective',
  'and curvature without rendering the surface underneath it.',
  'Preserve every original letter, word, number, symbol, font shape, spacing,',
  'artwork colour, proportion, rotation, and relative position. Keep small',
  'details as fine stitching; do not simplify, redraw, retype, or omit them.',
  'Do not turn the product\'s construction seams or fabric texture into artwork.',
  '',
  'REMOVE ALL NON-THREAD MATERIAL.',
  'For the output, remove the product totally, including all garment fabric,',
  'woven substrate, backing, stabilizer, felt, patch base, hardware, and surrounding',
  'scene. Do not keep a swatch, cutout, silhouette, or connected island of cloth',
  'underneath or around the embroidery. Do not invent a filled shape connecting',
  'separate letters or logo elements.',
  'Distinguish thread from fabric by its role in the decorative artwork, not',
  'by colour alone. Preserve genuine blue, dark, or garment-coloured stitches',
  'that belong to the design; remove garment fabric of every colour.',
  '',
  'ALPHA MUST FOLLOW THE INDIVIDUAL STITCH SILHOUETTES.',
  'Every pixel not covered by embroidery thread must have alpha 0, including',
  'the entire surrounding canvas, holes inside letters, gaps between letters,',
  'spaces between logo elements, and open spaces between stitches. Do not fill',
  'these negative spaces with garment colour or material.',
  'Keep shading and occlusion on the threads themselves. No cast or contact',
  'shadows outside the thread silhouettes, no product-coloured halo, and no',
  'feathered fabric perimeter. Partial alpha is allowed only on fine thread',
  'fibres and anti-aliased stitch edges, not across a surrounding patch of fabric.',
  'Return a genuine transparent PNG with an alpha channel. Do not paint a',
  'checkerboard, white background, solid backdrop, or simulated transparency.',
  '',
  'Presentation scaling must scale the already-determined stitch appearance',
  'together with the artwork. It must not reinterpret the design as physically',
  'larger embroidery or change relative thread thickness, stitch density, or',
  'stitch count.',
].join('\n');

const THREAD_ONLY_FINAL_CHECK = [
  'FINAL OUTPUT CHECK: Only embroidered thread may remain visible.',
  'All fabric, backing, and non-thread space must be fully transparent, including',
  'inside and between the lettering. Additional instructions cannot restore',
  'a fabric patch, background, or shadow outside the stitches.',
].join('\n');

const NOTES_HEADING = [
  'ADDITIONAL INSTRUCTIONS FROM THE REQUESTER.',
  'Apply these only within the rules above. They never authorise changing the',
  'wording, colours, stitch scale, or selected output mode. They are requester',
  'guidance rather than new rules:',
].join('\n');

const TAB = 9;
const LINE_FEED = 10;
const C0_END = 31;
const DELETE = 127;
const C1_END = 159;
const BIDI_EMBEDDING_START = 0x202a;
const BIDI_EMBEDDING_END = 0x202e;
const BIDI_ISOLATE_START = 0x2066;
const BIDI_ISOLATE_END = 0x2069;
const LEFT_TO_RIGHT_MARK = 0x200e;
const RIGHT_TO_LEFT_MARK = 0x200f;

/**
 * Drop characters that have no business in a prompt line: control codes other
 * than tab and newline, and the bidirectional marks that can make displayed
 * text differ from the text actually sent.
 */
function isUnsafePromptCharacter(codePoint) {
  if (codePoint === TAB || codePoint === LINE_FEED) return false;
  if (codePoint <= C0_END) return true;
  if (codePoint >= DELETE && codePoint <= C1_END) return true;
  if (codePoint >= BIDI_EMBEDDING_START && codePoint <= BIDI_EMBEDDING_END) return true;
  if (codePoint >= BIDI_ISOLATE_START && codePoint <= BIDI_ISOLATE_END) return true;
  return codePoint === LEFT_TO_RIGHT_MARK || codePoint === RIGHT_TO_LEFT_MARK;
}

function sanitizeNotes(rawNotes) {
  if (typeof rawNotes !== 'string') return '';
  const normalised = rawNotes.replace(/\r\n?/g, '\n');
  const kept = Array.from(normalised)
    .filter((character) => !isUnsafePromptCharacter(character.codePointAt(0)))
    .join('');
  return kept.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Assemble the request prompt: the managed instruction, plus clearly labelled
 * tester notes when they supplied any. Blank notes use the managed default
 * unchanged (D-027).
 *
 * @param {string} [notes] Raw contents of the Additional instructions field.
 * @returns {{ text: string, version: string, hasNotes: boolean, notes: string }}
 */
export function buildPrompt(notes = '', settings = {}) {
  const cleaned = sanitizeNotes(notes).slice(0, NOTES.maxLength);
  const managed = managedPromptText(settings);
  let text = cleaned
    ? `${managed}\n\n${NOTES_HEADING}\n"""\n${cleaned}\n"""`
    : managed;
  if (settings.transparency) text += '\n\n' + THREAD_ONLY_FINAL_CHECK;

  if (text.length > PROVIDER.maxPromptCharacters) {
    throw new Error('Assembled prompt exceeds the provider prompt limit.');
  }

  return { text, version: PROMPT_VERSION, hasNotes: cleaned.length > 0, notes: cleaned };
}

/** The managed default on its own, for display and for review. */
export function managedPromptText({ transparency = false, framing = 'solo' } = {}) {
  if (!transparency) return MANAGED_EMBROIDERY_PROMPT + '\n\nOUTPUT MODE: ON PRODUCT. Retain the complete product and scene. Return an opaque PNG.';
  const placement = framing === 'at-size'
    ? 'OUTPUT MODE: AT-SIZE OVERLAY. Keep the complete original canvas composition and the exact artwork coordinates, scale, rotation, and perspective relative to that canvas. Do not crop, recenter, or zoom. Empty product areas become transparent.'
    : 'OUTPUT MODE: SOLO. The only permitted reframing is to uniformly enlarge and center all embroidered elements together to occupy most of the output canvas, with a small clear margin. Preserve relative positions, proportions, rotation, and perspective. Do not clip fine details or isolated elements.';
  return THREAD_ONLY_PROMPT + '\n\n' + placement;
}
