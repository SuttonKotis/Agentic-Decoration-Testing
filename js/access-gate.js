/**
 * Session-only entry gate, not account login. Only a confirmed metadata
 * response opens the workspace. Authenticated requests use the private key
 * here; no credential is returned, persisted, or placed in a DOM/input value.
 */
import { TIMING } from './config.js';
import { checkProviderAccess, makeAbortReason, requestEmbroideryPreview } from './openai.js?v=20260924-sizing';
import { validateApiKey, validateName } from './validation.js';

export function mountAccessGate({ onConnect = () => {}, onDisconnect = () => {} } = {}) {
  const byId = (id) => document.getElementById(id);
  const entry = byId('access-page');
  const workspace = byId('main');
  const form = byId('connect-form');
  const nameInput = byId('tester-name');
  const pasteButton = byId('paste-api-key');
  const replaceButton = byId('replace-api-key');
  const clearButton = byId('clear-api-key');
  const keyError = byId('api-key-error');
  const connectButton = byId('connect-button');
  const connectionError = byId('connection-error');
  const status = byId('connection-status');
  let session = null;
  let connecting = false;
  let loadedKey = '';
  let readingClipboard = false;
  let clipboardAttemptId = 0;
  let attemptId = 0;
  let activeRequest = null;

  function forgetLoadedKey() {
    // Clipboard permission prompts cannot be aborted. Invalidate late reads
    // so Clear/Cancel/page teardown can never be undone by their completion.
    clipboardAttemptId += 1;
    readingClipboard = false;
    loadedKey = '';
  }

  function renderControls() {
    const busy = connecting || readingClipboard;
    form.setAttribute('aria-busy', String(busy));
    nameInput.disabled = connecting;
    pasteButton.hidden = Boolean(loadedKey);
    pasteButton.disabled = busy;
    pasteButton.textContent = readingClipboard ? 'Reading clipboard…' : 'Paste API key';
    byId('key-loaded').hidden = !loadedKey;
    replaceButton.disabled = busy;
    clearButton.disabled = connecting;
    connectButton.disabled = busy || !loadedKey || !validateName(nameInput.value).ok;
    byId('connect-spinner').hidden = !connecting;
    byId('cancel-connect').hidden = !busy;
    byId('connect-label').textContent = connecting ? 'Checking connection…' : 'Connect';
    status.textContent = connecting ? 'Checking the connection with OpenAI.' : '';
    // Only fixed state labels are rendered: never key text, length or suffix.
    byId('key-status').textContent = loadedKey ? 'Key loaded.' : readingClipboard ? 'Reading clipboard.' : 'No key loaded.';
  }

  function renderAccess() {
    const connected = Boolean(session?.apiKey);
    entry.hidden = connected;
    entry.inert = connected;
    workspace.hidden = !connected;
    workspace.inert = !connected;
    byId('workspace-skip').hidden = !connected;
  }

  function setConnecting(value) {
    connecting = value;
    renderControls();
  }

  function clearErrors() {
    for (const [input, errorId] of [[nameInput, 'name-error'], [pasteButton, 'api-key-error']]) {
      input.removeAttribute('aria-invalid');
      byId(errorId).textContent = '';
    }
    connectionError.textContent = '';
    connectionError.hidden = true;
  }

  function showKeyError(message) {
    keyError.textContent = message;
    pasteButton.setAttribute('aria-invalid', 'true');
    pasteButton.focus();
  }

  function acceptPastedKey(raw) {
    forgetLoadedKey();
    clearErrors();
    const checked = validateApiKey(raw);
    if (checked.ok) loadedKey = checked.value;
    renderControls();
    if (!checked.ok) showKeyError(checked.message);
    else if (validateName(nameInput.value).ok) form.requestSubmit(connectButton);
    else nameInput.focus();
  }

  async function pasteFromClipboard() {
    if (session || connecting || readingClipboard) return;
    // Replace is fail-closed: a denied/invalid replacement cannot silently
    // leave an old key selected for a later Connect.
    forgetLoadedKey();
    clearErrors();
    const currentAttempt = clipboardAttemptId;
    readingClipboard = true;
    renderControls();
    try {
      if (!navigator.clipboard?.readText) throw new Error('Clipboard unavailable');
      const raw = await navigator.clipboard.readText();
      if (currentAttempt !== clipboardAttemptId || session || connecting) return;
      acceptPastedKey(raw);
    } catch {
      if (currentAttempt !== clipboardAttemptId || session || connecting) return;
      forgetLoadedKey();
      renderControls();
      // Do not echo clipboard data or permission/extension exception text.
      showKeyError('Clipboard access is unavailable. Focus Paste API key and press Command+V or Ctrl+V, or allow clipboard access in your browser.');
    }
  }

  pasteButton.addEventListener('click', () => { void pasteFromClipboard(); });
  replaceButton.addEventListener('click', () => { void pasteFromClipboard(); });
  clearButton.addEventListener('click', () => {
    if (session || connecting) return;
    forgetLoadedKey();
    clearErrors();
    renderControls();
    pasteButton.focus();
  });
  byId('key-controls').addEventListener('paste', (event) => {
    event.preventDefault();
    if (session || connecting) return;
    // Native keyboard paste is a user-initiated fallback, not a global
    // clipboard listener. Nothing is inserted into an editable field.
    acceptPastedKey(event.clipboardData?.getData('text/plain') || '');
  });

  function cancelRequest() {
    attemptId += 1;
    activeRequest?.abort(makeAbortReason('cancelled'));
    activeRequest = null;
    forgetLoadedKey();
    setConnecting(false);
  }

  function disconnect({ focus = true } = {}) {
    cancelRequest();
    session = null;
    nameInput.value = '';
    clearErrors();
    onDisconnect();
    renderAccess();
    if (focus) nameInput.focus();
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (connecting || readingClipboard || session) return;
    clearErrors();

    const name = validateName(nameInput.value);
    const key = validateApiKey(loadedKey);
    for (const [checked, input, errorId] of [
      [name, nameInput, 'name-error'],
      [key, pasteButton, 'api-key-error'],
    ]) {
      if (!checked.ok) {
        input.setAttribute('aria-invalid', 'true');
        byId(errorId).textContent = checked.message;
      }
    }
    if (!name.ok || !key.ok) {
      (!name.ok ? nameInput : pasteButton).focus();
      return;
    }

    const currentAttempt = ++attemptId;
    const aborter = new AbortController();
    activeRequest = aborter;
    setConnecting(true);
    const deadline = setTimeout(() => aborter.abort(makeAbortReason('timeout')), TIMING.keyCheckTimeoutMs);
    let failure = '';

    try {
      const outcome = await checkProviderAccess({ apiKey: key.value, signal: aborter.signal });
      if (currentAttempt !== attemptId) return;
      if (outcome.access !== 'confirmed' || aborter.signal.aborted) {
        failure = outcome.message || 'The connection could not be verified. Try again.';
      } else {
        session = { name: name.value, apiKey: key.value };
        nameInput.value = '';
        forgetLoadedKey();
        renderAccess();
        byId('decoration-type').focus();
        onConnect();
      }
    } catch {
      // Never reflect an exception or credential into the page or a log.
      failure = 'The connection could not be verified. Try again.';
    } finally {
      clearTimeout(deadline);
      if (currentAttempt === attemptId) {
        activeRequest = null;
        setConnecting(false);
        if (failure) {
          connectionError.textContent = failure;
          connectionError.hidden = false;
          connectionError.focus();
        }
      }
    }
  });

  nameInput.addEventListener('input', () => {
    nameInput.removeAttribute('aria-invalid');
    byId('name-error').textContent = '';
    connectionError.textContent = '';
    connectionError.hidden = true;
    renderControls();
  });

  byId('cancel-connect').addEventListener('click', () => {
    cancelRequest();
    clearErrors();
    pasteButton.focus();
  });
  byId('disconnect-button').addEventListener('click', () => disconnect());
  window.addEventListener('pagehide', () => disconnect({ focus: false }));
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) disconnect({ focus: false });
  });

  // Markup starts hidden/inert so no workspace flashes before this runs.
  disconnect({ focus: false });

  return {
    // The workflow receives an authenticated operation, never the credential.
    async requestPreview(options) {
      if (!session) throw new Error('Connect before generating a preview.');
      const currentSession = session;
      const result = await requestEmbroideryPreview({ ...options, apiKey: currentSession.apiKey });
      if (session !== currentSession) throw makeAbortReason('cancelled');
      return result;
    },
  };
}
