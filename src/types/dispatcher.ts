/**
 * Domino Sky — AI Dispatcher Contracts
 *
 * CRITICAL GOVERNANCE RULE:
 * Gemini NEVER calculates, estimates, invents, or modifies operational numbers.
 * The server sends structured, locally-computed SimulationResult + evaluated RecoveryComparison
 * candidates to Gemini. Gemini returns a recommended actionId from the validated candidate pool
 * plus qualitative explanations and trade-off analysis. The client displays ONLY locally calculated
 * metrics for the validated actionId.
 */

import type { RecoveryAction, RecoveryComparison, SimulationResult } from './simulation.ts';

export interface DispatcherCandidateSummary {
  actionId: string;
  type: RecoveryAction['type'];
  label: string;
  description: string;
  /** Pre-computed deterministic delta outcomes from our TypeScript engine */
  verifiedDeltas: RecoveryComparison['deltas'];
  verifiedRecoveredKpis: SimulationResult['kpis'];
}

export interface DispatcherRequestPayload {
  closureSummary: {
    airportId: string;
    airportName: string;
    startStr: string;
    endStr: string;
    durationMinutes: number;
  };
  baselineKpis: SimulationResult['kpis'];
  topDisruptedFlights: Array<{
    flightId: string;
    tailId: string;
    route: string;
    delayMin: number;
    status: string;
    dominoDepth: number;
    primaryCause: string;
  }>;
  crewViolations: Array<{
    crewId: string;
    tailId: string;
    actualDutyMins: number;
    maxDutyMins: number;
    overageMins: number;
    violatingFlightIds: string[];
  }>;
  missedConnections: Array<{
    connectionId: string;
    airportId: string;
    fromFlightId: string;
    toFlightId: string;
    passengers: number;
    shortfallMinutes: number;
  }>;
  /** Deterministically pre-simulated valid candidate recovery actions */
  candidates: DispatcherCandidateSummary[];
}

export interface DispatcherOptionTradeoff {
  actionId: string;
  pros: string[];
  cons: string[];
  operationalRisk: 'low' | 'medium' | 'high';
}

export interface DispatcherRecommendation {
  /** Must match an actionId from candidates (validated strictly before display) */
  recommendedActionId: string;
  executiveSummary: string;
  disruptionRootCauseAnalysis: string;
  recommendationRationale: string;
  optionTradeoffs: DispatcherOptionTradeoff[];
  modelUsed: string;
  generatedAtIso: string;
}

export interface DispatcherStatusResponse {
  available: boolean;
  mode: 'gemini_ready' | 'offline_deterministic_only';
  model: string;
  message: string;
}
