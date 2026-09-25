/**
 * Single-source workspace: explicit single/paired requests, immutable settings,
 * memory-only credentials (owned by the gate), and local result history.
 */
import { NOTES, TIMING, UPLOAD } from './config.js';
import { mountAccessGate } from './access-gate.js?v=20260924-auto-connect';
import { mountHistoryControls } from './history-controls.js?v=20260924-stats';
import { mountHistoryGallery } from './history-gallery.js?v=20260924-stats';
import { getRenderStats } from './render-stats.js?v=20260924-stats';
import { buildPrompt } from './prompt.js?v=20260924-sizing';
import { makeAbortReason, ProviderError } from './openai.js?v=20260924-sizing';
import { formatBytes, validateImageFile } from './validation.js';
import { DEFAULT_SETTINGS, effortsForModel, loadSettings, normalizeSettings, outputMode, rememberSettings } from './settings.js?v=20260924-sizing';
import { planOutput } from './size.js?v=20260924-sizing';
import { planGeneration } from './generation-plan.js?v=20260924-sizing';
import { outputFilename, prepareOutput } from './image-output.js?v=20260924-hardening';
import { digitsOnly, namedOutputFilename, namingError, historyOutputName } from './output-naming.js?v=20260923-optional-number';
import { assertImageDimensions, inspectImageBlob, RESOURCE_LIMITS, ResourceLimitError } from './resource-limits.js';
import { validateEmbroiderySize } from './embroidery-size.js?v=20260924-sizing';

const byId = (id) => document.getElementById(id);
const model = byId('model-select');
const effort = byId('effort-select');
const transparency = byId('transparency-output');
const framing = byId('framing-field');
const resolution = byId('output-size');
const designWidth = byId('design-width');
const designHeight = byId('design-height');
const fileInput = byId('source-file');
const sourceImage = byId('source-image');
const notes = byId('notes');
const outputName = byId('output-name');
const outputNumber = byId('output-number');
const historyControls = mountHistoryControls();
const gallery = mountHistoryGallery({ onSelect: selectResult, onNotice: notify, onRiskChange: updateNavigationGuard });
let connected = false;
let source = null;
let sourceUrl = null;
let sourceLoading = false;
let selectionId = 0;
let result = null;
let resultUrl = null;
let job = null;
let navigationGuardAttached = false;
let toastTimer = null;
let preferenceWarning = '';

notes.maxLength = NOTES.maxLength;
fileInput.accept = UPLOAD.acceptAttribute;

function warnBeforeLeaving(event) {
  if (!job && !gallery.hasPendingResults()) return;
  event.preventDefault();
  event.returnValue = ''; // Browsers supply their own text; some suppress it.
}

function updateNavigationGuard() {
  const needed = Boolean(job) || gallery.hasPendingResults();
  if (needed === navigationGuardAttached) return;
  navigationGuardAttached = needed;
  if (needed) window.addEventListener('beforeunload', warnBeforeLeaving);
  else window.removeEventListener('beforeunload', warnBeforeLeaving);
}

function notify(message) {
  if (!connected) return;
  clearTimeout(toastTimer);
  byId('toast-message').textContent = message;
  byId('workspace-toast').hidden = false;
  toastTimer = setTimeout(clearToast, 9000);
}

function clearToast() {
  clearTimeout(toastTimer);
  byId('workspace-toast').hidden = true;
  byId('toast-message').textContent = '';
}

function readSettings() {
  return normalizeSettings({
    decorationType: byId('decoration-type').value, model: model.value, effort: effort.value,
    transparency: transparency.checked, framing: framing.querySelector('input:checked').value,
    resolution: resolution.value, notes: notes.value,
    designWidthInches: designWidth.value, designHeightInches: designHeight.value,
    outputName: outputName.value, outputNumber: outputNumber.value,
  });
}

function applySettings(settings) {
  model.value = settings.model;
  effort.value = settings.effort;
  transparency.checked = settings.transparency;
  for (const input of framing.querySelectorAll('input')) input.checked = input.value === settings.framing;
  resolution.value = settings.resolution;
  designWidth.value = settings.designWidthInches;
  designHeight.value = settings.designHeightInches;
  notes.value = settings.notes;
  outputName.value = settings.outputName;
  outputNumber.value = settings.outputNumber;
  byId('decoration-type').value = settings.decorationType;
}

function renderEffortOptions() {
  const allowed = effortsForModel(model.value);
  for (const option of effort.options) {
    option.disabled = !allowed.includes(option.value);
    if (option.value === 'xhigh' || option.value === 'max') {
      option.textContent = (option.value === 'xhigh' ? 'Extra high' : 'Max') + (option.disabled ? ' · 2.5' : '');
    }
  }
  if (!allowed.includes(effort.value)) {
    effort.value = 'high';
    notify('This model supports up to High effort. Effort changed to High for the next request.');
  }
}

function renderCanvas() {
  const settings = result?.parameters || job?.settings || readSettings();
  const details = result?.details || {};
  byId('preview-stage').dataset.transparent = String(result
    ? details.hasTransparency ?? settings.transparency
    : settings.transparency);
  byId('preview-stage').setAttribute('aria-busy', String(Boolean(job)));
  byId('output-mode').textContent = outputMode(settings);
  byId('result-card').hidden = !result;
  byId('pending-indicator').hidden = !job;
  byId('download-result').disabled = !result;
  byId('download-result').title = result ? 'Download ' + historyOutputName(result) : 'Generate or select an output to download.';
  const statsPanel = byId('result-stats');
  statsPanel.hidden = !result;
  statsPanel.replaceChildren();
  if (result) {
    const dimensions = details.width && details.height ? details.width + ' × ' + details.height + ' px · ' : '';
    byId('canvas-description').textContent = dimensions +
      (result.saveState === 'saved' ? 'Saved locally' : result.saveState === 'saving' ? 'Saving locally…' : 'Not saved');
    if (details.pairId) byId('canvas-description').textContent += ' · Pair ' + details.pairId.slice(0, 6);
    byId('canvas-source').textContent = historyOutputName(result);
    byId('canvas-source').title = 'Source: ' + result.sourceName;
    const stats = getRenderStats(result);
    const design = stats.size.embroideryInches;
    const requested = stats.size.requestedPixels;
    const fields = [
      ['Source image', stats.sourceFilename || 'Not recorded'],
      ['Model', [...model.options].find((option) => option.value === stats.model)?.textContent || stats.model || 'Not recorded'],
      ['Effort', ({ low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' })[stats.effort] || stats.effort || 'Not recorded'],
      ['Resolution', [...resolution.options].find((option) => option.value === stats.size.resolution)?.textContent || stats.size.resolution || 'Not recorded'],
      ['Embroidery size', design ? design.width + 'W × ' + design.height + 'H in' : 'Not supplied'],
      ['Render size', requested ? requested.width + ' × ' + requested.height + ' px' : 'Not recorded'],
      ['Time to generate', stats.timeToGenerateSeconds === null ? 'Not recorded' : stats.timeToGenerateSeconds.toFixed(1) + ' s'],
    ];
    for (const [label, value] of fields) {
      const field = document.createElement('div');
      const term = document.createElement('dt');
      const description = document.createElement('dd');
      term.textContent = label;
      description.textContent = value;
      field.append(term, description);
      statsPanel.append(field);
    }
    const warnings = [...(details.warnings || [])];
    if (result.saveState === 'unsaved') warnings.push(result.saveError + ' Download before refreshing or disconnecting.');
    byId('result-warning').textContent = warnings.join(' ');
    byId('result-status').hidden = warnings.length === 0;
    byId('retry-save').hidden = result.saveState !== 'unsaved';
  } else {
    byId('canvas-description').textContent = settings.transparency
      ? (settings.framing === 'solo' ? 'Artwork fills the canvas · PNG' : 'Original placement · PNG')
      : 'Original composition · Product retained';
    byId('canvas-source').textContent = source ? 'Source: ' + source.width + ' × ' + source.height + ' px' : 'No mockup selected';
    byId('canvas-source').title = '';
    byId('result-status').hidden = true;
    byId('retry-save').hidden = true;
  }
}

function renderControls() {
  updateNavigationGuard();
  const settings = readSettings();
  const nameError = namingError(settings);
  const designSize = validateEmbroiderySize(settings);
  byId('design-size-error').textContent = designSize.error;
  for (const [key, input] of [['designWidthInches', designWidth], ['designHeightInches', designHeight]]) {
    input.required = Boolean(settings.designWidthInches || settings.designHeightInches);
    const invalid = designSize.invalidFields.includes(key);
    input.setCustomValidity(invalid ? designSize.error : '');
    if (invalid) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }
  const filename = namedOutputFilename(settings, { preview: true });
  byId('output-filename').textContent = filename;
  byId('output-filename').title = filename;
  byId('output-filename').dataset.incomplete = String(Boolean(nameError));
  framing.disabled = !settings.transparency;
  byId('framing-help').textContent = !settings.transparency
    ? 'Enable transparency to choose isolated artwork framing.'
    : settings.framing === 'solo'
      ? 'Fill the output with embroidery while preserving its proportions.'
      : 'Export on the source canvas. Check artwork alignment before use.';
  byId('notes-count').textContent = notes.value.length + ' / ' + NOTES.maxLength;
  byId('managed-prompt').textContent = designSize.error || buildPrompt(settings.notes, settings).text;
  let validPlan = false;
  let planError = '';
  let sizeText = '';
  if (source) {
    try {
      const plan = planOutput(source.width, source.height, settings);
      validPlan = true;
      sizeText = 'Render ' + plan.width + ' × ' + plan.height + ' px · Export ' + plan.exportWidth + ' × ' + plan.exportHeight + ' px.';
      if (plan.atSize) sizeText += ' At-size uses the original source canvas.';
      if (plan.experimental) sizeText += ' Experimental high-resolution size.';
      if (plan.aspectRatioClamped) sizeText += ' Solo uses a supported canvas aspect ratio.';
    } catch (error) { planError = error.message; sizeText = planError; }
  }
  byId('resolution-help').textContent = sizeText;
  byId('resolution-help').hidden = !sizeText;
  const unavailableReason = !connected ? 'Connect before generating a preview.'
    : job ? (job.paired ? 'Paired run' : 'One request') + ' in progress. Changed settings apply to the next run.'
      : sourceLoading ? 'Reading the selected image…'
        : byId('source-file-error').textContent || (!source ? 'Select a mockup to generate one preview.' : nameError || designSize.error);
  const blockedReason = unavailableReason || planError;
  const ready = !unavailableReason && validPlan;
  byId('generate-button').disabled = !ready;
  byId('generate-button').title = ready ? 'Generate one image using the selected model and parameters.' : blockedReason;
  byId('remember-settings').disabled = !connected || Boolean(designSize.error);
  byId('cancel-generation').hidden = !job;
  byId('cancel-generation').disabled = Boolean(job?.stopRequested);
  byId('cancel-generation').textContent = job?.paired ? 'Stop remaining outputs' : 'Stop waiting';
  byId('generation-help').textContent = ready
    ? 'Ready · One paid request · No automatic retries'
    : blockedReason;
  renderCanvas();
}

function selectResult(next) {
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultUrl = null;
  result = next;
  const image = byId('compare-result');
  image.removeAttribute('src');
  if (next) {
    resultUrl = URL.createObjectURL(next.blob);
    image.src = resultUrl;
    image.alt = historyOutputName(next) + ' · ' + outputMode(next.parameters);
  }
  renderCanvas();
}

function releaseSource() {
  if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  sourceUrl = null;
  source = null;
  sourceLoading = false;
  sourceImage.removeAttribute('src');
  byId('source-preview').hidden = true;
  byId('source-details').textContent = '';
  byId('upload-title').textContent = 'Choose a product mockup';
}

function showFileError(message) {
  byId('source-file-error').textContent = message;
  fileInput.setAttribute('aria-invalid', 'true');
  renderControls();
}

fileInput.addEventListener('change', async () => {
  const currentSelection = ++selectionId;
  const file = fileInput.files?.[0];
  releaseSource();
  byId('source-file-error').textContent = '';
  fileInput.removeAttribute('aria-invalid');
  renderControls();
  if (!file) return;
  const checked = validateImageFile(file);
  if (!checked.ok) { showFileError(checked.message); return; }
  sourceLoading = true;
  renderControls();
  try { await inspectImageBlob(file, { maxBytes: RESOURCE_LIMITS.sourceBytes }); }
  catch (error) {
    if (!connected || currentSelection !== selectionId) return;
    releaseSource();
    showFileError(error.message);
    return;
  }
  if (!connected || currentSelection !== selectionId) return;
  sourceUrl = URL.createObjectURL(file);
  const image = new Image();
  image.onload = () => {
    if (!connected || currentSelection !== selectionId) return;
    try { assertImageDimensions(image.naturalWidth, image.naturalHeight); }
    catch (error) { releaseSource(); showFileError(error.message); return; }
    sourceLoading = false;
    source = { file, width: image.naturalWidth, height: image.naturalHeight };
    sourceImage.src = sourceUrl;
    byId('source-preview').hidden = false;
    byId('source-details').textContent = file.name + ' · ' + source.width + ' × ' + source.height + ' px · ' + formatBytes(file.size);
    byId('upload-title').textContent = 'Choose a different mockup';
    renderControls();
  };
  image.onerror = () => {
    if (currentSelection !== selectionId) return;
    releaseSource();
    showFileError('This image could not be read. Try another PNG, JPEG or WebP.');
  };
  image.src = sourceUrl;
});

function showError(title, message) {
  byId('error-title').textContent = title;
  byId('error-message').textContent = message;
  byId('error-panel').hidden = false;
}

function stopJob() {
  if (!job) return;
  const stopped = job;
  job = null; // Ignore any late response, including one from a new session.
  clearTimeout(stopped.deadline);
  clearInterval(stopped.ticker);
  stopped.aborter.abort(makeAbortReason('cancelled'));
  stopped.preparationAborter?.abort(makeAbortReason('cancelled'));
  stopped.keepOriginal?.();
  return stopped;
}

async function generate(paired = false) {
  if (!connected || !source || sourceLoading || job) return;
  const submittedSource = { ...source };
  const settings = readSettings();
  const nameError = namingError(settings);
  if (nameError) { showError('Name the output', nameError); return; }
  const designSize = validateEmbroiderySize(settings);
  if (designSize.error) {
    showError('Check embroidery size', designSize.error);
    (designSize.invalidFields[0] === 'designWidthInches' ? designWidth : designHeight).focus();
    return;
  }
  const filename = namedOutputFilename(settings);
  let outputs;
  try { outputs = planGeneration(submittedSource, settings, paired); }
  catch (error) { showError('Check output dimensions', error.message); return; }
  const current = {
    id: crypto.randomUUID(), paired, settings: outputs[0].settings,
    index: 0, completed: 0, failures: [], received: false, stopRequested: false,
    aborter: new AbortController(), startedAt: Date.now(), phase: 'Waiting for image output',
  };
  job = current;
  byId('error-panel').hidden = true;
  clearToast();
  const tick = () => {
    byId('pending-title').textContent = paired
      ? (current.index === 0 ? 'Generating product' : 'Generating solo') + ' · ' + (current.index + 1) + ' of 2'
      : 'Generating preview';
    byId('pending-text').textContent = current.phase + ' · ' + Math.floor((Date.now() - current.startedAt) / 1000) + 's · ' + current.settings.model + ' / ' + current.settings.effort +
      (paired ? ' · ' + current.completed + ' completed' + (current.failures.length ? ' · ' + current.failures.length + ' failed' : '') : '');
  };
  current.ticker = setInterval(tick, TIMING.elapsedTickMs);
  try {
    // These are distinct requested outputs, not n=2 variants of one prompt.
    // Both plans were validated above; each is attempted once, sequentially.
    for (const [index, output] of outputs.entries()) {
      if (!connected || job !== current) return;
      if (current.stopRequested) break;
      const { settings, prompt, plan, role, label } = output;
      const id = paired ? crypto.randomUUID() : current.id;
      current.index = index;
      current.settings = settings;
      current.startedAt = Date.now();
      current.phase = 'Waiting for image output';
      current.received = false;
      current.aborter = new AbortController();
      current.deadline = setTimeout(() => current.aborter.abort(makeAbortReason('timeout')), TIMING.requestTimeoutMs);
      tick();
      renderControls();
      try {
        const requestStartedAt = performance.now();
        const response = await gate.requestPreview({
          file: submittedSource.file, prompt: prompt.text, size: plan.size,
          model: settings.model, quality: settings.effort, transparency: settings.transparency,
          signal: current.aborter.signal,
        });
        const timeToGenerateSeconds = Math.round((performance.now() - requestStartedAt) / 100) / 10;
        if (!connected || job !== current) return;
        // The provider has finished. A slow local export must not discard it.
        clearTimeout(current.deadline);
        current.received = true;
        current.phase = 'Inspecting and preparing PNG';
        tick();
        current.preparationAborter = new AbortController();
        const original = (reason) => ({ blob: response.blob, warnings: [reason + ' Download retains the original provider PNG; dimensions and transparency are unverified.'] });
        // Stop can retain the received bytes immediately, even if the local
        // decoder/export never settles. It is not another provider request.
        const keepOriginal = new Promise((resolve) => {
          current.keepOriginal = () => resolve(original('Local preparation was stopped.'));
        });
        const preparing = prepareOutput(response.blob, plan, settings, { signal: current.preparationAborter.signal })
          .catch((error) => {
            if (error instanceof ResourceLimitError) throw error;
            return original('Local image inspection/export failed.');
          });
        const prepared = await Promise.race([preparing, keepOriginal]);
        current.keepOriginal = null;
        if (!connected || job !== current) return;
        if (current.aborter.signal.aborted) throw current.aborter.signal.reason;
        const createdAt = Date.now();
        gallery.add({
          id, createdAt, image: prepared.blob, sourceImage: submittedSource.file,
          sourceName: submittedSource.file.name, parameters: settings,
          details: {
            filename, timeToGenerateSeconds,
            promptVersion: prompt.version, requestId: response.requestId, requestedSize: plan.size,
            sourceWidth: submittedSource.width, sourceHeight: submittedSource.height,
            width: prepared.width, height: prepared.height, hasTransparency: prepared.hasTransparency,
            warnings: prepared.warnings, inputTokens: response.usage?.input_tokens,
            outputTokens: response.usage?.output_tokens, totalTokens: response.usage?.total_tokens,
            ...(paired ? { pairId: current.id, pairRole: role } : {}),
          },
        });
        current.completed += 1;
      } catch (error) {
        if (!connected || job !== current) return;
        const failure = {
          label,
          title: error instanceof ProviderError ? error.title : current.aborter.signal.aborted ? 'Request timed out' : 'Preview could not be completed',
          message: error instanceof ProviderError ? error.message :
            'No usable response was received before the page stopped waiting. The request may still be billed. Check OpenAI usage before trying again; there are no automatic retries.',
        };
        current.failures.push(failure);
        if (!paired) showError(failure.title, failure.message);
      } finally { clearTimeout(current.deadline); }
    }
    if (!connected || job !== current) return;
    if (current.stopRequested) {
      notify('Stopped. The received PNG is available for download and local history. No remaining output was requested.');
    } else if (paired && current.failures.length) {
      showError(current.completed ? 'Pair partially completed' : 'Pair could not be completed',
        current.completed + ' of 2 outputs completed. ' + (current.completed ? 'Completed output remains available in history for download. ' : '') +
        current.failures.map((failure) => failure.label + ': ' + failure.title + '. ' + failure.message).join(' ') +
        ' Each output was attempted once. No automatic retries.');
    } else if (paired) notify('Product + solo complete. Select either image in history to download.');
  } finally {
    clearTimeout(current.deadline);
    clearInterval(current.ticker);
    if (job === current) { job = null; renderControls(); }
  }
}

byId('generate-button').addEventListener('click', () => { void generate(); });
byId('cancel-generation').addEventListener('click', () => {
  if (job?.received && job.keepOriginal) {
    job.stopRequested = true;
    job.keepOriginal();
    job.preparationAborter.abort(makeAbortReason('cancelled'));
    renderControls();
    return;
  }
  const stopped = stopJob();
  if (!stopped) return;
  renderControls();
  showError('Stopped waiting', (stopped.paired
    ? stopped.completed + ' of 2 outputs completed. Completed outputs remain in history for download. No unstarted output will be requested. ' : '') +
    'A request already received by OpenAI may still complete and be billed. Late results will not be saved. Check usage before starting another attempt.');
});
byId('dismiss-error').addEventListener('click', () => { byId('error-panel').hidden = true; });
byId('dismiss-toast').addEventListener('click', clearToast);
byId('download-result').addEventListener('click', () => {
  if (!result || !resultUrl) return;
  const link = document.createElement('a');
  link.href = resultUrl;
  link.download = result.details?.filename || outputFilename(result.sourceName, result.parameters, result.createdAt, result.id);
  document.body.append(link);
  link.click();
  link.remove();
});
byId('remember-settings').addEventListener('click', () => {
  if (validateEmbroiderySize(readSettings()).error) return;
  try {
    rememberSettings(readSettings());
    notify('Settings remembered in this browser, including additional instructions and output naming. Login name and API key are not saved.');
  } catch { notify('Settings could not be saved. Check this site’s browser-storage permissions.'); }
});
model.addEventListener('change', () => { renderEffortOptions(); renderControls(); });
for (const control of [effort, transparency, framing, resolution, byId('decoration-type')]) {
  control.addEventListener('change', renderControls);
}
notes.addEventListener('input', renderControls);
designWidth.addEventListener('input', renderControls);
designHeight.addEventListener('input', renderControls);
outputName.addEventListener('input', renderControls);
outputNumber.addEventListener('input', () => {
  // A text input with a numeric keyboard preserves leading zeroes and avoids
  // number inputs accepting signs, decimals, or exponent notation.
  const start = outputNumber.selectionStart;
  const caret = digitsOnly(outputNumber.value.slice(0, start)).length;
  outputNumber.value = digitsOnly(outputNumber.value);
  outputNumber.setSelectionRange(caret, caret);
  renderControls();
});

function resetWorkspace() {
  connected = false;
  stopJob();
  clearToast();
  historyControls.close();
  gallery.disconnect();
  selectionId += 1;
  fileInput.value = '';
  releaseSource();
  selectResult(null);
  byId('source-file-error').textContent = '';
  fileInput.removeAttribute('aria-invalid');
  byId('error-panel').hidden = true;
  preferenceWarning = '';
  let settings = DEFAULT_SETTINGS;
  try { settings = loadSettings(); }
  catch { preferenceWarning = 'Saved settings could not be read. Defaults are in use.'; }
  applySettings(settings);
  document.querySelector('.prompt-disclosure').open = false;
  renderEffortOptions();
  renderControls();
}

const gate = mountAccessGate({
  onConnect() {
    connected = true;
    renderControls();
    void historyControls.refresh();
    gallery.connect();
    if (preferenceWarning) notify(preferenceWarning);
  },
  onDisconnect: resetWorkspace,
});
