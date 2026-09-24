import { createHistoryRecord, historyKeyToken, listHistory, readHistoryImage, saveHistoryEntry, subscribeToHistory } from './history-store.js?v=20260924-hardening';
import { outputMode } from './settings.js';
import { historyOutputName } from './output-naming.js';
import { assertImageDimensions, inspectImageBlob } from './resource-limits.js';

const PAGE_SIZE = 12;

async function thumbnail(blob) {
  await inspectImageBlob(blob);
  const bitmap = await createImageBitmap(blob);
  try {
    assertImageDimensions(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 196 / bitmap.width, 96 / bitmap.height);
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  } finally { bitmap.close(); }
}

export function mountHistoryGallery({ onSelect, onNotice, onRiskChange = () => {} }) {
  const byId = (id) => document.getElementById(id);
  const gallery = byId('history-gallery');
  const memory = new Map(); // Only pending/failed local saves, never credentials.
  let connected = false;
  let lifetime = 0;
  let refreshId = 0;
  let selectionId = 0;
  let renderId = 0;
  let saved = [];
  let page = 0;
  let selectedId = null;
  let urls = [];

  function entries() {
    const merged = new Map(saved.map((entry) => [historyKeyToken(entry.id), entry]));
    for (const [id, result] of memory) merged.set(id, result.entry);
    return [...merged.values()].sort((a, b) => (b.createdAt ?? -1) - (a.createdAt ?? -1));
  }

  function clearThumbnails() {
    renderId += 1;
    for (const url of urls) URL.revokeObjectURL(url);
    urls = [];
    gallery.replaceChildren();
  }

  function emitMemory(result) {
    onSelect({ ...result.entry, blob: result.data.image, saveState: result.state, saveError: result.error || '' });
  }

  async function select(id) {
    const key = historyKeyToken(id);
    const attempt = ++selectionId;
    const entry = entries().find((item) => historyKeyToken(item.id) === key);
    if (!connected || !entry) return;
    if (memory.has(key)) {
      selectedId = key;
      emitMemory(memory.get(key));
    } else {
      try {
        const asset = await readHistoryImage(id);
        if (!connected || attempt !== selectionId) return;
        if (!asset?.image) throw new Error('Missing image.');
        await inspectImageBlob(asset.image);
        if (!connected || attempt !== selectionId) return;
        selectedId = key;
        onSelect({ ...entry, blob: asset.image, saveState: 'saved' });
      } catch {
        if (connected && attempt === selectionId) onNotice('This saved image could not be opened. Try selecting it again.');
      }
    }
    for (const button of gallery.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.key === selectedId));
  }

  async function render() {
    clearThumbnails();
    const currentRender = renderId;
    const all = entries();
    const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
    page = Math.min(page, pages - 1);
    byId('history-count').textContent = String(all.length);
    byId('history-empty').hidden = all.length > 0;
    gallery.hidden = all.length === 0;
    byId('gallery-paging').hidden = pages < 2;
    byId('gallery-page').textContent = `${page + 1} / ${pages}`;
    byId('gallery-previous').disabled = page === 0;
    byId('gallery-next').disabled = page === pages - 1;
    const visible = all.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const cells = visible.map((entry) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'gallery-item';
      button.dataset.id = entry.id;
      button.dataset.key = historyKeyToken(entry.id);
      button.setAttribute('aria-pressed', String(button.dataset.key === selectedId));
      const mode = outputMode(entry.parameters);
      const filename = historyOutputName(entry);
      button.title = `${filename} · ${mode} · ${entry.createdAt === null ? 'Unknown date' : new Date(entry.createdAt).toLocaleString()}`;
      const pairId = entry.details?.pairId;
      if (pairId) {
        button.dataset.pairId = pairId;
        button.title += ' · Paired run ' + pairId;
      }
      button.setAttribute('aria-label', button.title);
      const preview = document.createElement('span');
      preview.className = 'gallery-image';
      preview.textContent = 'PNG';
      const name = document.createElement('span');
      name.textContent = filename;
      name.title = filename;
      const state = document.createElement('span');
      const pending = memory.get(historyKeyToken(entry.id));
      const caption = pairId ? (entry.details.pairRole === 'product' ? 'Product' : 'Solo') + ' · ' + pairId.slice(0, 6) : mode;
      state.textContent = pending ? (pending.state === 'saving' ? 'Saving locally…' : 'Not saved · Download now') : caption;
      button.append(preview, name, state);
      button.addEventListener('click', () => { void select(entry.id); });
      gallery.append(button);
      return { entry, preview };
    });
    // Serial, page-bounded decoding. Full-resolution blob URLs are never kept
    // for the entire history; only small thumbnails for the visible page.
    for (const { entry, preview } of cells) {
      if (currentRender !== renderId || !connected) return;
      try {
        const blob = memory.get(historyKeyToken(entry.id))?.data.image || (await readHistoryImage(entry.id))?.image;
        if (currentRender !== renderId || !connected) return;
        if (!blob) continue;
        const small = await thumbnail(blob);
        if (currentRender !== renderId || !connected) return;
        if (!small) continue;
        const url = URL.createObjectURL(small);
        urls.push(url);
        const image = document.createElement('img');
        image.src = url;
        image.alt = '';
        preview.replaceChildren(image);
      } catch { /* Unreadable entries remain listed for explicit cleanup. */ }
    }
  }

  async function refresh() {
    if (!connected) return;
    const attempt = ++refreshId;
    try {
      const current = await listHistory();
      if (!connected || attempt !== refreshId) return;
      saved = current;
      byId('gallery-message').textContent = 'Completed previews are saved in this browser.';
      const all = entries();
      if (selectedId && !all.some((entry) => historyKeyToken(entry.id) === selectedId)) {
        selectionId += 1;
        selectedId = null;
        onSelect(null);
      }
      void render();
      if (!selectedId && all.length) void select(all[0].id);
    } catch {
      if (!connected || attempt !== refreshId) return;
      byId('gallery-message').textContent = 'History unavailable. New previews can still be downloaded.';
      void render();
    }
  }

  async function persist(result) {
    const key = historyKeyToken(result.entry.id);
    const currentLifetime = lifetime;
    const retrying = result.state === 'unsaved';
    result.state = 'saving';
    result.error = '';
    if (selectedId === key) emitMemory(result);
    void render();
    try {
      await saveHistoryEntry(result.data);
      if (!connected || currentLifetime !== lifetime) return;
      memory.delete(key);
      onRiskChange();
      saved = [result.entry, ...saved.filter((entry) => historyKeyToken(entry.id) !== key)];
      if (selectedId === key) onSelect({ ...result.entry, blob: result.data.image, saveState: 'saved' });
      void render();
      if (retrying) onNotice('Preview saved locally.');
    } catch (error) {
      if (!connected || currentLifetime !== lifetime) return;
      result.state = 'unsaved';
      result.error = error.message;
      if (selectedId === key) emitMemory(result);
      void render();
      onNotice('Preview complete, but not saved locally. Download it before refreshing or disconnecting.');
    }
  }

  byId('gallery-previous').addEventListener('click', () => { page -= 1; void render(); });
  byId('gallery-next').addEventListener('click', () => { page += 1; void render(); });
  byId('retry-save').addEventListener('click', () => {
    const result = memory.get(selectedId);
    if (result?.state === 'unsaved') void persist(result);
  });
  subscribeToHistory(() => { void refresh(); });
  window.addEventListener('focus', () => { void refresh(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });

  return {
    hasPendingResults() { return memory.size > 0; },
    connect() { connected = true; lifetime += 1; void refresh(); },
    disconnect() {
      connected = false;
      lifetime += 1;
      refreshId += 1;
      selectionId += 1;
      selectedId = null;
      memory.clear();
      onRiskChange();
      saved = [];
      page = 0;
      clearThumbnails();
      byId('history-count').textContent = '0';
      gallery.hidden = true;
      byId('gallery-paging').hidden = true;
      byId('history-empty').hidden = false;
    },
    add(data) {
      if (!connected) return;
      const { entry } = createHistoryRecord(data);
      const result = { entry, data: { ...data, id: entry.id, createdAt: entry.createdAt }, state: 'saving' };
      const key = historyKeyToken(entry.id);
      memory.set(key, result);
      onRiskChange();
      selectionId += 1;
      selectedId = key;
      page = 0;
      emitMemory(result);
      void persist(result);
    },
  };
}
