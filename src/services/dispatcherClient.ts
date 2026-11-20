/**
 * Module 9: AI Dispatcher Client Service
 *
 * Strictly communicates with server-side /api/dispatcher/* routes.
 * Never imports @google/genai or accesses API keys in browser code.
 * If Gemini is unavailable, the simulator continues operating deterministically.
 */

import type {
  DispatcherRecommendation,
  DispatcherRequestPayload,
  DispatcherStatusResponse,
} from '../types/dispatcher.ts';

export async function fetchDispatcherStatus(): Promise<DispatcherStatusResponse> {
  const response = await fetch('/api/dispatcher/status', { cache: 'no-store' });
  if (!response.ok) {
    return {
      available: false,
      mode: 'offline_deterministic_only',
      model: 'gemini-4-hydrogen',
      message: 'Dispatcher API unreachable; deterministic simulator remains fully operational.',
    };
  }
  return (await response.json()) as DispatcherStatusResponse;
}

/**
 * Validates that an AI-recommended actionId exists in the locally generated
 * candidate pool before the UI ever accepts it for deterministic simulation.
 */
export function validateDispatcherRecommendation(
  recommendation: DispatcherRecommendation,
  validCandidateIds: ReadonlySet<string>
): { valid: boolean; reason?: string } {
  if (!recommendation.recommendedActionId) {
    return { valid: false, reason: 'Missing recommendedActionId in AI dispatcher response.' };
  }
  if (!validCandidateIds.has(recommendation.recommendedActionId)) {
    return {
      valid: false,
      reason: `AI recommended unknown actionId "${recommendation.recommendedActionId}" outside verified deterministic candidates.`,
    };
  }
  return { valid: true };
}

export async function requestDispatcherRecommendation(
  payload: DispatcherRequestPayload
): Promise<DispatcherRecommendation> {
  const response = await fetch('/api/dispatcher/recommend', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const errBody = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(errBody.error || `Dispatcher request failed (${response.status})`);
  }
  return (await response.json()) as DispatcherRecommendation;
}
