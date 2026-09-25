/**
 * App-owned IndexedDB history. Metadata is separate from image blobs so the
 * storage meter and cleanup preview never need to load images into memory.
 * Keys and settings outside this explicit record schema are never persisted.
 */
export const HISTORY_DATABASE_NAME = 'decoration-preview-history:' + new URL('../', import.meta.url).pathname;
export const HISTORY_MAX_BYTES = 500_000_000;
const DATABASE_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const listeners = new Set();
let databasePromise = null;
let channel = null;

export class HistoryStorageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HistoryStorageError';
  }
}

function storageError(error) {
  if (error instanceof HistoryStorageError) return error;
  if (error?.name === 'QuotaExceededError') {
    return new HistoryStorageError('Browser storage is full. Download and delete some history, then try again.');
  }
  if (error?.name === 'ConstraintError') {
    return new HistoryStorageError('This history entry already exists. Existing images were not overwritten.');
  }
  return new HistoryStorageError('Local history storage is unavailable. Check this site’s storage permissions and try again.');
}

export function formatHistoryMegabytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unavailable';
  if (bytes > 0 && bytes < 10_000) return '<0.01 MB';
  return (bytes / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' MB';
}

export function historyCutoff(days, now = Date.now()) {
  // Only whole elapsed days; no ambiguous local-midnight/DST interpretation.
  if (!Number.isInteger(days) || days < 1 || days > 36500 || !Number.isFinite(now)) {
    throw new HistoryStorageError('Enter a whole number of days between 1 and 36,500.');
  }
  return now - days * DAY_MS;
}

export const isHistoryTimestamp = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;

/** Stable identity for real IndexedDB keys, including malformed legacy IDs. */
export function historyKeyToken(key) {
  if (typeof key === 'string') return 'string:' + key;
  if (typeof key === 'number' && !Number.isNaN(key)) return 'number:' + String(key);
  if (key instanceof Date && Number.isFinite(key.getTime())) return 'date:' + key.getTime();
  if (key instanceof ArrayBuffer || ArrayBuffer.isView(key)) {
    const bytes = key instanceof ArrayBuffer ? new Uint8Array(key) : new Uint8Array(key.buffer, key.byteOffset, key.byteLength);
    return 'binary:' + [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  if (Array.isArray(key)) return 'array:' + JSON.stringify(key.map(historyKeyToken));
  throw new HistoryStorageError('No valid history selection was supplied.');
}

export function createHistoryRecord({ id = globalThis.crypto.randomUUID(), createdAt = Date.now(),
  image, sourceImage = null, sourceName = '', parameters = {}, details = {} } = {}) {
  if (!(image instanceof Blob) || image.size === 0 || !image.type.startsWith('image/')) {
    throw new HistoryStorageError('A nonempty image is required to save history.');
  }
  if (sourceImage !== null && (!(sourceImage instanceof Blob) || !sourceImage.type.startsWith('image/'))) {
    throw new HistoryStorageError('The source must be an image file.');
  }
  if (typeof id !== 'string' || !id || !isHistoryTimestamp(createdAt)) {
    throw new HistoryStorageError('The history entry needs a valid ID and saved timestamp.');
  }
  const { safeParameters, safeDetails } = safeHistoryFields(parameters, details);
  const entry = {
    id, createdAt, sourceName: typeof sourceName === 'string' ? sourceName : '',
    parameters: safeParameters, imageType: image.type, sourceType: sourceImage?.type || null,
    imageBytes: image.size, sourceBytes: sourceImage?.size || 0,
  };
  if (Object.keys(safeDetails).length) entry.details = safeDetails;
  // Payload estimate only: browser database/index overhead is not measurable
  // per app. navigator.storage.estimate() includes other apps on this origin.
  entry.bytes = image.size + (sourceImage?.size || 0) + new TextEncoder().encode(JSON.stringify(entry)).byteLength;
  return { entry, asset: { id, image, sourceImage } };
}

function safeHistoryFields(parameters, details) {
  const safeParameters = {};
  // Never spread application/session state into a persistent record.
  for (const key of ['decorationType', 'model', 'effort', 'framing', 'resolution', 'notes', 'outputName', 'outputNumber', 'designWidthInches', 'designHeightInches']) {
    if (typeof parameters?.[key] === 'string') safeParameters[key] = parameters[key];
  }
  if (typeof parameters?.transparency === 'boolean') safeParameters.transparency = parameters.transparency;
  const safeDetails = {};
  if (typeof details?.filename === 'string') safeDetails.filename = details.filename;
  for (const key of ['promptVersion', 'requestedSize', 'requestId', 'pairId']) {
    if (typeof details?.[key] === 'string') safeDetails[key] = details[key].slice(0, 300);
  }
  for (const key of ['sourceWidth', 'sourceHeight', 'width', 'height', 'inputTokens', 'outputTokens', 'totalTokens']) {
    if (Number.isSafeInteger(details?.[key]) && details[key] >= 0) safeDetails[key] = details[key];
  }
  if (Number.isFinite(details?.timeToGenerateSeconds) && details.timeToGenerateSeconds >= 0) {
    safeDetails.timeToGenerateSeconds = details.timeToGenerateSeconds;
  }
  if (typeof details?.hasTransparency === 'boolean') safeDetails.hasTransparency = details.hasTransparency;
  if (safeDetails.pairId && ['product', 'solo'].includes(details?.pairRole)) safeDetails.pairRole = details.pairRole;
  if (Array.isArray(details?.warnings)) safeDetails.warnings = details.warnings.filter((value) => typeof value === 'string').slice(0, 8).map((value) => value.slice(0, 500));
  return { safeParameters, safeDetails };
}

function storedBytes(entry) {
  if (!Number.isSafeInteger(entry?.bytes) || entry.bytes < 0) return NaN;
  let payload = 0;
  for (const field of ['imageBytes', 'sourceBytes']) {
    if (entry[field] === undefined) continue; // Older metadata may only have a total.
    if (!Number.isSafeInteger(entry[field]) || entry[field] < 0) return NaN;
    payload += entry[field];
  }
  return Number.isSafeInteger(payload) && entry.bytes >= payload ? entry.bytes : NaN;
}

/** Read-only projection. Never repair/delete stored rows as a side effect. */
export function normalizeStoredEntry(entry) {
  const { safeParameters, safeDetails } = safeHistoryFields(entry?.parameters, entry?.details);
  const createdAt = isHistoryTimestamp(entry?.createdAt) ? entry.createdAt : null;
  return {
    id: entry.id, createdAt,
    sourceName: typeof entry.sourceName === 'string' ? entry.sourceName : '',
    parameters: safeParameters, details: safeDetails,
    imageType: typeof entry.imageType === 'string' ? entry.imageType : '',
    sourceType: typeof entry.sourceType === 'string' ? entry.sourceType : null,
    ...(Number.isSafeInteger(entry.imageBytes) && entry.imageBytes >= 0 ? { imageBytes: entry.imageBytes } : {}),
    ...(Number.isSafeInteger(entry.sourceBytes) && entry.sourceBytes >= 0 ? { sourceBytes: entry.sourceBytes } : {}),
    bytes: storedBytes(entry),
  };
}

function openHistory() {
  if (databasePromise) return databasePromise;
  const opening = new Promise((resolve, reject) => {
    let request;
    let finished = false;
    const timer = setTimeout(() => fail(new HistoryStorageError('Opening local history timed out. Close other tabs for this app and try again.')), 8000);
    function fail(error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(storageError(error));
    }
    try {
      request = globalThis.indexedDB.open(HISTORY_DATABASE_NAME, DATABASE_VERSION);
    } catch (error) {
      fail(error);
      return;
    }
    request.onblocked = () => fail(new HistoryStorageError('Local history is busy in another tab. Close that tab and try again.'));
    request.onerror = () => fail(request.error);
    request.onupgradeneeded = () => {
      if (finished) {
        request.transaction.abort();
        return;
      }
      const database = request.result;
      const entries = database.createObjectStore('entries', { keyPath: 'id' });
      entries.createIndex('createdAt', 'createdAt');
      database.createObjectStore('assets', { keyPath: 'id' });
    };
    request.onsuccess = () => {
      const database = request.result;
      if (finished) {
        database.close();
        return;
      }
      finished = true;
      clearTimeout(timer);
      database.onversionchange = () => {
        database.close();
        databasePromise = null;
      };
      database.onclose = () => { databasePromise = null; };
      resolve(database);
    };
  });
  databasePromise = opening;
  opening.catch(() => { if (databasePromise === opening) databasePromise = null; });
  return opening;
}

async function transact(stores, mode, work) {
  const database = await openHistory();
  return new Promise((resolve, reject) => {
    let transaction;
    let result;
    let failure;
    try {
      transaction = database.transaction(stores, mode);
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(storageError(failure || transaction.error));
      work(transaction, (value) => { result = value; }, (error) => {
        failure = error;
        transaction.abort();
      });
    } catch (error) {
      failure = error;
      if (transaction) transaction.abort();
      else reject(storageError(error));
    }
  });
}

function emitChange() {
  // A view observer must never turn a committed write into a reported failure.
  for (const listener of listeners) {
    try { listener(); } catch { /* The view can retry its own refresh. */ }
  }
}

function getChannel() {
  if (!channel && typeof globalThis.BroadcastChannel === 'function') {
    try {
      channel = new BroadcastChannel(HISTORY_DATABASE_NAME);
      channel.onmessage = emitChange;
      channel.unref?.();
    } catch { /* Cross-tab updates also refresh when the window regains focus. */ }
  }
  return channel;
}

function announceChange() {
  emitChange();
  try { getChannel()?.postMessage('changed'); } catch { /* Refresh on focus remains available. */ }
}

export function subscribeToHistory(listener) {
  listeners.add(listener);
  getChannel();
  return () => listeners.delete(listener);
}

export async function listHistory() {
  return transact(['entries'], 'readonly', (transaction, done) => {
    // The timestamp index omits rows with missing/invalid dates. Read the
    // store so those rows remain visible and explicitly removable.
    const request = transaction.objectStore('entries').getAll();
    request.onsuccess = () => done(request.result.map(normalizeStoredEntry).sort((a, b) => (b.createdAt ?? -1) - (a.createdAt ?? -1)));
  });
}

export async function readHistoryImage(id) {
  return transact(['assets'], 'readonly', (transaction, done) => {
    const request = transaction.objectStore('assets').get(id);
    request.onsuccess = () => {
      const asset = request.result;
      done(asset?.image instanceof Blob && asset.image.size > 0 && asset.image.type.startsWith('image/')
        ? { id: asset.id, image: asset.image, sourceImage: asset.sourceImage instanceof Blob ? asset.sourceImage : null } : null);
    };
  });
}

export function summarizeHistory(entries) {
  const total = entries.reduce((sum, entry) => sum + storedBytes(entry), 0);
  return { count: entries.length, bytes: Number.isSafeInteger(total) && total >= 0 ? total : NaN };
}

export function planHistoryDeletion(entries, { days = null, now = Date.now() } = {}) {
  const cutoff = days === null ? null : historyCutoff(days, now);
  const matches = cutoff === null ? entries : entries.filter((entry) => isHistoryTimestamp(entry.createdAt) && entry.createdAt < cutoff);
  return { ...summarizeHistory(matches), ids: matches.map((entry) => entry.id), cutoff };
}

/** Save only completed results. Upload selection alone never saves. */
export async function saveHistoryEntry(data) {
  const { entry, asset } = createHistoryRecord(data);
  await transact(['entries', 'assets'], 'readwrite', (transaction, done, fail) => {
    const entries = transaction.objectStore('entries');
    const request = entries.getAll();
    request.onsuccess = () => {
      const used = summarizeHistory(request.result).bytes;
      if (!Number.isFinite(used)) {
        fail(new HistoryStorageError('History contains unreadable size metadata. Download this preview, then use history cleanup before saving more. Nothing was removed automatically.'));
        return;
      }
      if (used + entry.bytes > HISTORY_MAX_BYTES) {
        fail(new HistoryStorageError('The ' + formatHistoryMegabytes(HISTORY_MAX_BYTES) + ' history limit has been reached. Download and delete some history before saving more.'));
        return;
      }
      entries.add(entry);
      transaction.objectStore('assets').add(asset);
      done(entry.id);
    };
  });
  announceChange();
  return entry.id;
}

/** Delete only IDs included in the user's reviewed snapshot, not later saves. */
export async function deleteHistoryEntries(ids) {
  if (!Array.isArray(ids)) {
    throw new HistoryStorageError('No valid history selection was supplied.');
  }
  // Deduplicate by IndexedDB key value, not JS object identity. Keep the
  // actual keys for deletion; never coerce 7 into the unrelated key "7".
  const selected = new Map(ids.map((id) => [historyKeyToken(id), id]));
  const removed = await transact(['entries', 'assets'], 'readwrite', (transaction, done) => {
    const entries = transaction.objectStore('entries');
    const assets = transaction.objectStore('assets');
    const result = { count: 0, bytes: 0 };
    done(result);
    for (const id of selected.values()) {
      const request = entries.get(id);
      request.onsuccess = () => {
        if (!request.result) return;
        result.count += 1;
        const total = result.bytes + storedBytes(request.result);
        result.bytes = Number.isSafeInteger(total) && total >= 0 ? total : NaN;
        entries.delete(id);
        assets.delete(id);
      };
    }
  });
  if (removed.count) announceChange();
  return removed;
}
