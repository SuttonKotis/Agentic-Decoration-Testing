/** Local export/inspection only. No requests, background removal, or invented detail. */
import { assertImageDimensions, inspectImageBlob } from './resource-limits.js';
const pngBlob = (canvas) => new Promise((resolve, reject) => {
  canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PNG export failed.')), 'image/png');
});

export async function prepareOutput(blob, plan, settings, { signal } = {}) {
  signal?.throwIfAborted();
  await inspectImageBlob(blob);
  signal?.throwIfAborted();
  const bitmap = await createImageBitmap(blob);
  try {
    signal?.throwIfAborted();
    assertImageDimensions(bitmap.width, bitmap.height);
    assertImageDimensions(plan.exportWidth, plan.exportHeight);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Local image export is unavailable.');
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let hasTransparency = false;
    let hasVisiblePixels = false;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] < 255) hasTransparency = true;
      if (pixels[index] > 0) hasVisiblePixels = true;
      if (hasTransparency && hasVisiblePixels) break;
    }
    const warnings = [];
    if (settings.transparency && !hasTransparency) warnings.push('No transparent pixels were returned. This is not a transparent overlay.');
    if (!hasVisiblePixels) warnings.push('The returned image is entirely transparent. No visible embroidery was detected.');
    if (plan.atSize) warnings.push('Source canvas restored. Check artwork alignment against the original before using as an overlay.');
    if (bitmap.width !== plan.width || bitmap.height !== plan.height) {
      warnings.push(`Provider returned ${bitmap.width} × ${bitmap.height} px instead of the requested ${plan.width} × ${plan.height} px.`);
    }
    let outputBlob = blob;
    if (bitmap.width !== plan.exportWidth || bitmap.height !== plan.exportHeight) {
      canvas.width = plan.exportWidth;
      canvas.height = plan.exportHeight;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      outputBlob = await pngBlob(canvas);
      if (plan.exportWidth > bitmap.width || plan.exportHeight > bitmap.height) {
        warnings.push('Export resized to the source canvas; enlargement adds no stitch detail.');
      }
    }
    return { blob: outputBlob, width: plan.exportWidth, height: plan.exportHeight, hasTransparency, warnings };
  } finally {
    bitmap.close();
  }
}

export function outputFilename(sourceName, settings, createdAt = Date.now(), id = '') {
  const stem = String(sourceName || 'mockup').replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 80) || 'mockup';
  const mode = settings?.transparency ? settings.framing : 'product';
  const timestamp = typeof createdAt === 'number' && Number.isFinite(new Date(createdAt).getTime())
    ? new Date(createdAt).toISOString().replace(/[:.]/g, '-') : 'unknown-date';
  return `${stem}-embroidery-${mode}-${timestamp}${typeof id === 'string' && id ? '-' + id.slice(0, 8) : ''}.png`;
}
