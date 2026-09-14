/**
 * The DOM half of the app: render state, and turn browser events into
 * controller calls. All of the workflow rules live in controller.js.
 */

import { APP, NOTES, OUTPUT, PROVIDER, TIMING, UPLOAD } from './config.js';
import { managedPromptText, PROMPT_VERSION } from './prompt.js';
import { formatBytes } from './validation.js';

const byId = (id) => document.getElementById(id);

function setText(element, value) {
  if (element) element.textContent = value ?? '';
}

function setHidden(element, hidden) {
  if (element) element.hidden = Boolean(hidden);
}

function setInvalid(input, invalid) {
  if (!input) return;
  if (invalid) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

function describeUsage(usage) {
  if (!usage || typeof usage !== 'object') return 'Not reported.';
  const parts = [];
  if (Number.isFinite(usage.input_tokens)) parts.push(`${usage.input_tokens} input`);
  if (Number.isFinite(usage.output_tokens)) parts.push(`${usage.output_tokens} output`);
  if (Number.isFinite(usage.total_tokens)) parts.push(`${usage.total_tokens} total`);
  return parts.length ? `${parts.join(', ')} tokens` : 'Not reported.';
}

/** Read a chosen file's pixel dimensions, or null if the browser cannot decode it. */
async function readImageDimensions(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      const dimensions = { width: bitmap.width, height: bitmap.height };
      bitmap.close?.();
      return dimensions;
    } catch {
      // Fall through to the <img> path, which some browsers handle instead.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => resolve(null);
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function createView() {
  const elements = {
    name: byId('tester-name'),
    nameError: byId('tester-name-error'),
    key: byId('api-key'),
    keyError: byId('api-key-error'),
    connect: byId('connect-button'),
    disconnect: byId('disconnect-button'),
    connectionStatus: byId('connection-status'),

    file: byId('source-file'),
    fileError: byId('source-file-error'),
    fileAdvice: byId('source-file-advice'),
    sourcePreview: byId('source-preview'),
    sourceImage: byId('source-image'),
    sourceDetails: byId('source-details'),

    notes: byId('notes'),
    notesCount: byId('notes-count'),
    notesError: byId('notes-error'),
    managedPrompt: byId('managed-prompt'),

    summaryModel: byId('summary-model'),
    summaryOutput: byId('summary-output'),
    summaryPrompt: byId('summary-prompt'),
    generate: byId('generate-button'),
    pending: byId('pending-indicator'),
    pendingText: byId('pending-text'),

    errorPanel: byId('error-panel'),
    errorTitle: byId('error-title'),
    errorMessage: byId('error-message'),
    errorMeta: byId('error-meta'),

    resultCard: byId('result-card'),
    compareSource: byId('compare-source'),
    compareResult: byId('compare-result'),
    download: byId('download-link'),
    resultFilename: byId('result-filename'),
    resultSource: byId('result-source'),
    resultGenerated: byId('result-generated'),
    resultSettings: byId('result-settings'),
    resultPrompt: byId('result-prompt'),
    resultRequestId: byId('result-request-id'),
    resultUsage: byId('result-usage'),

    phaseBadge: byId('phase-badge'),
    buildLine: byId('build-line'),
  };

  /** Object URLs for images currently on screen, revoked together. */
  const objectUrls = new Map();
  let elapsedTimer = null;
  let pendingSince = null;
  let controller = null;

  function urlFor(blob) {
    if (!blob) return '';
    let url = objectUrls.get(blob);
    if (!url) {
      url = URL.createObjectURL(blob);
      objectUrls.set(blob, url);
    }
    return url;
  }

  /**
   * Revoke the object URL of every image the current state no longer shows.
   * Runs at the end of each render, so a superseded result is released as soon
   * as it leaves the page rather than lingering until disconnect.
   */
  function releaseUnusedImages(state) {
    const shown = new Set();
    if (state.source?.file) shown.add(state.source.file);
    if (state.result?.blob) shown.add(state.result.blob);
    // The result keeps its own mockup, which may no longer be the selected one.
    if (state.result?.source?.file) shown.add(state.result.source.file);

    for (const [blob, url] of objectUrls) {
      if (shown.has(blob)) continue;
      URL.revokeObjectURL(url);
      objectUrls.delete(blob);
    }
  }

  /**
   * Empty the form itself. The controller calls this as part of teardown, so
   * the Disconnect button and the page lifecycle clear the same things - a key
   * typed but never submitted included.
   */
  function resetFields() {
    for (const field of [elements.name, elements.key, elements.notes, elements.file]) {
      if (field) field.value = '';
    }
  }

  function releaseImages() {
    for (const url of objectUrls.values()) URL.revokeObjectURL(url);
    objectUrls.clear();
    if (elements.sourceImage) elements.sourceImage.removeAttribute('src');
    if (elements.compareSource) elements.compareSource.removeAttribute('src');
    if (elements.compareResult) elements.compareResult.removeAttribute('src');
    if (elements.download) elements.download.removeAttribute('href');
  }

  function stopElapsedTimer() {
    if (elapsedTimer !== null) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
    pendingSince = null;
  }

  function startElapsedTimer(startedAt) {
    pendingSince = new Date(startedAt).getTime();
    const tick = () => {
      const waited = Date.now() - pendingSince;
      setText(
        elements.pendingText,
        `Generating… ${formatDuration(waited)} elapsed. Please leave this tab open.`,
      );
    };
    tick();
    elapsedTimer = setInterval(tick, TIMING.elapsedTickMs);
  }

  function renderConnection(state) {
    setText(elements.nameError, state.nameError);
    setInvalid(elements.name, Boolean(state.nameError));
    setText(elements.keyError, state.keyError);
    setInvalid(elements.key, Boolean(state.keyError));

    if (elements.name) elements.name.disabled = state.connected || state.connecting;
    if (elements.key) elements.key.disabled = state.connected || state.connecting;
    if (elements.connect) {
      elements.connect.disabled = state.connecting || state.connected;
      elements.connect.textContent = state.connecting ? 'Checking the key…' : 'Connect';
    }
    setHidden(elements.disconnect, !state.connected && !state.connecting);
    if (elements.disconnect) {
      elements.disconnect.textContent = state.connecting ? 'Cancel and clear' : 'Disconnect and clear';
    }

    let tone = 'neutral';
    let message = 'Not connected.';

    if (state.connecting) {
      message = 'Asking OpenAI whether it accepts this key. Cancel and clear stops waiting.';
    } else if (state.access === 'rejected') {
      tone = 'bad';
      message = `OpenAI rejected this key. ${state.accessMessage}`.trim();
    } else if (state.connected && state.access === 'confirmed') {
      tone = state.modelAvailable === false ? 'warn' : 'good';
      message =
        `Connected as ${state.name}. Provider access confirmed. ` +
        (state.modelAvailable === false
          ? `${PROVIDER.model} was not listed for this account, so a preview may still be refused.`
          : `${PROVIDER.model} is available to this account.`);
    } else if (state.connected) {
      tone = 'warn';
      message =
        `Connected as ${state.name}. Key supplied, but provider access is not confirmed. ` +
        state.accessMessage;
    } else if (state.keyWarning) {
      tone = 'warn';
      message = state.keyWarning;
    }

    setText(elements.connectionStatus, message);
    if (elements.connectionStatus) elements.connectionStatus.dataset.tone = tone;
  }

  function renderSource(state) {
    setText(elements.fileError, state.sourceError);
    setInvalid(elements.file, Boolean(state.sourceError));

    const advice = state.source?.advice || '';
    setText(elements.fileAdvice, advice);
    setHidden(elements.fileAdvice, !advice);

    if (!state.source) {
      setHidden(elements.sourcePreview, true);
      return;
    }

    setHidden(elements.sourcePreview, false);
    if (elements.sourceImage) elements.sourceImage.src = urlFor(state.source.file);
    setText(
      elements.sourceDetails,
      `${state.source.name} · ${state.source.width}×${state.source.height} px · ` +
        `${formatBytes(state.source.size)}`,
    );
  }

  function renderRequestSummary(state) {
    setText(elements.summaryModel, `${PROVIDER.model} · image edit · one request per press`);
    setText(
      elements.summaryOutput,
      state.request.size
        ? `${state.request.size} · ${OUTPUT.quality} quality · ${OUTPUT.outputFormat.toUpperCase()}` +
            (state.request.aspectRatioClamped ? ' · source shape clamped to the supported range' : '')
        : `Chosen from the mockup's shape · ${OUTPUT.quality} quality · ${OUTPUT.outputFormat.toUpperCase()}`,
    );
    setText(
      elements.summaryPrompt,
      `Managed ${APP.treatment.toLowerCase()} instruction ${PROMPT_VERSION}` +
        (state.request.hasNotes ? ', plus your additional instructions' : ', with no additional instructions'),
    );
  }

  function renderPending(state) {
    if (elements.generate) elements.generate.disabled = !state.canGenerate;
    // The mockup and notes are part of the request in flight; they cannot change
    // under it without making the result describe something that was not sent.
    if (elements.file) elements.file.disabled = state.pending;
    if (elements.notes) elements.notes.disabled = state.pending;
    setHidden(elements.pending, !state.pending);

    if (state.pending && elapsedTimer === null && state.startedAt) {
      startElapsedTimer(state.startedAt);
    } else if (!state.pending) {
      stopElapsedTimer();
    }
  }

  function renderError(state) {
    if (!state.error) {
      setHidden(elements.errorPanel, true);
      return;
    }
    setHidden(elements.errorPanel, false);
    setText(elements.errorTitle, state.error.title);
    setText(elements.errorMessage, state.error.message);

    const meta = [];
    if (state.error.mayBeBilled) {
      meta.push('This attempt may still appear in your OpenAI usage records.');
    }
    if (state.error.requestId) {
      meta.push(`OpenAI request id: ${state.error.requestId}`);
    }
    setText(elements.errorMeta, meta.join(' '));
    setHidden(elements.errorMeta, meta.length === 0);
  }

  function renderResult(state) {
    if (!state.result) {
      setHidden(elements.resultCard, true);
      // The URLs behind these are about to be revoked; do not leave the hidden
      // card pointing at them.
      elements.compareResult?.removeAttribute('src');
      elements.download?.removeAttribute('href');
      return;
    }
    const { result } = state;
    setHidden(elements.resultCard, false);

    // Compare against the mockup that was submitted, never the current selection.
    if (elements.compareSource && result.source?.file) {
      elements.compareSource.src = urlFor(result.source.file);
      elements.compareSource.alt = `The mockup you supplied: ${result.source.name}`;
    }
    if (elements.compareResult) elements.compareResult.src = urlFor(result.blob);
    if (elements.download) {
      elements.download.href = urlFor(result.blob);
      elements.download.setAttribute('download', result.filename);
    }
    setText(elements.resultFilename, result.filename);
    setText(elements.resultSource, `${result.source?.name ?? 'unknown'} · submitted by ${result.testerName}`);

    setText(
      elements.resultGenerated,
      `${new Date(result.receivedAt).toLocaleString()} · took ${formatDuration(result.elapsedMs)} · ` +
        `attempt ${state.attempts} in this session`,
    );
    setText(
      elements.resultSettings,
      `${PROVIDER.model} · ${result.size} · ${result.quality} quality · ` +
        `${String(result.outputFormat).toUpperCase()}`,
    );
    setText(
      elements.resultPrompt,
      `${result.promptVersion}${result.hasNotes ? ' with additional instructions' : ' with no additional instructions'}`,
    );
    setText(elements.resultRequestId, result.requestId || 'Not returned.');
    setText(elements.resultUsage, describeUsage(result.usage));
  }

  function render(state) {
    renderConnection(state);
    renderSource(state);
    setText(elements.notesError, state.notesError);
    setInvalid(elements.notes, Boolean(state.notesError));
    setText(elements.notesCount, `${state.notesRemaining} characters remaining`);
    renderRequestSummary(state);
    renderPending(state);
    renderError(state);
    renderResult(state);
    releaseUnusedImages(state);
  }

  function bind(boundController) {
    controller = boundController;

    setText(elements.phaseBadge, APP.phase);
    setText(elements.managedPrompt, managedPromptText());
    setText(
      elements.buildLine,
      `${APP.name} · ${APP.phase} · instruction ${PROMPT_VERSION} · ` +
        `${PROVIDER.model} · uploads up to ${formatBytes(UPLOAD.maxBytes)}`,
    );
    if (elements.file) elements.file.setAttribute('accept', UPLOAD.acceptAttribute);
    if (elements.notes) elements.notes.setAttribute('maxlength', String(NOTES.maxLength));

    elements.name?.addEventListener('input', (event) => controller.setName(event.target.value));
    elements.key?.addEventListener('input', (event) => controller.setApiKey(event.target.value));
    elements.notes?.addEventListener('input', (event) => controller.setNotes(event.target.value));

    elements.connect?.addEventListener('click', async () => {
      const connected = await controller.connect({
        name: elements.name?.value ?? '',
        apiKey: elements.key?.value ?? '',
      });
      // The controller holds the key from here on; the input should not.
      if (elements.key) elements.key.value = '';
      if (!connected) elements.key?.focus();
    });

    elements.disconnect?.addEventListener('click', () => {
      controller.disconnect();
      elements.name?.focus();
    });

    elements.file?.addEventListener('change', async (event) => {
      // Claim this selection before the await: the controller refuses the commit
      // if a newer file was chosen, or the session was cleared, in the meantime.
      const token = controller.beginSourceSelection();
      const file = event.target.files?.[0] ?? null;
      if (!file) {
        controller.commitSourceSelection(token, null);
        return;
      }
      const dimensions = await readImageDimensions(file);
      controller.commitSourceSelection(token, file, dimensions);
    });

    elements.generate?.addEventListener('click', () => {
      void controller.generate();
    });

    window.addEventListener('beforeunload', (event) => {
      if (!controller.state.pending) return;
      event.preventDefault();
      // Set for browsers that still require it before showing their own prompt.
      event.returnValue = '';
    });

    // Reloading, navigating away or closing the tab must leave nothing behind,
    // in the controller or in the form (D-026).
    window.addEventListener('pagehide', () => controller.disconnect());

    // A page restored from the back/forward cache brings its DOM back with it,
    // so clear again rather than trusting that pagehide was the end of it.
    window.addEventListener('pageshow', (event) => {
      if (event.persisted) controller.disconnect();
    });

    render(controller.state);
  }

  return { render, releaseImages, resetFields, bind };
}
