/**
 * The workflow, with no DOM in it.
 *
 * Everything that has to be checked - duplicate submission, late responses,
 * stale file decoding, disconnect clearing page state, one request per preview
 * - lives here so it can be driven directly by tests. `view.render(state)` is
 * called after every change; the view is also told when to drop held images and
 * when to clear its fields.
 *
 * The API key is a private field. It is never part of `state`, so it cannot
 * reach the DOM, an error message, or a serialised snapshot by accident.
 */

import { APP, NOTES, OUTPUT, PROVIDER, TIMING } from './config.js';
import { buildPrompt, PROMPT_VERSION } from './prompt.js';
import { checkProviderAccess, makeAbortReason, ProviderError, requestEmbroideryPreview } from './openai.js';
import { chooseOutputSize, FALLBACK_SIZE } from './size.js';
import {
  sourceSizeAdvice,
  validateApiKey,
  validateImageFile,
  validateName,
  validateNotes,
} from './validation.js';

const NO_OP_VIEW = { render() {}, releaseImages() {}, resetFields() {} };

function slug(value, fallback) {
  const cleaned = String(value || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return cleaned || fallback;
}

function timestamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function emptyState() {
  return {
    name: '',
    nameError: '',
    keyPresent: false,
    keyError: '',
    keyWarning: '',
    connected: false,
    connecting: false,
    /** 'unknown' until the provider has been asked about the key. */
    access: 'unknown',
    accessMessage: '',
    accessCheckedAt: null,
    modelAvailable: null,
    source: null,
    sourceError: '',
    notes: '',
    notesError: '',
    notesRemaining: NOTES.maxLength,
    pending: false,
    startedAt: null,
    attempts: 0,
    result: null,
    error: null,
    canGenerate: false,
    treatment: APP.treatment,
    request: {
      model: PROVIDER.model,
      quality: OUTPUT.quality,
      outputFormat: OUTPUT.outputFormat,
      promptVersion: PROMPT_VERSION,
      size: null,
      hasNotes: false,
    },
  };
}

export class PreviewController {
  #apiKey = '';
  /** Invalidates the reply to a request whose turn or session has moved on. */
  #runId = 0;
  /** Bumped only by teardown, so work started in a cleared session is dropped. */
  #sessionId = 0;
  /** Bumped per file selection, so a slow decode cannot overwrite a newer one. */
  #selectionId = 0;
  #abortController = null;
  #connectAbortController = null;
  #state = emptyState();

  /**
   * @param {object} [options]
   * @param {{ render: Function, releaseImages: Function, resetFields: Function }} [options.view]
   * @param {typeof fetch} [options.fetchImpl]
   * @param {() => Date} [options.now]
   * @param {number} [options.timeoutMs] Deadline for a generation request.
   * @param {number} [options.keyCheckTimeoutMs] Deadline for the key check.
   */
  constructor({
    view = NO_OP_VIEW,
    fetchImpl = globalThis.fetch,
    now = () => new Date(),
    timeoutMs = TIMING.requestTimeoutMs,
    keyCheckTimeoutMs = TIMING.keyCheckTimeoutMs,
  } = {}) {
    this.view = view;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.keyCheckTimeoutMs = keyCheckTimeoutMs;
  }

  get state() {
    return this.#state;
  }

  /** True when a generation request is allowed right now. */
  get canGenerate() {
    return Boolean(this.#state.canGenerate);
  }

  #update(changes) {
    const merged = { ...this.#state, ...changes };
    merged.canGenerate = Boolean(
      merged.connected && !merged.pending && merged.source && !merged.sourceError &&
      !merged.notesError && merged.name,
    );
    this.#state = merged;
    this.view.render(this.#state);
  }

  setName(rawName) {
    const checked = validateName(rawName);
    this.#update({
      name: checked.value,
      nameError: checked.ok ? '' : checked.message,
    });
    return checked.ok;
  }

  /** Holds the key privately and reports only whether one is present. */
  setApiKey(rawKey) {
    const checked = validateApiKey(rawKey);
    this.#apiKey = checked.ok ? checked.value : '';
    this.#update({
      keyPresent: checked.ok,
      keyError: checked.ok ? '' : checked.message,
      keyWarning: checked.warning || '',
    });
    return checked.ok;
  }

  /**
   * Connect the tester. Asks the provider whether it accepts the key, which is
   * a metadata call and not a generation, so "key supplied" and "provider
   * access confirmed" stay distinguishable (MVP-02).
   *
   * The check is bounded by `keyCheckTimeoutMs` and can be cancelled by
   * disconnecting, so a stalled request cannot leave the page stuck. A check
   * that does not finish leaves access inconclusive, which is a different thing
   * from the provider rejecting the key.
   */
  async connect({ name, apiKey } = {}) {
    if (name !== undefined && !this.setName(name)) return false;
    if (apiKey !== undefined && !this.setApiKey(apiKey)) return false;

    if (!this.setName(this.#state.name)) return false;
    if (!this.#state.keyPresent) {
      this.#update({ keyError: this.#state.keyError || 'Paste the API key you were assigned.' });
      return false;
    }

    const runId = (this.#runId += 1);
    this.#update({ connecting: true, accessMessage: '', error: null });

    const aborter = new AbortController();
    this.#connectAbortController = aborter;
    const deadline = setTimeout(() => aborter.abort(makeAbortReason('timeout')), this.keyCheckTimeoutMs);

    let outcome;
    try {
      outcome = await checkProviderAccess({
        apiKey: this.#apiKey,
        fetchImpl: this.fetchImpl,
        signal: aborter.signal,
      });
    } finally {
      clearTimeout(deadline);
      if (this.#connectAbortController === aborter) this.#connectAbortController = null;
    }

    // Cancelled, or the session was torn down while the check was outstanding.
    if (runId !== this.#runId) return false;

    if (outcome.access === 'rejected') {
      this.#apiKey = '';
      this.#update({
        connecting: false,
        connected: false,
        keyPresent: false,
        access: 'rejected',
        accessMessage: outcome.message,
        accessCheckedAt: this.now().toISOString(),
      });
      return false;
    }

    this.#update({
      connecting: false,
      connected: true,
      access: outcome.access,
      accessMessage: outcome.message,
      accessCheckedAt: this.now().toISOString(),
      modelAvailable: outcome.modelAvailable,
    });
    return true;
  }

  /**
   * Drop everything the page is holding: name, key, source image and result, in
   * the controller and in the view's fields (D-026).
   *
   * One teardown path serves the Disconnect button and the page lifecycle, so a
   * reload or a back/forward restore cannot leave a typed key sitting in the
   * form. Work already in flight is abandoned and its reply discarded.
   */
  disconnect() {
    this.#runId += 1;
    this.#sessionId += 1;
    this.#selectionId += 1;

    for (const aborter of [this.#abortController, this.#connectAbortController]) {
      aborter?.abort(makeAbortReason('cancelled'));
    }
    this.#abortController = null;
    this.#connectAbortController = null;

    this.#apiKey = '';
    this.view.releaseImages();
    this.view.resetFields();
    this.#state = emptyState();
    this.view.render(this.#state);
  }

  /**
   * Claim the next file selection. Reading a file's dimensions is asynchronous,
   * so the caller takes a token first and commits with it once the decode
   * finishes. A token from an older selection or a cleared session is refused.
   */
  beginSourceSelection() {
    this.#selectionId += 1;
    return { selection: this.#selectionId, session: this.#sessionId };
  }

  /**
   * Apply a decoded selection, but only if it is still the current one.
   *
   * @param {{ selection: number, session: number }} token From `beginSourceSelection`.
   * @param {File|Blob|null} file
   * @param {{ width: number, height: number }|null} dimensions
   */
  commitSourceSelection(token, file, dimensions = null) {
    const current =
      Boolean(token) && token.selection === this.#selectionId && token.session === this.#sessionId;
    if (!current) return false;
    return this.setSourceFile(file, dimensions);
  }

  /**
   * @param {File|Blob|null} file
   * @param {{ width: number, height: number }|null} dimensions
   *        Decoded by the caller; null means the browser could not read the file.
   */
  setSourceFile(file, dimensions = null) {
    // The mockup is fixed for the duration of a request, so a result can never
    // be attributed to a product other than the one submitted.
    if (this.#state.pending) return false;

    // Any change to the source invalidates the previous result: it came from a
    // different mockup and must not be shown or downloaded beside this one.
    const clearedResult = { result: null, error: null };

    if (!file) {
      this.view.releaseImages();
      this.#update({
        ...clearedResult,
        source: null,
        sourceError: '',
        request: { ...this.#state.request, size: null },
      });
      return false;
    }

    const checked = validateImageFile(file);
    if (!checked.ok) {
      this.#update({
        ...clearedResult,
        source: null,
        sourceError: checked.message,
        request: { ...this.#state.request, size: null },
      });
      return false;
    }

    if (!dimensions || !Number.isFinite(dimensions.width) || !Number.isFinite(dimensions.height)) {
      this.#update({
        ...clearedResult,
        source: null,
        sourceError: 'This file could not be read as an image. It may be damaged or misnamed.',
        request: { ...this.#state.request, size: null },
      });
      return false;
    }

    const chosen = chooseOutputSize(dimensions.width, dimensions.height);
    this.#update({
      ...clearedResult,
      source: {
        file,
        name: file.name || 'mockup',
        type: file.type,
        size: file.size,
        width: dimensions.width,
        height: dimensions.height,
        advice: sourceSizeAdvice(dimensions.width, dimensions.height),
      },
      sourceError: '',
      request: {
        ...this.#state.request,
        size: chosen.size,
        aspectRatioClamped: chosen.aspectRatioClamped,
      },
    });
    return true;
  }

  setNotes(rawNotes) {
    // Locked while pending, for the same reason the mockup is.
    if (this.#state.pending) return false;

    const checked = validateNotes(rawNotes);
    this.#update({
      notes: checked.value,
      notesError: checked.ok ? '' : checked.message,
      notesRemaining: Math.max(0, NOTES.maxLength - checked.value.length),
      request: { ...this.#state.request, hasNotes: checked.value.trim().length > 0 },
    });
    return checked.ok;
  }

  /**
   * Request one preview. Does nothing while a request is already pending, so a
   * double click or a repeated programmatic call cannot produce two charges.
   *
   * Everything the result is later labelled and compared with is captured up
   * front, so its attribution describes the request that was actually sent.
   */
  async generate() {
    if (this.#state.pending) return null;
    if (!this.canGenerate) {
      this.#update({
        error: {
          kind: 'incomplete',
          title: 'Something is still missing',
          message: 'Enter your name, connect with your API key, and choose a mockup before generating.',
          requestId: null,
          mayBeBilled: false,
        },
      });
      return null;
    }

    const runId = (this.#runId += 1);
    const startedAt = this.now();
    const submitted = Object.freeze({
      file: this.#state.source.file,
      sourceName: this.#state.source.name,
      sourceWidth: this.#state.source.width,
      sourceHeight: this.#state.source.height,
      testerName: this.#state.name,
      prompt: buildPrompt(this.#state.notes),
      size: this.#state.request.size || FALLBACK_SIZE,
      quality: OUTPUT.quality,
      outputFormat: OUTPUT.outputFormat,
    });

    this.#update({
      pending: true,
      startedAt: startedAt.toISOString(),
      attempts: this.#state.attempts + 1,
      result: null,
      error: null,
      request: {
        ...this.#state.request,
        size: submitted.size,
        hasNotes: submitted.prompt.hasNotes,
        promptVersion: submitted.prompt.version,
      },
    });

    this.#abortController = new AbortController();
    const abortOnTimeout = setTimeout(() => {
      if (this.#abortController) this.#abortController.abort(makeAbortReason('timeout'));
    }, this.timeoutMs);

    try {
      const preview = await requestEmbroideryPreview({
        apiKey: this.#apiKey,
        file: submitted.file,
        prompt: submitted.prompt.text,
        size: submitted.size,
        signal: this.#abortController.signal,
        fetchImpl: this.fetchImpl,
      });

      // A reply that arrives after a disconnect belongs to a session that no
      // longer exists. Drop it rather than restoring the cleared page.
      if (runId !== this.#runId) return null;

      const finishedAt = this.now();
      this.#update({
        pending: false,
        access: 'confirmed',
        accessMessage: this.#state.access === 'confirmed' ? this.#state.accessMessage : 'OpenAI accepted this key.',
        result: {
          blob: preview.blob,
          filename: this.#resultFilename(finishedAt, submitted),
          // The mockup this preview was made from, not whatever is selected now.
          source: {
            file: submitted.file,
            name: submitted.sourceName,
            width: submitted.sourceWidth,
            height: submitted.sourceHeight,
          },
          testerName: submitted.testerName,
          requestId: preview.requestId,
          usage: preview.usage,
          size: preview.size || submitted.size,
          quality: preview.quality || submitted.quality,
          outputFormat: preview.outputFormat || submitted.outputFormat,
          promptVersion: submitted.prompt.version,
          hasNotes: submitted.prompt.hasNotes,
          receivedAt: finishedAt.toISOString(),
          elapsedMs: finishedAt.getTime() - startedAt.getTime(),
        },
        error: null,
      });
      return this.#state.result;
    } catch (error) {
      if (runId !== this.#runId) return null;
      const failure = error instanceof ProviderError
        ? error
        : new ProviderError({
            kind: 'unexpected',
            title: 'The preview could not be generated',
            message: 'The page hit an unexpected problem while handling the request.',
            mayBeBilled: true,
          });
      this.#update({
        pending: false,
        result: null,
        access: failure.kind === 'auth' ? 'rejected' : this.#state.access,
        error: {
          kind: failure.kind,
          title: failure.title,
          message: failure.message,
          requestId: failure.requestId,
          mayBeBilled: failure.mayBeBilled,
        },
      });
      return null;
    } finally {
      clearTimeout(abortOnTimeout);
      if (runId === this.#runId) this.#abortController = null;
    }
  }

  #resultFilename(date, submitted) {
    const person = slug(submitted.testerName, 'tester');
    const source = slug(submitted.sourceName, 'mockup');
    return `embroidery-preview_${person}_${source}_${timestamp(date)}.${OUTPUT.fileExtension}`;
  }
}
