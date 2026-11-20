/**
 * Domino Sky — Module 09: AI Dispatcher Contracts
 *
 * CRITICAL GOVERNANCE RULE:
 * Gemini NEVER calculates, estimates, invents, or modifies operational numbers.
 * The server runs the deterministic TypeScript simulation and recovery engines first,
 * sends verified structured data to Gemini, validates Gemini's qualitative response,
 * and attaches all numerical KPI values directly from the deterministic comparison results.
 */

import type {
  AirportClosureEvent,
  NetworkKpiSnapshot,
  PassengerImpactSummary,
  RankingCriterionScore,
  RecoveryActionType,
  RecoveryComparison,
  RecoveryFeasibilityCheck,
  SimulationConfig,
} from './simulation.ts';

export type DispatcherPreference =
  | 'balanced'
  | 'minimise_passenger_impact'
  | 'minimise_total_delay'
  | 'protect_crew_compliance'
  | 'avoid_cancellations';

export const VALID_DISPATCHER_PREFERENCES: readonly DispatcherPreference[] = [
  'balanced',
  'minimise_passenger_impact',
  'minimise_total_delay',
  'protect_crew_compliance',
  'avoid_cancellations',
] as const;

export const DISPATCHER_PREFERENCE_META: Record<
  DispatcherPreference,
  { label: string; description: string }
> = {
  balanced: {
    label: 'Balanced Operations',
    description:
      'Weighs passenger protection, total delay reduction, crew legality, and avoiding cancellations.',
  },
  minimise_passenger_impact: {
    label: 'Minimise Passenger Impact',
    description:
      'Prioritises reducing stranded passengers and protecting vulnerable passenger connections.',
  },
  minimise_total_delay: {
    label: 'Minimise Total Delay',
    description: 'Prioritises cutting aggregate network delay minutes and recovering late flights.',
  },
  protect_crew_compliance: {
    label: 'Protect Crew Compliance',
    description:
      'Prioritises eliminating crew duty-time violations while preserving aircraft continuity.',
  },
  avoid_cancellations: {
    label: 'Avoid Cancellations',
    description:
      'Prefers feasible recovery actions that preserve scheduled flight operations without cancellations.',
  },
};

export type AiDispatcherStatus = 'success' | 'fallback' | 'unavailable';

export interface DispatcherStatusResponse {
  available: boolean;
  mode: 'gemini_ready' | 'offline_deterministic_only';
  model: string;
  message: string;
}

export interface DispatcherRecommendRequest {
  airportId: string;
  startTime?: string;
  startMin?: number;
  durationMinutes: number;
  reason?: string;
  preference?: DispatcherPreference;
  config?: Partial<SimulationConfig>;
}

/** Raw structured JSON contract expected back from Gemini (qualitative + ID references only) */
export interface RawGeminiRecommendedAction {
  actionId: string;
  title: string;
  reason: string;
  benefits: string[];
  tradeoffs: string[];
  operationalImpact: {
    flightsAffected: string[];
    passengerImpact: string;
    crewImpact: string;
    aircraftImpact: string;
  };
}

export interface RawGeminiAlternativeAction {
  actionId: string;
  reasonLessSuitable: string;
  keyTradeoff: string;
}

export interface RawGeminiRejectedExplanation {
  actionId: string;
  reason: string;
}

export interface RawGeminiDispatcherOutput {
  situationOverview: string;
  recommendedActions: RawGeminiRecommendedAction[];
  alternativeActions: RawGeminiAlternativeAction[];
  rejectedActionExplanations: RawGeminiRejectedExplanation[];
  dispatcherSummary: string;
  assumptions: string[];
}

export interface DispatcherValidationIssue {
  code:
    | 'MALFORMED_JSON'
    | 'INVALID_SCHEMA'
    | 'UNKNOWN_ACTION_ID'
    | 'INFEASIBLE_ACTION_ID'
    | 'DUPLICATE_ACTION_ID'
    | 'EXCESS_RECOMMENDATIONS'
    | 'UNSUPPORTED_FLIGHT_ID'
    | 'UNSUPPORTED_NUMERICAL_CLAIM'
    | 'EMPTY_RESPONSE';
  message: string;
}

export interface DispatcherValidationResult {
  valid: boolean;
  issues: DispatcherValidationIssue[];
  sanitized?: RawGeminiDispatcherOutput;
}

/** Backend-authoritative KPI comparison attached directly from deterministic engine output */
export interface VerifiedRecommendationKpiBundle {
  before: NetworkKpiSnapshot;
  after: NetworkKpiSnapshot;
  deltas: RecoveryComparison['deltas'];
  recoveredFlightIds: string[];
  delayReducedFlightIds: string[];
  delayIncreasedFlightIds: string[];
  cancelledForRecoveryFlightIds: string[];
  savedConnectionIds: string[];
  lostConnectionIds: string[];
  resolvedCrewViolationIds: string[];
  newlyCreatedCrewViolationIds: string[];
  operationalTradeoffs: string[];
}

export interface DispatcherRecommendedAction {
  rank: number;
  actionId: string;
  /** Backend-authoritative action type */
  type: RecoveryActionType;
  /** Backend-authoritative canonical label */
  label: string;
  title: string;
  reason: string;
  benefits: string[];
  tradeoffs: string[];
  operationalImpact: {
    flightsAffected: string[];
    passengerImpact: string;
    crewImpact: string;
    aircraftImpact: string;
  };
  /** Backend-verified standby crew assumption flag */
  usesAssumedStandbyCrew: boolean;
  /** Original deterministic engine rank (1-based) */
  deterministicRank: number;
  /** Original deterministic composite score */
  deterministicScore: number;
  /** Strictly backend-verified before/after KPIs — never produced by AI */
  verifiedKpiComparison: VerifiedRecommendationKpiBundle;
}

export interface DispatcherAlternativeAction {
  actionId: string;
  type: RecoveryActionType;
  label: string;
  reasonLessSuitable: string;
  keyTradeoff: string;
  deterministicRank: number;
  deterministicScore: number;
  usesAssumedStandbyCrew: boolean;
  verifiedDeltas: RecoveryComparison['deltas'];
}

export interface DispatcherRejectedExplanation {
  actionId: string;
  type: RecoveryActionType;
  label: string;
  reason: string;
  backendFeasibilityReason: string;
}

export interface DispatcherCandidateBrief {
  actionId: string;
  type: RecoveryActionType;
  label: string;
  description: string;
  generationReason: string;
  usesAssumedStandbyCrew: boolean;
  isFeasible: boolean;
  feasibilityReason: string;
  feasibilityChecks: RecoveryFeasibilityCheck[];
}

export interface DispatcherDeterministicRankingBrief {
  rank: number;
  actionId: string;
  type: RecoveryActionType;
  label: string;
  totalScore: number;
  usesAssumedStandbyCrew: boolean;
  deltas: RecoveryComparison['deltas'];
  criteria: RankingCriterionScore[];
}

export interface DispatcherSimulationSummary {
  scenarioId: string;
  closure: AirportClosureEvent | null;
  airportName: string | null;
  airportCity: string | null;
  config: SimulationConfig;
  kpis: NetworkKpiSnapshot;
  passengerImpact: PassengerImpactSummary;
  directImpactedFlightCount: number;
  propagatedImpactedFlightCount: number;
  bothImpactedFlightCount: number;
  topDisruptedFlights: Array<{
    flightId: string;
    tailId: string;
    route: string;
    arrivalDelayMin: number;
    status: string;
    impactCategory: string;
    dominoDepth: number;
    primaryTrigger: string;
  }>;
  missedConnections: Array<{
    connectionId: string;
    airportId: string;
    fromFlightId: string;
    toFlightId: string;
    passengers: number;
    shortfallMinutes: number;
    status: string;
  }>;
  crewViolations: Array<{
    crewId: string;
    tailId: string;
    actualDutyMins: number;
    maxDutyMins: number;
    overageMins: number;
    violatingFlightIds: string[];
  }>;
}

export interface DispatcherRecommendResponse {
  aiStatus: AiDispatcherStatus;
  source: 'gemini' | 'deterministic_fallback';
  modelUsed: string;
  preference: DispatcherPreference;
  generatedAtIso: string;
  fallbackReason?: string;
  warningMessage?: string;
  validationIssues?: DispatcherValidationIssue[];
  simulationSummary: DispatcherSimulationSummary;
  feasibleCandidates: DispatcherCandidateBrief[];
  rejectedCandidates: DispatcherCandidateBrief[];
  deterministicRankings: DispatcherDeterministicRankingBrief[];
  situationOverview: string;
  recommendedActions: DispatcherRecommendedAction[];
  alternativeActions: DispatcherAlternativeAction[];
  rejectedActionExplanations: DispatcherRejectedExplanation[];
  dispatcherSummary: string;
  assumptions: string[];
}
