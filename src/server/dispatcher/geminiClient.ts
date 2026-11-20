/**
 * Domino Sky — Module 09: Server-Side Gemini Client
 *
 * Strictly server-side only (never imported in client/browser code).
 * Uses @google/genai SDK with gemini-4-hydrogen, User-Agent telemetry header,
 * structured JSON responseSchema, granular error classification, and a single
 * bounded retry on transient HTTP 503 UNAVAILABLE within a shared 25s deadline.
 */

import { GoogleGenAI, ThinkingLevel, type Schema } from '@google/genai';

export const GEMINI_DISPATCHER_MODEL = 'gemini-4-hydrogen';
export const DEFAULT_GEMINI_TIMEOUT_MS = 25000;
export const DEFAULT_503_BACKOFF_MS = 1000;
const MIN_RETRY_ATTEMPT_BUDGET_MS = 1500;

export function sanitizeErrorMessage(raw: string): string {
  // Never leak API keys or key query parameters in diagnostics
  return raw
    .replace(/([?&]key=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED_KEY]');
}

export function extractHttpStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const errObj = error as Record<string, unknown>;
  if (typeof errObj.status === 'number') return errObj.status;
  if (typeof errObj.statusCode === 'number') return errObj.statusCode;
  if (typeof errObj.code === 'number') return errObj.code;
  const resp = errObj.response as Record<string, unknown> | undefined;
  if (resp && typeof resp.status === 'number') return resp.status;
  const msg = error instanceof Error ? error.message : String(error);
  const match = msg.match(/\b(400|401|403|404|408|429|500|502|503|504)\b/);
  return match ? Number(match[1]) : null;
}

export interface GeminiInvokeParams {
  apiKey: string;
  model: string;
  systemInstruction: string;
  userPrompt: string;
  responseSchema: Schema;
  timeoutMs: number;
}

export type GeminiInvoker = (params: GeminiInvokeParams) => Promise<string>;

export type GeminiErrorCategory =
  | 'service_unavailable'
  | 'model_not_found'
  | 'invalid_request'
  | 'rate_limit'
  | 'auth'
  | 'timeout'
  | 'service_error';

export class DispatcherGeminiError extends Error {
  readonly category: GeminiErrorCategory;
  readonly httpStatus: number | null;

  constructor(category: GeminiErrorCategory, message: string, httpStatus: number | null = null) {
    super(sanitizeErrorMessage(message));
    this.name = 'DispatcherGeminiError';
    this.category = category;
    this.httpStatus = httpStatus;
  }
}

export function classifyGeminiError(error: unknown): DispatcherGeminiError {
  if (error instanceof DispatcherGeminiError) {
    return error;
  }

  const httpStatus = extractHttpStatus(error);
  const errName = error instanceof Error ? error.name.toLowerCase() : '';
  const rawMsg = error instanceof Error ? error.message : String(error);
  const lower = rawMsg.toLowerCase();

  // 1. Timeout / AbortController cancellation
  if (
    errName === 'aborterror' ||
    httpStatus === 408 ||
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('aborted')
  ) {
    return new DispatcherGeminiError(
      'timeout',
      'Gemini dispatcher request timed out before returning a structured recommendation.',
      httpStatus
    );
  }

  // 2. Transient 503 UNAVAILABLE / high-demand overload
  if (
    httpStatus === 503 ||
    lower.includes('unavailable') ||
    lower.includes('high demand') ||
    lower.includes('overloaded')
  ) {
    return new DispatcherGeminiError(
      'service_unavailable',
      'Gemini model is temporarily unavailable due to high demand (503 UNAVAILABLE); deterministic recovery results preserved.',
      httpStatus ?? 503
    );
  }

  // 3. 404 NOT_FOUND (model unavailable or unknown)
  if (httpStatus === 404 || lower.includes('not_found') || lower.includes('not found')) {
    return new DispatcherGeminiError(
      'model_not_found',
      'Configured Gemini model was not found (404 NOT_FOUND); verify model configuration.',
      httpStatus ?? 404
    );
  }

  // 4. 429 RESOURCE_EXHAUSTED / rate limit / quota
  if (
    httpStatus === 429 ||
    lower.includes('resource_exhausted') ||
    lower.includes('rate limit') ||
    lower.includes('quota')
  ) {
    return new DispatcherGeminiError(
      'rate_limit',
      'Gemini API rate limit or quota threshold reached (429 RESOURCE_EXHAUSTED); switched to deterministic fallback.',
      httpStatus ?? 429
    );
  }

  // 5. Authentication / permission errors (401 / 403 / invalid key)
  if (
    httpStatus === 401 ||
    httpStatus === 403 ||
    lower.includes('permission_denied') ||
    lower.includes('unauthenticated') ||
    lower.includes('api_key_invalid') ||
    lower.includes('api key')
  ) {
    return new DispatcherGeminiError(
      'auth',
      'Gemini API authentication failed; verify server-side GEMINI_API_KEY configuration.',
      httpStatus
    );
  }

  // 6. 400 INVALID_ARGUMENT / malformed request payload or config
  if (
    httpStatus === 400 ||
    lower.includes('invalid_argument') ||
    lower.includes('bad request')
  ) {
    return new DispatcherGeminiError(
      'invalid_request',
      'Gemini API rejected the request configuration or payload (400 INVALID_ARGUMENT); deterministic recovery results preserved.',
      httpStatus ?? 400
    );
  }

  // 7. All other upstream failures
  return new DispatcherGeminiError(
    'service_error',
    'Gemini service encountered an upstream error; deterministic recovery results preserved.',
    httpStatus
  );
}

/**
 * Sleeps up to `delayMs` while listening to an AbortSignal.
 * Always cleans up both the timer and the abort event listener.
 */
function sleepWithAbort(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, delayMs));
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export interface BoundedRetryOptions {
  /** Shared overall request budget in ms (covers attempt 1 + backoff + attempt 2) */
  timeoutMs: number;
  /** Base backoff in ms before +/-20% jitter (default: 1000ms -> 800..1200ms) */
  baseBackoffMs?: number;
  /** Minimum remaining ms required after backoff to start attempt 2 (default: 1500ms) */
  minRetryAttemptBudgetMs?: number;
  /** Optional deterministic RNG in [0, 1) for unit testing jitter */
  randomFn?: () => number;
}

export interface BoundedRetryExecutionResult<T> {
  value: T;
  attempts: number;
  retriedOn503: boolean;
  backoffAppliedMs: number;
}

/**
 * Executes an async Gemini SDK attempt with ONE shared AbortController deadline
 * and at most ONE jittered retry strictly for transient HTTP 503 UNAVAILABLE errors.
 * Never retries 400, 401, 403, 404, 429, timeout, or other errors.
 */
export async function executeWithBounded503Retry<T>(
  attemptFn: (signal: AbortSignal, attemptNumber: 1 | 2) => Promise<T>,
  options: BoundedRetryOptions
): Promise<BoundedRetryExecutionResult<T>> {
  const {
    timeoutMs,
    baseBackoffMs = DEFAULT_503_BACKOFF_MS,
    minRetryAttemptBudgetMs = MIN_RETRY_ATTEMPT_BUDGET_MS,
    randomFn = Math.random,
  } = options;

  const deadlineMs = Date.now() + timeoutMs;
  const controller = new AbortController();
  let didTimeout = false;

  const timeoutHandle = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);

  const toTimeoutError = () =>
    new DispatcherGeminiError(
      'timeout',
      `Gemini dispatcher request exceeded ${timeoutMs}ms timeout.`,
      null
    );

  try {
    // Attempt 1
    try {
      const value = await attemptFn(controller.signal, 1);
      return { value, attempts: 1, retriedOn503: false, backoffAppliedMs: 0 };
    } catch (firstError) {
      if (didTimeout || controller.signal.aborted) {
        throw toTimeoutError();
      }

      const classifiedFirst = classifyGeminiError(firstError);
      // Strictly retry ONLY transient 503 UNAVAILABLE
      if (classifiedFirst.category !== 'service_unavailable') {
        throw classifiedFirst;
      }

      // Compute ~1000ms jittered backoff (80%..120% of baseBackoffMs)
      const jitterFactor = 0.8 + 0.4 * Math.min(1, Math.max(0, randomFn()));
      const backoffMs = Math.round(baseBackoffMs * jitterFactor);
      const remainingMs = deadlineMs - Date.now();

      // Do not sleep or retry if the shared deadline cannot accommodate backoff + attempt
      if (remainingMs <= backoffMs + minRetryAttemptBudgetMs) {
        throw remainingMs <= 0 ? toTimeoutError() : classifiedFirst;
      }

      try {
        await sleepWithAbort(backoffMs, controller.signal);
      } catch {
        throw toTimeoutError();
      }

      if (didTimeout || controller.signal.aborted || deadlineMs - Date.now() <= 0) {
        throw toTimeoutError();
      }

      // Attempt 2 (final attempt under the exact same shared AbortController deadline)
      try {
        const value = await attemptFn(controller.signal, 2);
        return { value, attempts: 2, retriedOn503: true, backoffAppliedMs: backoffMs };
      } catch (secondError) {
        if (didTimeout || controller.signal.aborted) {
          throw toTimeoutError();
        }
        throw classifyGeminiError(secondError);
      }
    }
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/**
 * Default live server-side Gemini invoker using @google/genai.
 * Emits secret-free server-side diagnostic logs around each request.
 */
export const invokeGeminiDispatcher: GeminiInvoker = async ({
  apiKey,
  model,
  systemInstruction,
  userPrompt,
  responseSchema,
  timeoutMs,
}): Promise<string> => {
  const apiKeyDetected =
    typeof apiKey === 'string' && apiKey.trim().length > 0 && apiKey.trim() !== 'MY_GEMINI_API_KEY';

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const requestInitiatedAtIso = new Date().toISOString();
  const startMs = Date.now();
  let lastRawError: unknown = null;
  let attemptsExecuted = 0;

  try {
    const result = await executeWithBounded503Retry(
      async (signal, attemptNumber) => {
        attemptsExecuted = attemptNumber;
        try {
          const response = await ai.models.generateContent({
            model,
            contents: userPrompt,
            config: {
              systemInstruction,
              responseMimeType: 'application/json',
              responseSchema,
              abortSignal: signal,
              thinkingConfig: {
                thinkingLevel: ThinkingLevel.LOW,
              },
            },
          });
          return (response.text ?? '').trim();
        } catch (err) {
          lastRawError = err;
          throw err;
        }
      },
      { timeoutMs }
    );

    console.info(
      '[DominoSky:GeminiDiag]',
      JSON.stringify({
        outcome: 'success',
        apiKeyDetected,
        model,
        attempts: result.attempts,
        retriedOn503: result.retriedOn503,
        backoffAppliedMs: result.backoffAppliedMs,
        requestInitiatedAtIso,
        requestCompletedAtIso: new Date().toISOString(),
        elapsedMs: Date.now() - startMs,
        httpStatus: 200,
        sdkErrorName: null,
        sdkErrorMessage: null,
        errorClassification: null,
        abortTimeoutTriggered: false,
      })
    );
    return result.value;
  } catch (error) {
    const classified = classifyGeminiError(error);
    const rawErr = lastRawError ?? error;

    console.warn(
      '[DominoSky:GeminiDiag]',
      JSON.stringify({
        outcome: 'error',
        apiKeyDetected,
        model,
        attempts: attemptsExecuted,
        retriedOn503: attemptsExecuted > 1,
        requestInitiatedAtIso,
        requestCompletedAtIso: new Date().toISOString(),
        elapsedMs: Date.now() - startMs,
        httpStatus: classified.httpStatus ?? extractHttpStatus(rawErr),
        sdkErrorName: rawErr instanceof Error ? rawErr.name : typeof rawErr,
        sdkErrorMessage: sanitizeErrorMessage(
          rawErr instanceof Error ? rawErr.message : String(rawErr)
        ),
        errorClassification: classified.category,
        abortTimeoutTriggered: classified.category === 'timeout',
      })
    );

    throw classified;
  }
};
