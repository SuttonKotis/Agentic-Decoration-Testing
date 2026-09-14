/**
 * Firm-managed request settings for the phase-1 embroidery preview.
 *
 * Every value here is a routine implementation choice made under D-028 and is
 * documented, with its rationale, in TechDocs/PROMPT_AND_SETTINGS.md.
 *
 * Provider contract verified against the official OpenAI OpenAPI description
 * (openai/openai-openapi, `CreateImageEditRequest`), retrieved 2026-09-14.
 */

export const PROVIDER = Object.freeze({
  /** Image API edit endpoint selected by D-022. */
  editsEndpoint: 'https://api.openai.com/v1/images/edits',
  /** Non-billable metadata endpoint used only to confirm the pasted key. */
  modelsEndpoint: 'https://api.openai.com/v1/models',
  /** Initial model selected by D-014. GPT Image 1.5 is a later, separate test. */
  model: 'gpt-image-2',
  /** Provider cap on prompt length for the GPT image models. */
  maxPromptCharacters: 32000,
});

export const OUTPUT = Object.freeze({
  /**
   * `high` is the top quality the GPT image models accept (`xhigh`/`max` are
   * gpt-image-2.5 only). Small embroidered lettering is the acceptance risk
   * this MVP is built around, so quality is spent there.
   */
  quality: 'high',
  /** Lossless, so stitch texture and small type are not smeared by codec noise. */
  outputFormat: 'png',
  /** Matches `outputFormat`; used for the Blob type and the download name. */
  mimeType: 'image/png',
  fileExtension: 'png',
});

export const UPLOAD = Object.freeze({
  /** The formats the provider documents for GPT image model edits. */
  acceptedTypes: Object.freeze(['image/png', 'image/jpeg', 'image/webp']),
  acceptAttribute: 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp',
  /** Firm limit, well under the provider's 50 MB, to keep uploads quick. */
  maxBytes: 20 * 1024 * 1024,
  /** Provider limit, kept here so the error message can name both. */
  providerMaxBytes: 50 * 1024 * 1024,
  /** Below this long edge the source is flagged as probably too small to judge. */
  smallSourceEdge: 512,
});

export const NOTES = Object.freeze({
  /** Cap established by D-027 / O-011. */
  maxLength: 500,
});

export const TIMING = Object.freeze({
  /**
   * The page stops waiting after this long. It cannot cancel a request that
   * already reached the provider, and says so.
   */
  requestTimeoutMs: 5 * 60 * 1000,
  /** How often the pending view refreshes its elapsed-time readout. */
  elapsedTickMs: 1000,
  /** The key check is a small metadata call; it should never hang the page. */
  keyCheckTimeoutMs: 20 * 1000,
});

export const APP = Object.freeze({
  name: 'Agentic Decoration Preview',
  phase: 'Phase 1 · Embroidery',
  /** Fixed for phase 1. The method selector arrives in phase 2 (D-015). */
  treatment: 'Embroidery',
});
