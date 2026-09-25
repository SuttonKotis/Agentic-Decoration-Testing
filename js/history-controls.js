import {
  deleteHistoryEntries, formatHistoryMegabytes, HISTORY_MAX_BYTES, HistoryStorageError,
  isHistoryTimestamp, listHistory, planHistoryDeletion, subscribeToHistory, summarizeHistory,
} from './history-store.js?v=20260924-stats';
import { createStatsExport } from './render-stats.js?v=20260924-stats';

export function mountHistoryControls() {
  const byId = (id) => document.getElementById(id);
  const workspace = byId('main');
  const dialog = byId('history-dialog');
  const trigger = byId('history-settings');
  const usage = byId('history-usage');
  const form = byId('history-form');
  const days = byId('history-days');
  const older = byId('history-older');
  const remove = byId('history-delete');
  const exportStats = byId('history-export-stats');
  const error = byId('history-error');
  const status = byId('history-status');
  byId('history-limit').textContent = (HISTORY_MAX_BYTES / 1_000_000).toLocaleString('en-US') + ' MB';
  let entries = [];
  let available = false;
  let loading = false;
  let busy = false;
  let revision = 0;
  let plan = null;

  const imageCount = (count) => count + (count === 1 ? ' image' : ' images');
  const sizeLabel = (bytes) => Number.isFinite(bytes) ? formatHistoryMegabytes(bytes) : 'Size unknown';

  function renderSelection() {
    plan = null;
    days.disabled = !older.checked || busy || loading || !available;
    days.removeAttribute('aria-invalid');
    byId('history-days-error').textContent = '';
    remove.disabled = true;
    remove.textContent = busy ? 'Deleting…' : 'Delete history';
    byId('history-options').disabled = busy || loading || !available;
    byId('history-close').disabled = busy;
    byId('history-cancel').disabled = busy;
    byId('history-retry').disabled = busy || loading;
    exportStats.disabled = busy || loading || !available || entries.length === 0;
    form.setAttribute('aria-busy', String(busy || loading));
    if (busy) return;
    if (loading || !available) {
      byId('history-selection').textContent = loading ? 'Reading history…' : 'History could not be read.';
      return;
    }
    try {
      plan = planHistoryDeletion(entries, { days: older.checked ? days.valueAsNumber : null });
    } catch (failure) {
      days.setAttribute('aria-invalid', 'true');
      byId('history-days-error').textContent = failure.message;
      byId('history-selection').textContent = 'Enter an age to preview deletion.';
      return;
    }
    byId('history-selection').textContent = plan.count
      ? imageCount(plan.count) + ' · ' + sizeLabel(plan.bytes) + ' selected for deletion.'
      : entries.length === 0
        ? 'No saved history to delete.'
        : 'No images older than ' + days.valueAsNumber + ' days.';
    if (entries.some((entry) => !isHistoryTimestamp(entry.createdAt))) {
      byId('history-selection').textContent += ' Entries with unknown dates are included only in All history.';
    }
    remove.disabled = plan.count === 0;
    if (plan.count) remove.textContent = 'Delete ' + imageCount(plan.count);
  }

  async function refresh() {
    if (workspace.hidden || busy) return;
    const currentRevision = ++revision;
    loading = true;
    error.textContent = '';
    byId('history-retry').hidden = true;
    renderSelection();
    try {
      const records = await listHistory();
      if (currentRevision !== revision || workspace.hidden) return;
      entries = records;
      available = true;
      const summary = summarizeHistory(entries);
      usage.textContent = sizeLabel(summary.bytes);
      byId('history-summary').textContent = sizeLabel(summary.bytes) + ' stored · ' + imageCount(summary.count);
      if (!Number.isFinite(summary.bytes)) error.textContent = 'Some history size metadata is unreadable. New previews remain downloadable, but local saving is paused until cleanup.';
    } catch (failure) {
      if (currentRevision !== revision || workspace.hidden) return;
      available = false;
      entries = [];
      usage.textContent = 'Storage unavailable';
      byId('history-summary').textContent = 'Storage unavailable';
      error.textContent = failure instanceof HistoryStorageError ? failure.message : 'Local history could not be read. Try again.';
      byId('history-retry').hidden = false;
    } finally {
      if (currentRevision === revision) {
        loading = false;
        renderSelection();
      }
    }
  }

  function close() {
    revision += 1;
    loading = false;
    plan = null;
    if (dialog.open) dialog.close();
  }

  trigger.addEventListener('click', () => {
    if (workspace.hidden || dialog.open) return;
    older.checked = true;
    days.value = '30';
    status.textContent = '';
    error.textContent = '';
    dialog.showModal();
    void refresh();
  });

  exportStats.addEventListener('click', () => {
    if (!dialog.open || workspace.hidden || busy || loading || !available || !entries.length) return;
    let url;
    const link = document.createElement('a');
    try {
      const report = createStatsExport(entries);
      url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2) + '\n'], { type: 'application/json' }));
      link.href = url;
      link.download = 'decoration-render-stats-' + report.exportedAt.replace(/[:.]/g, '-') + '.json';
      dialog.append(link);
      link.click();
      status.textContent = 'Exported stats for ' + imageCount(report.renders.length) + '.';
    } catch {
      error.textContent = 'Stats could not be exported. Try again.';
    } finally {
      link.remove();
      if (url) setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!dialog.open || workspace.hidden || busy || loading || !plan?.count) return;
    const ids = [...plan.ids];
    const currentRevision = ++revision;
    busy = true;
    error.textContent = '';
    status.textContent = '';
    renderSelection();
    try {
      const removed = await deleteHistoryEntries(ids);
      if (currentRevision === revision && dialog.open) {
        status.textContent = removed.count
          ? 'Deleted ' + imageCount(removed.count) + ' (' + sizeLabel(removed.bytes) + ').'
          : 'The selected history was already removed. Nothing else was deleted.';
      }
    } catch (failure) {
      if (currentRevision === revision && dialog.open) {
        error.textContent = failure instanceof HistoryStorageError ? failure.message : 'History could not be deleted. Try again.';
      }
    } finally {
      busy = false;
      renderSelection();
      // Refresh counts after the write transaction commits, never optimistically.
      if (currentRevision === revision) {
        const deletionError = error.textContent;
        await refresh();
        if (deletionError && dialog.open && !error.textContent) error.textContent = deletionError;
      }
    }
  });

  for (const input of [days, older, byId('history-all')]) {
    input.addEventListener('input', () => {
      status.textContent = '';
      renderSelection();
    });
  }
  byId('history-retry').addEventListener('click', () => { void refresh(); });
  byId('history-close').addEventListener('click', close);
  byId('history-cancel').addEventListener('click', close);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    if (!busy) close();
  });
  subscribeToHistory(() => { void refresh(); });
  window.addEventListener('focus', () => { void refresh(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refresh();
  });

  return { refresh, close };
}
