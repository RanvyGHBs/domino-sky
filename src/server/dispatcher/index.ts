/**
 * Domino Sky — Module 09: AI Dispatcher Orchestrator
 *
 * Pipeline:
 *   Validate Request
 *   -> Deterministic Simulation Engine (simulateDisruption)
 *   -> Deterministic Recovery Generation, Feasibility & Ranking (generateAndRankRecoveryOptions)
 *   -> Server-Side Gemini Structured Reasoning (gemini-4-hydrogen)
 *   -> Strict Output Validation (feasible actionIds, flightIds, verified numbers)
 *   -> Authoritative Backend KPI Hydration (or clearly labelled Deterministic Fallback)
 */

import type { NormalizedFlightNetwork } from '../../types/dataset.ts';
import type {
  DispatcherPreference,
  DispatcherRecommendRequest,
  DispatcherRecommendResponse,
} from '../../types/dispatcher.ts';
import { VALID_DISPATCHER_PREFERENCES } from '../../types/dispatcher.ts';
import type { AirportClosureEvent, SimulationConfig } from '../../types/simulation.ts';
import { createAirportClosureEvent } from '../../engine/closure/index.ts';
import { simulateDisruption } from '../../engine/propagation/index.ts';
import { generateAndRankRecoveryOptions } from '../../engine/recovery/index.ts';
import { isValidHHMM, parseHHMMToMinutes } from '../../engine/time.ts';
import {
  buildDispatcherUserPrompt,
  buildSimulationSummary,
  DISPATCHER_SYSTEM_INSTRUCTION,
  GEMINI_DISPATCHER_RESPONSE_SCHEMA,
} from './prompt.ts';
import { validateGeminiDispatcherOutput } from './validator.ts';
import {
  buildDeterministicFallbackResponse,
  hydrateVerifiedGeminiResponse,
} from './fallback.ts';
import {
  classifyGeminiError,
  DEFAULT_GEMINI_TIMEOUT_MS,
  GEMINI_DISPATCHER_MODEL,
  invokeGeminiDispatcher,
  type GeminiInvoker,
} from './geminiClient.ts';

export {
  GEMINI_DISPATCHER_MODEL,
  DEFAULT_GEMINI_TIMEOUT_MS,
  DISPATCHER_SYSTEM_INSTRUCTION,
  GEMINI_DISPATCHER_RESPONSE_SCHEMA,
  validateGeminiDispatcherOutput,
  buildDispatcherUserPrompt,
  buildDeterministicFallbackResponse,
};
export type { GeminiInvoker };

export class DispatcherInputValidationError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'DispatcherInputValidationError';
  }
}

export interface ValidatedDispatcherInput {
  closure: AirportClosureEvent;
  preference: DispatcherPreference;
  config?: Partial<SimulationConfig>;
}

/**
 * Strictly validates all incoming POST /api/dispatcher/recommend fields before running
 * the deterministic engine or invoking Gemini.
 */
export function validateDispatcherRequest(
  network: NormalizedFlightNetwork,
  rawBody: unknown
): ValidatedDispatcherInput {
  if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    throw new DispatcherInputValidationError('Request body must be a JSON object.');
  }

  const body = rawBody as Partial<DispatcherRecommendRequest>;

  if (typeof body.airportId !== 'string' || body.airportId.trim().length === 0) {
    throw new DispatcherInputValidationError('airportId is required (e.g., "BOM", "DEL", "BLR").');
  }
  const airportId = body.airportId.trim().toUpperCase();
  if (!network.index.airportsById[airportId]) {
    throw new DispatcherInputValidationError(
      `Unknown airportId "${airportId}". Must be one of the 16 airports in flight_network.json.`
    );
  }

  let startMin: number;
  if (typeof body.startMin === 'number') {
    if (!Number.isInteger(body.startMin) || body.startMin < 0 || body.startMin >= 1440) {
      throw new DispatcherInputValidationError('startMin must be an integer between 0 and 1439.');
    }
    startMin = body.startMin;
  } else if (typeof body.startTime === 'string' && body.startTime.trim().length > 0) {
    const trimmed = body.startTime.trim();
    if (!isValidHHMM(trimmed)) {
      throw new DispatcherInputValidationError(
        `Invalid startTime "${trimmed}". Provide 24-hour HH:MM format (e.g., "08:00").`
      );
    }
    startMin = parseHHMMToMinutes(trimmed);
  } else {
    throw new DispatcherInputValidationError(
      'Closure startTime (HH:MM) or integer startMin is required.'
    );
  }

  if (body.durationMinutes === undefined || body.durationMinutes === null) {
    throw new DispatcherInputValidationError('durationMinutes is required.');
  }
  const durationMinutes = Number(body.durationMinutes);
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0 || durationMinutes > 720) {
    throw new DispatcherInputValidationError(
      'durationMinutes must be a positive number between 1 and 720 minutes.'
    );
  }

  let preference: DispatcherPreference = 'balanced';
  if (body.preference !== undefined && body.preference !== null) {
    if (
      typeof body.preference !== 'string' ||
      !VALID_DISPATCHER_PREFERENCES.includes(body.preference as DispatcherPreference)
    ) {
      throw new DispatcherInputValidationError(
        `Invalid dispatcher preference "${String(body.preference)}". Allowed values: ${VALID_DISPATCHER_PREFERENCES.join(', ')}.`
      );
    }
    preference = body.preference as DispatcherPreference;
  }

  let validatedConfig: Partial<SimulationConfig> | undefined;
  if (body.config !== undefined) {
    if (!body.config || typeof body.config !== 'object' || Array.isArray(body.config)) {
      throw new DispatcherInputValidationError('config must be an object when provided.');
    }
    const cfg = body.config;
    if (
      cfg.enforceReopeningCapacityMetering !== undefined &&
      typeof cfg.enforceReopeningCapacityMetering !== 'boolean'
    ) {
      throw new DispatcherInputValidationError(
        'config.enforceReopeningCapacityMetering must be a boolean.'
      );
    }
    if (
      cfg.reopeningQueueOrdering !== undefined &&
      cfg.reopeningQueueOrdering !== 'earliest_ready_then_scheduled_then_flight_id' &&
      cfg.reopeningQueueOrdering !== 'scheduled_time_then_flight_id'
    ) {
      throw new DispatcherInputValidationError('Invalid config.reopeningQueueOrdering policy.');
    }
    if (
      cfg.crewViolationPolicy !== undefined &&
      cfg.crewViolationPolicy !== 'flag_violation' &&
      cfg.crewViolationPolicy !== 'cancel_violating_legs'
    ) {
      throw new DispatcherInputValidationError(
        'config.crewViolationPolicy must be "flag_violation" or "cancel_violating_legs".'
      );
    }
    validatedConfig = cfg;
  }

  const closure = createAirportClosureEvent(
    network,
    airportId,
    startMin,
    Math.round(durationMinutes),
    typeof body.reason === 'string' ? body.reason.trim().slice(0, 160) : undefined
  );

  return { closure, preference, config: validatedConfig };
}

export interface RunDispatcherOptions {
  /** Override API key (primarily for testing missing/present key flows without mutating env) */
  apiKey?: string | null;
  /** Override model name (defaults to GEMINI_DISPATCHER_MODEL) */
  model?: string;
  /** Override timeout in ms (defaults to DEFAULT_GEMINI_TIMEOUT_MS) */
  timeoutMs?: number;
  /** Injectable Gemini invoker for deterministic unit/integration testing */
  invoker?: GeminiInvoker;
}

/**
 * Executes the full end-to-end Module 09 AI Dispatcher pipeline.
 */
export async function runDispatcherRecommendation(
  network: NormalizedFlightNetwork,
  rawBody: unknown,
  options: RunDispatcherOptions = {}
): Promise<DispatcherRecommendResponse> {
  const { closure, preference, config } = validateDispatcherRequest(network, rawBody);

  // 1. Deterministic Simulation & Recovery Pipeline (sole numerical authority)
  const baseline = simulateDisruption(network, closure, config);
  const { rankedOptions, rejectedCandidates } = generateAndRankRecoveryOptions(network, baseline);
  const simulationSummary = buildSimulationSummary(network, baseline);

  const model = options.model ?? GEMINI_DISPATCHER_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_GEMINI_TIMEOUT_MS;
  const invoker = options.invoker ?? invokeGeminiDispatcher;
  const apiKey =
    options.apiKey !== undefined ? options.apiKey : (process.env.GEMINI_API_KEY ?? '');

  // 2. Missing or placeholder server-side API key -> graceful deterministic fallback (unavailable)
  const cleanedApiKey = (apiKey ?? '').trim();
  if (cleanedApiKey.length === 0 || cleanedApiKey === 'MY_GEMINI_API_KEY') {
    return buildDeterministicFallbackResponse({
      aiStatus: 'unavailable',
      modelUsed: model,
      preference,
      fallbackReason: 'missing_api_key',
      warningMessage:
        'Server-side GEMINI_API_KEY is not configured. Returning verified deterministic ranking fallback.',
      simulationSummary,
      baseline,
      rankedOptions,
      rejectedCandidates,
    });
  }

  // 3. Build strictly verified prompt payload & invoke server-side Gemini
  const userPrompt = buildDispatcherUserPrompt({
    simulationSummary,
    baseline,
    rankedOptions,
    rejectedCandidates,
    preference,
  });

  let rawResponseText: string;
  try {
    rawResponseText = await invoker({
      apiKey: cleanedApiKey,
      model,
      systemInstruction: DISPATCHER_SYSTEM_INSTRUCTION,
      userPrompt,
      responseSchema: GEMINI_DISPATCHER_RESPONSE_SCHEMA,
      timeoutMs,
    });
  } catch (error) {
    const classified = classifyGeminiError(error);
    return buildDeterministicFallbackResponse({
      aiStatus: 'fallback',
      modelUsed: model,
      preference,
      fallbackReason: classified.category,
      warningMessage: classified.message,
      simulationSummary,
      baseline,
      rankedOptions,
      rejectedCandidates,
    });
  }

  // 4. Strictly validate Gemini JSON against deterministic backend truth
  const validation = validateGeminiDispatcherOutput(rawResponseText, {
    network,
    baseline,
    rankedOptions,
    rejectedCandidates,
  });

  if (!validation.valid || !validation.sanitized) {
    return buildDeterministicFallbackResponse({
      aiStatus: 'fallback',
      modelUsed: model,
      preference,
      fallbackReason: 'validation_failed',
      warningMessage: `Gemini output failed backend operational validation (${validation.issues.map((i) => i.code).join(', ')}); switched to verified deterministic ranking fallback.`,
      validationIssues: validation.issues,
      simulationSummary,
      baseline,
      rankedOptions,
      rejectedCandidates,
    });
  }

  // 5. Hydrate validated AI selection with backend-authoritative KPI comparisons
  return hydrateVerifiedGeminiResponse({
    sanitized: validation.sanitized,
    modelUsed: model,
    preference,
    simulationSummary,
    baseline,
    rankedOptions,
    rejectedCandidates,
  });
}
