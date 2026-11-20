/**
 * Module 09: AI Dispatcher Client Service
 *
 * Strictly communicates with server-side /api/dispatcher/* routes.
 * Never imports @google/genai or accesses API keys in browser code.
 */

import type {
  DispatcherRecommendRequest,
  DispatcherRecommendResponse,
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

export async function requestDispatcherRecommendation(
  payload: DispatcherRecommendRequest
): Promise<DispatcherRecommendResponse> {
  const response = await fetch('/api/dispatcher/recommend', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errBody = (await response.json().catch(() => ({ error: response.statusText }))) as {
      error?: string;
    };
    throw new Error(errBody.error || `Dispatcher request failed (${response.status})`);
  }

  return (await response.json()) as DispatcherRecommendResponse;
}
