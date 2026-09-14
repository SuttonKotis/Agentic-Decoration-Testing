/**
 * Output-size selection.
 *
 * Preserving the supplied composition is an acceptance criterion, so the
 * requested output matches the source aspect ratio instead of being forced into
 * one of the three fixed sizes. gpt-image-2 documents arbitrary WIDTHxHEIGHT
 * sizes whose edges are divisible by 16 and whose aspect ratio is between 1:3
 * and 3:1 (openai/openai-openapi, `CreateImageEditRequest.size`, 2026-09-14).
 */

export const SIZE_LIMITS = Object.freeze({
  step: 16,
  /** Roughly one megapixel: the standard 1024x1024 area, at the source's shape. */
  targetPixels: 1024 * 1024,
  minPixels: 655360,
  maxPixels: 3840 * 2160,
  maxEdge: 3840,
  minAspectRatio: 1 / 3,
  maxAspectRatio: 3,
});

/** Used when the source dimensions are unknown; a documented standard size. */
export const FALLBACK_SIZE = '1024x1024';

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const roundToStep = (value) =>
  Math.max(SIZE_LIMITS.step, Math.round(value / SIZE_LIMITS.step) * SIZE_LIMITS.step);

/**
 * Choose the output size for a source image.
 *
 * @param {number} sourceWidth
 * @param {number} sourceHeight
 * @returns {{ size: string, width: number, height: number,
 *             aspectRatioClamped: boolean, matchesSourceAspect: boolean }}
 */
export function chooseOutputSize(sourceWidth, sourceHeight) {
  const usable =
    Number.isFinite(sourceWidth) && Number.isFinite(sourceHeight) &&
    sourceWidth > 0 && sourceHeight > 0;

  if (!usable) {
    const [width, height] = FALLBACK_SIZE.split('x').map(Number);
    return {
      size: FALLBACK_SIZE, width, height,
      aspectRatioClamped: false, matchesSourceAspect: false,
    };
  }

  const sourceAspect = sourceWidth / sourceHeight;
  const aspect = clamp(sourceAspect, SIZE_LIMITS.minAspectRatio, SIZE_LIMITS.maxAspectRatio);

  let width = Math.sqrt(SIZE_LIMITS.targetPixels * aspect);
  let height = width / aspect;

  // Shrink proportionally if either edge would exceed the maximum.
  const edgeOverrun = Math.max(width / SIZE_LIMITS.maxEdge, height / SIZE_LIMITS.maxEdge, 1);
  width /= edgeOverrun;
  height /= edgeOverrun;

  width = roundToStep(width);
  height = roundToStep(height);

  // Rounding can push the area just outside the permitted range; nudge it back.
  const area = width * height;
  if (area < SIZE_LIMITS.minPixels || area > SIZE_LIMITS.maxPixels) {
    const bound = area < SIZE_LIMITS.minPixels ? SIZE_LIMITS.minPixels : SIZE_LIMITS.maxPixels;
    const scale = Math.sqrt(bound / area);
    const adjust = area < SIZE_LIMITS.minPixels ? Math.ceil : Math.floor;
    const toStep = (value) =>
      clamp(adjust(value / SIZE_LIMITS.step) * SIZE_LIMITS.step, SIZE_LIMITS.step, SIZE_LIMITS.maxEdge);
    width = toStep(width * scale);
    height = toStep(height * scale);
  }

  return {
    size: `${width}x${height}`,
    width,
    height,
    aspectRatioClamped: aspect !== sourceAspect,
    matchesSourceAspect: true,
  };
}
