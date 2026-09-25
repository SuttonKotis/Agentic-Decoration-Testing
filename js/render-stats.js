import { isHistoryTimestamp, normalizeStoredEntry } from './history-store.js?v=20260924-stats';
import { validateEmbroiderySize } from './embroidery-size.js?v=20260924-sizing';

function pixelSize(width, height) {
  return [width, height].every((value) => Number.isSafeInteger(value) && value > 0)
    ? { width, height } : null;
}

/** Use the completed render's snapshot, never the workspace's current settings. */
export function getRenderStats(entry) {
  const { id, createdAt, sourceName, parameters, details } = normalizeStoredEntry(entry);
  const design = validateEmbroiderySize(parameters);
  const requested = /^(\d+)x(\d+)$/.exec(details.requestedSize || '');
  return {
    id: typeof id === 'string' || Number.isFinite(id) ? id : null,
    createdAt: isHistoryTimestamp(createdAt) ? new Date(createdAt).toISOString() : null,
    sourceFilename: sourceName || null,
    outputFilename: details.filename || null,
    model: parameters.model || null,
    effort: parameters.effort || null,
    size: {
      resolution: parameters.resolution || null,
      framing: parameters.framing || null,
      embroideryInches: !design.error && design.width !== null
        ? { width: design.width, height: design.height } : null,
      sourcePixels: pixelSize(details.sourceWidth, details.sourceHeight),
      requestedPixels: requested ? pixelSize(Number(requested[1]), Number(requested[2])) : null,
      outputPixels: pixelSize(details.width, details.height),
    },
    timeToGenerateSeconds: details.timeToGenerateSeconds ?? null,
  };
}

/** Metadata only. Missing historical measurements remain explicitly unknown. */
export function createStatsExport(entries, exportedAt = Date.now()) {
  return {
    schemaVersion: 1,
    exportedAt: new Date(exportedAt).toISOString(),
    renders: entries.map(getRenderStats),
  };
}
