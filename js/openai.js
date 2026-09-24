/**
 * The provider request path: one image-edit request per preview, plus the
 * non-billable key check used when a tester connects.
 *
 * The key is only ever an Authorization header value. It is never placed in a
 * URL, a form field, the prompt, or anything this module returns.
 */

import { OUTPUT, PROVIDER, TIMING } from './config.js';
import { redactSecrets } from './validation.js';
import { MODELS, effortsForModel } from './settings.js';
import { isSupportedSize } from './size.js';
import { decodeBoundedBase64, readBoundedText, readImageDimensions, RESOURCE_LIMITS, ResourceLimitError } from './resource-limits.js';

/**
 * Build the reason handed to `AbortController.abort()`. `fetch` rejects with
 * exactly this object, which is how the caller tells a page timeout apart from
 * a tester disconnecting.
 *
 * @param {'timeout'|'cancelled'} kind
 */
export function makeAbortReason(kind) {
  const reason = new DOMException(
    kind === 'timeout' ? 'The page stopped waiting for OpenAI.' : 'The request was stopped.',
    'AbortError',
  );
  reason.abortReason = kind;
  return reason;
}

export class ProviderError extends Error {
  constructor({ kind, title, message, status = null, requestId = null, mayBeBilled = false, providerCode = null, providerType = null }) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.title = title;
    this.status = status;
    this.requestId = requestId;
    this.mayBeBilled = mayBeBilled;
    this.providerCode = providerCode;
    this.providerType = providerType;
  }
}

function authHeaders(apiKey) {
  return { Authorization: `Bearer ${apiKey}` };
}

function requestIdOf(response) {
  try {
    return response.headers.get('x-request-id');
  } catch {
    return null;
  }
}

async function readErrorBody(response, apiKey, signal) {
  let raw = '';
  try {
    raw = await readBoundedText(response, RESOURCE_LIMITS.errorResponseBytes, signal);
  } catch {
    return { message: '', code: null, type: null };
  }
  try {
    const parsed = JSON.parse(raw);
    const error = parsed && parsed.error ? parsed.error : parsed;
    return {
      message: redactSecrets(typeof error?.message === 'string' ? error.message : '', apiKey).slice(0, RESOURCE_LIMITS.errorMessageCharacters),
      code: typeof error?.code === 'string' ? error.code.slice(0, 200) : null,
      // `type` carries the category when the code is new or absent.
      type: typeof error?.type === 'string' ? error.type.slice(0, 200) : null,
    };
  } catch {
    return { message: redactSecrets(raw, apiKey).slice(0, 400), code: null, type: null };
  }
}

/**
 * Codes that mean the account is out of money or has hit a configured ceiling.
 * These do not clear by waiting, so they must not be shown as throttling.
 * Current codes first, then the older ones, which still appear.
 * OpenAI error-code guide, retrieved 2026-09-14.
 */
const SPENDING_LIMIT_CODES = new Set([
  'credit_balance_exhausted',
  'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
  'insufficient_quota',
  'billing_hard_limit_reached',
]);

/** Codes that say the credential itself is no good. */
const INVALID_CREDENTIAL_CODES = new Set([
  'invalid_api_key',
  'invalid_authentication',
  'account_deactivated',
  'invalid_organization',
]);

/** Codes that say the credential is fine but may not perform this request. */
const PERMISSION_CODES = new Set([
  'missing_scope',
  'insufficient_scope',
  'invalid_scope',
  'insufficient_permissions',
  'insufficient_permission',
  'model_not_permitted',
]);

/**
 * A 401 from the metadata endpoint can mean the key is bad, or only that it is
 * not allowed to list models. Those need different answers: discarding a usable
 * key over a permissions limit costs the tester their session for nothing.
 *
 * The structured code decides where it is recognised; a narrow message match is
 * the fallback. Anything else stays unclear, and unclear keeps the key, because
 * an actually invalid key will fail plainly on the edit request instead.
 *
 * @returns {'invalid'|'permission'|'unclear'}
 */
function classifyMetadataRejection({ code, type, message }) {
  if (code && PERMISSION_CODES.has(code)) return 'permission';
  if (code && INVALID_CREDENTIAL_CODES.has(code)) return 'invalid';
  if (type === 'insufficient_permissions') return 'permission';

  const said = typeof message === 'string' ? message : '';
  if (/\bpermissions?\b|\bscopes?\b|not allowed to access|does not have access|lacks access/i.test(said)) {
    return 'permission';
  }
  if (/incorrect api key provided|invalid api key|api key.*(revoked|deactivated|disabled|expired)/i.test(said)) {
    return 'invalid';
  }
  return 'unclear';
}

/** Codes and types that mean ordinary throttling, which does clear by waiting. */
const THROTTLING_CODES = new Set(['rate_limit_exceeded', 'slow_down']);

/**
 * Decide whether a failure is a spending or credit limit.
 *
 * The code decides when it is recognised. Otherwise `type` is the fallback, so
 * a limit code introduced after this was written is still classified correctly
 * rather than being shown as a temporary rate limit.
 */
function isSpendingLimit({ providerCode, providerType }) {
  if (providerCode && THROTTLING_CODES.has(providerCode)) return false;
  if (providerCode && SPENDING_LIMIT_CODES.has(providerCode)) return true;
  return providerType === 'insufficient_quota';
}

function withProviderDetail(message, providerMessage) {
  return providerMessage ? `${message}\n\nOpenAI said: ${providerMessage}` : message;
}

/**
 * Turn a non-2xx response into an actionable error.
 * `mayBeBilled` is true only where a charge is actually plausible.
 */
function classifyHttpFailure({ status, providerMessage, providerCode, providerType, requestId, model }) {
  const shared = { status, requestId, providerCode, providerType };

  // A credit or spending limit arrives on more than one status, and it is the
  // one failure a tester must not be told to wait out.
  if (status !== 401 && isSpendingLimit({ providerCode, providerType })) {
    return new ProviderError({
      ...shared,
      kind: 'quota',
      title: 'This account has reached a credit or spending limit',
      message: withProviderDetail(
        'Waiting will not clear this. Ask whoever administers your API key to check the credit ' +
          'balance and the organisation and project spending limits before you try again. This ' +
          'page does not retry on its own.',
        providerMessage,
      ),
    });
  }

  if (status === 401) {
    return new ProviderError({
      ...shared,
      kind: 'auth',
      title: 'OpenAI rejected this API key',
      message: withProviderDetail(
        'Check that the whole key was copied and that it is the key you were assigned. Disconnect and paste it again.',
        providerMessage,
      ),
    });
  }
  if (status === 403) {
    return new ProviderError({
      ...shared,
      kind: 'forbidden',
      title: 'This key is not allowed to make this request',
      message: withProviderDetail(
        `The key was accepted but is not permitted to use ${model} on the image edit endpoint. Ask whoever assigned the key to check the project's model permissions.`,
        providerMessage,
      ),
    });
  }
  if (status === 404) {
    return new ProviderError({
      ...shared,
      kind: 'not_found',
      title: `${model} is not available to this account`,
      message: withProviderDetail(
        'The endpoint or the model was not found for this key. This app does not substitute a different model.',
        providerMessage,
      ),
    });
  }
  if (status === 429) {
    return new ProviderError({
      ...shared,
      kind: 'rate_limit',
      title: 'OpenAI is rate limiting this key',
      message: withProviderDetail(
        'Too many requests in a short period. Wait a moment before trying again; this app does not retry on its own.',
        providerMessage,
      ),
    });
  }
  if (status === 400 || status === 422) {
    const refused =
      providerCode === 'moderation_blocked' ||
      providerCode === 'content_policy_violation' ||
      /safety|content policy|moderation/i.test(providerMessage || '');
    return new ProviderError({
      ...shared,
      kind: refused ? 'refused' : 'invalid_request',
      title: refused ? 'OpenAI declined to edit this image' : 'OpenAI rejected the request',
      message: withProviderDetail(
        refused
          ? 'The request was refused by the provider\'s content checks rather than failing technically. Try a different mockup, or remove wording from the Additional instructions.'
          : 'The request was not accepted. The message below usually names the field at fault.',
        providerMessage,
      ),
    });
  }
  if (status >= 500) {
    return new ProviderError({
      ...shared,
      kind: 'server',
      title: 'OpenAI could not complete the request',
      message: withProviderDetail(
        'This is a provider-side failure. Trying again later is reasonable; each attempt is a separate request.',
        providerMessage,
      ),
      mayBeBilled: status !== 503,
    });
  }
  return new ProviderError({
    ...shared,
    kind: 'unexpected',
    title: `OpenAI returned status ${status}`,
    message: withProviderDetail('The request did not succeed.', providerMessage),
    mayBeBilled: true,
  });
}

/**
 * A rejected fetch gives the page no status and no body, so the cause of any
 * individual failure is genuinely unknown here. Say that, rather than naming a
 * likely reason the page cannot actually distinguish. Header behaviour observed
 * from the command line is recorded in TechDocs/BROWSER_REQUEST_CHECK.md; it
 * describes those probes, not this failure.
 */
function classifyTransportFailure(error, { billable }) {
  if (error && (error.name === 'AbortError' || error.abortReason)) {
    if (error.abortReason === 'cancelled') {
      return new ProviderError({
        kind: 'cancelled',
        title: 'Request stopped',
        message: 'The page stopped waiting. A request already received by OpenAI may still complete and be billed. Check usage before starting another attempt.',
        mayBeBilled: billable,
      });
    }
    return new ProviderError({
      kind: 'timeout',
      title: 'No response within the time limit',
      message:
        `This page stopped waiting after ${Math.round(TIMING.requestTimeoutMs / 60000)} minutes. ` +
        'It cannot cancel a request that already reached OpenAI and cannot promise that no charge was made. ' +
        'Check your OpenAI usage records before retrying, and note that a retry is a separate charge.',
      mayBeBilled: billable,
    });
  }
  return new ProviderError({
    kind: 'unreadable',
    title: 'No readable reply came back from OpenAI',
    message:
      'The request was sent, but nothing came back that this page could read. A dropped ' +
      'connection, a VPN or proxy, a browser extension, or a cross-origin restriction can each ' +
      'produce this, and the page cannot tell which. It also cannot tell whether OpenAI ' +
      'completed the request. Check your OpenAI usage records before trying again, and note ' +
      'that a retry is a separate request. If this keeps happening, report it with the time it ' +
      'occurred so the cause can be diagnosed.',
    mayBeBilled: billable,
  });
}

/**
 * The provider reads the upload's filename and extension to work out the image
 * format, so never let a part arrive as an extensionless "blob".
 */
function uploadFilename(file) {
  if (file && typeof file.name === 'string' && file.name.includes('.')) return file.name;
  const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[file?.type] ?? 'png';
  return `mockup.${extension}`;
}

function responseLimitError(requestId) {
  return new ProviderError({ kind: 'resource-limit', title: 'Returned image or response is too large',
    message: 'The reply exceeded this page’s image or response safety limits and was not decoded or saved. The request may still be billed. Check OpenAI usage before trying a smaller output; no automatic retry was made.',
    requestId, mayBeBilled: true });
}

/**
 * Confirm that the provider accepts this key, before any billable request.
 *
 * GET /v1/models is a metadata call with no generation cost. It answers the
 * question MVP-02 asks: is this a key the provider actually accepts, as opposed
 * to a key the tester merely supplied.
 *
 * @returns {Promise<{ access: 'confirmed'|'rejected'|'unconfirmed',
 *                     modelAvailable: boolean|null, message: string }>}
 */
export async function checkProviderAccess({ apiKey, fetchImpl = globalThis.fetch, signal = null }) {
  let response;
  try {
    response = await fetchImpl(PROVIDER.modelsEndpoint, {
      method: 'GET',
      headers: authHeaders(apiKey),
      signal,
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
  } catch (error) {
    if (error && (error.name === 'AbortError' || error.abortReason)) {
      return {
        access: 'unconfirmed',
        modelAvailable: null,
        message:
          error.abortReason === 'timeout'
            ? 'The connection check timed out. Check your network and try again.'
            : 'The key check was stopped.',
      };
    }
    return {
      access: 'unconfirmed',
      modelAvailable: null,
      message:
        'The connection could not be verified. Check your network or browser restrictions and try again.',
    };
  }

  if (response.status === 401) {
    const { message, code, type } = await readErrorBody(response, apiKey, signal);
    const reason = classifyMetadataRejection({ code, type, message });

    if (reason === 'invalid') {
      return {
        access: 'rejected',
        modelAvailable: null,
        message: 'OpenAI rejected this API key. Check that the full key was copied, or use another key.',
      };
    }

    // Listing models must be allowed to confirm access through the entry gate.
    return {
      access: 'unconfirmed',
      modelAvailable: null,
      message:
        (reason === 'permission'
          ? 'This key cannot list models. Enable model-list read access for the key, or use another key.'
          : 'OpenAI did not confirm this connection. Check the key and its permissions, then try again.'),
    };
  }
  if (!response.ok) {
    if (response.body) void response.body.cancel().catch(() => {});
    const message = response.status === 403
      ? 'This key cannot complete the connection check. Check its model-list permissions, or use another key.'
      : response.status === 429
        ? 'OpenAI is limiting connection checks. Wait a moment, then try again.'
        : response.status >= 500
          ? 'OpenAI is unavailable for the connection check. Try again shortly.'
          : `OpenAI did not confirm this connection (HTTP ${response.status}). Check your key and try again.`;
    return {
      access: 'unconfirmed',
      modelAvailable: null,
      message,
    };
  }

  let modelAvailable = null;
  try {
    const body = JSON.parse(await readBoundedText(response, RESOURCE_LIMITS.modelResponseBytes, signal));
    if (body?.object === 'list' && Array.isArray(body.data)
      && body.data.every((entry) => entry?.object === 'model' && typeof entry.id === 'string' && entry.id.length > 0)) {
      modelAvailable = body.data.some((entry) => entry?.id === PROVIDER.model);
    }
  } catch {
    modelAvailable = null;
  }

  if (modelAvailable === null || signal?.aborted) {
    return {
      access: 'unconfirmed',
      modelAvailable: null,
      message: signal?.aborted
        ? 'The connection check did not finish. Try again.'
        : 'OpenAI returned an unreadable connection response. Try again.',
    };
  }

  return {
    access: 'confirmed',
    modelAvailable,
    message:
      modelAvailable === false
        ? `OpenAI accepted the key. ${PROVIDER.model} was not in the model list returned for this account, which does not by itself establish whether an image edit will be permitted.`
        : 'OpenAI accepted this key.',
  };
}

/**
 * Request one embroidery preview.
 *
 * @param {object} options
 * @param {string} options.apiKey
 * @param {File|Blob} options.file          The tester's mockup, sent as-is.
 * @param {string} options.prompt           Managed instruction plus labelled notes.
 * @param {string} options.size             WIDTHxHEIGHT chosen from the source.
 * @param {AbortSignal} [options.signal]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{ blob: Blob, requestId: string|null, usage: object|null,
 *                     size: string|null, quality: string|null, outputFormat: string|null }>}
 */
export async function requestEmbroideryPreview({
  apiKey,
  file,
  prompt,
  size,
  model = PROVIDER.model,
  quality = OUTPUT.quality,
  transparency = false,
  signal = null,
  fetchImpl = globalThis.fetch,
}) {
  const dimensions = typeof size === 'string' && /^\d+x\d+$/.test(size) ? size.split('x').map(Number) : [];
  if (!MODELS.includes(model) || !effortsForModel(model).includes(quality) ||
      !isSupportedSize(...dimensions) || typeof transparency !== 'boolean' ||
      typeof prompt !== 'string' || !prompt || prompt.length > PROVIDER.maxPromptCharacters ||
      !(file instanceof Blob) || file.size === 0) {
    throw new ProviderError({ kind: 'validation', title: 'Check the request settings', message: 'The model, effort, image, prompt, or dimensions are invalid. No request was sent.' });
  }
  if (signal?.aborted) throw classifyTransportFailure(signal.reason, { billable: false });
  const form = new FormData();
  form.append('model', model);
  form.append('image', file, uploadFilename(file));
  form.append('prompt', prompt);
  form.append('size', size);
  form.append('quality', quality);
  form.append('output_format', OUTPUT.outputFormat);
  form.append('background', transparency ? 'transparent' : 'opaque');
  form.append('n', '1');

  let response;
  try {
    // Content-Type is deliberately unset: fetch adds the multipart boundary.
    response = await fetchImpl(PROVIDER.editsEndpoint, {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: form,
      signal,
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
  } catch (error) {
    throw classifyTransportFailure(error, { billable: true });
  }

  const requestId = redactSecrets(requestIdOf(response) || '', apiKey).slice(0, 200) || null;

  if (!response.ok) {
    const { message, code, type } = await readErrorBody(response, apiKey, signal);
    throw classifyHttpFailure({
      status: response.status,
      providerMessage: message,
      providerCode: code,
      providerType: type,
      requestId,
      model,
    });
  }

  let body;
  try {
    body = JSON.parse(await readBoundedText(response, RESOURCE_LIMITS.imageResponseBytes, signal));
  } catch (error) {
    if (signal?.aborted) throw classifyTransportFailure(signal.reason, { billable: true });
    if (error instanceof ResourceLimitError) throw responseLimitError(requestId);
    throw new ProviderError({
      kind: 'malformed',
      title: 'OpenAI returned a reply this page could not read',
      message: 'The request appears to have succeeded, so check your usage records before retrying.',
      requestId,
      mayBeBilled: true,
    });
  }

  const base64 = body?.data?.[0]?.b64_json;
  if (typeof base64 !== 'string' || base64.length === 0) {
    throw new ProviderError({
      kind: 'malformed',
      title: 'OpenAI returned no image',
      message:
        'The reply arrived without image data. The request may still have been billed, so check ' +
        'your usage records before retrying.',
      requestId,
      mayBeBilled: true,
    });
  }

  const outputFormat = body?.output_format || OUTPUT.outputFormat;
  let bytes;
  try {
    if (outputFormat !== 'png') throw new Error('Unexpected output format.');
    bytes = decodeBoundedBase64(base64);
    // Bound dimensions before Blob URLs or the browser decoder see the PNG.
    readImageDimensions(bytes, OUTPUT.mimeType);
  } catch (error) {
    if (error instanceof ResourceLimitError) throw responseLimitError(requestId);
    throw new ProviderError({ kind: 'malformed', title: 'OpenAI returned invalid image data',
      message: 'No readable PNG was returned. Check usage before retrying; the request may have been billed.', requestId, mayBeBilled: true });
  }
  if (signal?.aborted) throw classifyTransportFailure(signal.reason, { billable: true });
  return {
    blob: new Blob([bytes], { type: OUTPUT.mimeType }),
    requestId,
    usage: body?.usage ?? null,
    size: body?.size ?? null,
    quality: body?.quality ?? null,
    outputFormat,
  };
}
