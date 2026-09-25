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
  minPixels: 655360,
  maxPixels: 3840 * 2160,
  maxEdge: 3840,
  minAspectRatio: 1 / 3,
  maxAspectRatio: 3,
});

/** Used when the source dimensions are unknown; a documented standard size. */
export const FALLBACK_SIZE = '1024x1024';

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
export function isSupportedSize(width, height) {
  const pixels = width * height;
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 &&
    width % 16 === 0 && height % 16 === 0 && Math.max(width, height) <= SIZE_LIMITS.maxEdge &&
    pixels >= SIZE_LIMITS.minPixels && pixels <= SIZE_LIMITS.maxPixels &&
    width / height >= SIZE_LIMITS.minAspectRatio && width / height <= SIZE_LIMITS.maxAspectRatio;
}

/**
 * Choose the output size for a source image.
 *
 * @param {number} sourceWidth
 * @param {number} sourceHeight
 * @returns {{ size: string, width: number, height: number,
 *             aspectRatioClamped: boolean, matchesSourceAspect: boolean }}
 */
export function chooseOutputSize(sourceWidth, sourceHeight, resolution = 'source') {
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

  const targetEdge = resolution === '1k' ? 1024 : resolution === '2k' ? 2048 : null;
  const targetPixels = resolution === 'maximum' ? SIZE_LIMITS.maxPixels
    : targetEdge ? targetEdge ** 2 / Math.max(aspect, 1 / aspect)
      : sourceWidth * sourceHeight;
  // Wide 1K canvases can be below the request minimum. Render at a legal size
  // near the same aspect ratio, then downsample the export to a 1,024 px edge.
  const fixedEdge = targetEdge && targetPixels >= SIZE_LIMITS.minPixels ? targetEdge : null;
  let targetWidth = Math.sqrt(clamp(targetPixels, SIZE_LIMITS.minPixels, SIZE_LIMITS.maxPixels) * aspect);
  let targetHeight = targetWidth / aspect;
  const scale = Math.min(1, SIZE_LIMITS.maxEdge / Math.max(targetWidth, targetHeight));
  targetWidth *= scale;
  targetHeight *= scale;

  // Search the legal grid near the source ratio, rather than independently
  // rounding edges (which can violate minimum area or the 3:1 limit).
  let best = null;
  for (let width = 16; width <= SIZE_LIMITS.maxEdge; width += 16) {
    const nearHeight = Math.floor(width / aspect / 16) * 16;
    const heights = [nearHeight, nearHeight + 16];
    if (fixedEdge) heights.push(fixedEdge);
    for (const height of heights) {
      if (!isSupportedSize(width, height)) continue;
      if (fixedEdge && Math.max(width, height) !== fixedEdge) continue;
      const score = Math.log(width / targetWidth) ** 2 + Math.log(height / targetHeight) ** 2 +
        8 * Math.log((width / height) / aspect) ** 2;
      if (!best || score < best.score) best = { width, height, score };
    }
  }
  const { width, height } = best;

  return {
    size: `${width}x${height}`,
    width,
    height,
    aspectRatioClamped: aspect !== sourceAspect,
    matchesSourceAspect: width * sourceHeight === height * sourceWidth,
  };
}

/** Render at a supported size; at-size exports always use the source canvas. */
export function planOutput(sourceWidth, sourceHeight, settings) {
  if (![sourceWidth, sourceHeight].every((edge) => Number.isSafeInteger(edge) && edge > 0)) {
    throw new Error('The source needs readable pixel dimensions.');
  }
  const chosen = chooseOutputSize(sourceWidth, sourceHeight, settings.resolution);
  const atSize = settings.transparency && settings.framing === 'at-size';
  if (chosen.aspectRatioClamped && (!settings.transparency || atSize)) {
    throw new Error('This source is wider or taller than the supported 3:1 range. Use Solo framing, or supply a less extreme source canvas.');
  }
  const originalCanvas = atSize || (settings.resolution === 'source' && !chosen.aspectRatioClamped);
  const aspect = clamp(sourceWidth / sourceHeight, SIZE_LIMITS.minAspectRatio, SIZE_LIMITS.maxAspectRatio);
  const smallWidth = aspect >= 1 ? 1024 : Math.round(1024 * aspect);
  const smallHeight = aspect >= 1 ? Math.round(1024 / aspect) : 1024;
  const exportWidth = originalCanvas ? sourceWidth : settings.resolution === '1k' ? smallWidth : chosen.width;
  const exportHeight = originalCanvas ? sourceHeight : settings.resolution === '1k' ? smallHeight : chosen.height;
  if (Math.max(exportWidth, exportHeight) > 16384 || exportWidth * exportHeight > 32_000_000) {
    throw new Error('This source canvas is too large for a local PNG export. Use a smaller source, or Solo framing at 1K, 2K or Maximum.');
  }
  return { ...chosen, exportWidth, exportHeight, atSize,
    experimental: chosen.width * chosen.height > 2560 * 1440 };
}
