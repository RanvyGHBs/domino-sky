/**
 * Domino Sky — Deterministic Simulation Engine Contracts
 *
 * All numerical outputs (delays, actual times, passenger impact, crew duty durations,
 * and recovery outcomes) are produced exclusively by these deterministic TypeScript modules.
 */

// ---------------------------------------------------------------------------
// 1. Airport Closure Events & Configurable Operational Policies
// ---------------------------------------------------------------------------

/**
 * Deterministic queue ordering policy when a closed airport reopens and
 * queued departures/arrivals compete for runway capacity slots.
 *
 * - 'earliest_ready_then_scheduled_then_flight_id':
 *   1) Earliest ready movement time at the closed airport (ascending)
 *   2) Original scheduled movement time (ascending)
 *   3) Lexicographical flightId tie-breaker (deterministic)
 */
export type ReopeningQueueOrderingPolicy =
  | 'earliest_ready_then_scheduled_then_flight_id'
  | 'scheduled_time_then_flight_id';

/**
 * Policy for handling crew duty limit breaches (> maxDutyMins).
 * Default MUST be 'flag_violation' so flights are not silently auto-cancelled.
 */
export type CrewViolationPolicy = 'flag_violation' | 'cancel_violating_legs';

/**
 * Explicit modelling assumption configuration for spare-aircraft standby crews.
 * The official dataset contains NO standby crew records; this policy is always
 * surfaced as an explicit modelling assumption and never treated as verified data.
 */
export interface AssumedStandbyCrewConfig {
  /**
   * When true, deploying a spare aircraft assumes a standby crew at the spare's
   * base airport. When false, spare deployment requires an explicit verified crew
   * assignment and cannot rely on assumed standby crew availability.
   */
  enabled: boolean;
  /** Assumed pre-departure briefing/report lead time in minutes (default: 45, configurable) */
  preDepartureBriefingMins: number;
  /** Assumed maximum duty window in minutes (default: 600, matching dataset crew limit) */
  maxDutyMins: number;
}

export interface AirportClosureEvent {
  id: string;
  airportId: string;
  /** Inclusive start time in absolute minutes from 00:00 IST */
  startMin: number;
  /** Exclusive reopening time in absolute minutes from 00:00 IST */
  endMin: number;
  durationMinutes: number;
  reason?: string;
}

export interface SimulationConfig {
  /** Minimum turnaround time (defaults to dataset meta.minTurnaroundMinutes = 30) */
  minTurnaroundMinutes: number;
  /**
   * Whether reopening meters queued movements against airport.capacityPerHour.
   * No movement is ever permitted inside [startMin, endMin).
   */
  enforceReopeningCapacityMetering: boolean;
  /** Explicit deterministic queue-ordering rule when reopening capacity is enforced */
  reopeningQueueOrdering: ReopeningQueueOrderingPolicy;
  /**
   * Optional threshold (minutes) beyond which a flight is cancelled rather than
   * operated severely late. Defaults to null (no automatic delay-based cancellation).
   */
  autoCancelDelayThresholdMin: number | null;
  /**
   * Default MUST be 'flag_violation' (flags legal breaches without auto-cancelling).
   * Strict enforcement ('cancel_violating_legs') is an explicit opt-in policy and
   * must pass all cancellations through physical aircraft-position validation.
   */
  crewViolationPolicy: CrewViolationPolicy;
  /**
   * Configurable modelling assumption for spare-aircraft standby crews.
   * Explicitly tagged as an assumption because flight_network.json has no reserve crew table.
   */
  assumedStandbyCrew: AssumedStandbyCrewConfig;
}

// ---------------------------------------------------------------------------
// 2. Flight Execution & Delay Propagation Traces
// ---------------------------------------------------------------------------

export type FlightOperationalStatus = 'on_time' | 'delayed' | 'cancelled';

export type DisruptionCauseType =
  | 'origin_airport_closure_ground_hold'
  | 'destination_airport_closure_ground_hold'
  | 'airborne_arrival_holding'
  | 'reopening_slot_congestion'
  | 'upstream_aircraft_rotation'
  | 'crew_duty_limit_exceeded'
  | 'upstream_cancellation_aircraft_stranded'
  | 'recovery_action_cancellation'
  | 'recovery_action_reassignment'
  | 'recovery_action_hold';

export interface DisruptionCause {
  type: DisruptionCauseType;
  /** Minutes of delay attributable to this cause (0 for non-delay cancellations) */
  delayContributionMin: number;
  /** Reference entity: airportId, upstream flightId, crewId, or recoveryActionId */
  sourceRefId: string;
  /** Human-readable explanation generated deterministically from simulation state */
  explanation: string;
}

export type FlightImpactCategory =
  | 'unaffected'
  | 'direct'
  | 'propagated'
  | 'direct_and_propagated';

export interface FlightCausalExplanation {
  /** Direct closure hit, propagated from prior leg, both, none, or cancelled */
  impactCategory: FlightImpactCategory;
  /** Short deterministic label of the triggering event */
  primaryTrigger: string;
  /** Preceding flight in the same aircraft rotation, if any */
  precedingFlightId: string | null;
  /** Arrival delay inherited from the preceding leg before turnaround slack */
  incomingUpstreamDelayMin: number;
  /** Scheduled turnaround buffer above min_turnaround_minutes (30m) */
  turnaroundSlackAvailableMin: number;
  /** Minutes of upstream delay absorbed by turnaround slack */
  turnaroundSlackAbsorbedMin: number;
  /** Residual upstream delay remaining after turnaround slack */
  residualUpstreamDelayMin: number;
  /** New delay added directly on this leg (closure ground hold, airborne hold, reopening slot) */
  directLegDelayMin: number;
  /** Total remaining arrival delay on this leg */
  finalArrivalDelayMin: number;
  /** Complete deterministic prose explanation covering all 6 causal steps */
  summary: string;
}

export interface SimulatedFlightState {
  flightId: string;
  /** Scheduled tail or reassigned spare/swapped tail */
  assignedTailId: string;
  originalTailId: string;
  legOrder: number;
  /** Preceding flight ID on the same aircraft rotation (null for leg 1) */
  previousFlightId: string | null;
  origin: string;
  destination: string;
  scheduledDepMin: number;
  scheduledArrMin: number;
  /** Null when flight is cancelled */
  actualDepMin: number | null;
  /** Null when flight is cancelled */
  actualArrMin: number | null;
  departureDelayMin: number;
  arrivalDelayMin: number;
  /** Ground hold minutes introduced directly by origin/destination closure */
  closureGroundHoldMinutes: number;
  /** Extra airborne holding minutes when already airborne during destination closure */
  airborneHoldMinutes: number;
  /** Delay introduced by reopening runway capacity slot queueing */
  reopeningSlotDelayMinutes: number;
  /** Aircraft physical airport immediately before this leg is attempted */
  aircraftPositionBefore: string;
  /** Aircraft physical airport after this leg (unchanged if cancelled) */
  aircraftPositionAfter: string;
  status: FlightOperationalStatus;
  impactCategory: FlightImpactCategory;
  /** Ordered causal chain explaining exactly why this flight was disrupted */
  causes: DisruptionCause[];
  /** Structured 6-point deterministic causal explanation (never generated by AI) */
  causalExplanation: FlightCausalExplanation;
  /** Number of propagation hops from the primary closure event (0 = direct hit, 1+ = domino) */
  dominoDepth: number;
  /** Scheduled turnaround slack absorbed before delay propagated downstream */
  turnaroundSlackAbsorbedMin: number;
  pax: number;
  /** Whether a crew duty violation occurs on this leg */
  hasCrewViolation: boolean;
}

// ---------------------------------------------------------------------------
// 3. Aircraft Rotation & Physical Continuity
// ---------------------------------------------------------------------------

export interface AircraftRotationLegState {
  flightId: string;
  legOrder: number;
  origin: string;
  destination: string;
  status: FlightOperationalStatus;
  actualDepMin: number | null;
  actualArrMin: number | null;
  requiredTurnaroundMin: number;
  actualTurnaroundMin: number | null;
  /** Physical location of aircraft before this leg is attempted */
  aircraftPositionBeforeLeg: string;
  /** Physical location of aircraft after this leg (or unchanged if cancelled) */
  aircraftPositionAfterLeg: string;
}

export interface AircraftRotationSummary {
  tailId: string;
  isSpare: boolean;
  startingAirportId: string;
  endingAirportId: string;
  legs: AircraftRotationLegState[];
  totalDelayMin: number;
  delayedLegCount: number;
  cancelledLegCount: number;
  /** True only if every operated leg's origin matches the aircraft's prior physical location */
  isPhysicallyConsistent: boolean;
  consistencyErrors: string[];
}

// ---------------------------------------------------------------------------
// 4. Passenger Connection & Stranded Impact Analysis
// ---------------------------------------------------------------------------

export type ConnectionOutcomeStatus =
  | 'made'
  | 'missed_due_to_delay'
  | 'broken_due_to_from_cancellation'
  | 'broken_due_to_to_cancellation'
  | 'broken_due_to_both_cancelled';

export interface SimulatedConnectionState {
  connectionId: string;
  airportId: string;
  fromFlightId: string;
  toFlightId: string;
  passengers: number;
  minConnectMinutes: number;
  scheduledConnectMinutes: number;
  /** Null if either flight is cancelled */
  actualConnectMinutes: number | null;
  status: ConnectionOutcomeStatus;
  shortfallMinutes: number;
  explanation: string;
}

export interface PassengerImpactSummary {
  /** Sum of pax on cancelled flights (passenger-trips) */
  cancelledFlightPax: number;
  /** Sum of pax on connections missed strictly because both flights operated but connect time < min_connect_minutes */
  missedConnectionPax: number;
  /**
   * Connecting pax whose feeder or onward flight was cancelled.
   * Tracked separately so they are NEVER double-counted on top of cancelledFlightPax.
   */
  cancelledConnectionOverlapPax: number;
  /**
   * Conservative lower-bound total affected/stranded passenger-trips:
   * cancelledFlightPax + missedConnectionPax (excludes cancelledConnectionOverlapPax).
   */
  totalStrandedPaxEstimate: number;
  /** Passengers on flights delayed >= 15 minutes (operated, not cancelled) */
  delayedFlightPax: number;
  missedConnectionsCount: number;
  brokenByCancellationCount: number;
  preservedConnectionsCount: number;
  /** Explicit methodology note surfaced in the UI for auditability */
  countingNote: string;
}

// ---------------------------------------------------------------------------
// 5. Crew Duty-Time Analysis
// ---------------------------------------------------------------------------

export interface SimulatedCrewState {
  crewId: string;
  tailId: string;
  baseAirportId: string;
  /**
   * True ONLY when this crew record was synthesized via the configurable
   * standby-crew modelling assumption for a spare aircraft. Never silently
   * presented as verified official dataset data.
   */
  isAssumedStandbyCrew: boolean;
  assumptionDisclosure?: string;
  dutyStartMin: number;
  maxDutyMins: number;
  scheduledEndMin: number;
  /** Actual arrival time of the crew's last operated flight (or dutyStartMin if all legs cancelled) */
  actualEndMin: number;
  scheduledDutyMins: number;
  actualDutyMins: number;
  /** Positive if actualDutyMins > maxDutyMins, otherwise 0 */
  overageMins: number;
  isViolation: boolean;
  /** Flight IDs that complete after dutyStartMin + maxDutyMins */
  violatingFlightIds: string[];
  operatedFlightIds: string[];
  cancelledFlightIds: string[];
}

// ---------------------------------------------------------------------------
// 6. Recovery Actions, Feasibility Validation & Before/After Comparison
// ---------------------------------------------------------------------------

export type RecoveryActionType =
  | 'deploy_spare_aircraft'
  | 'cancel_flight_chain'
  | 'hold_connection_flight'
  | 'swap_aircraft_rotations';

export interface RecoveryFeasibilityCheck {
  checkName:
    | 'spare_base_position'
    | 'spare_availability_time'
    | 'aircraft_seat_capacity'
    | 'physical_aircraft_continuity'
    | 'crew_assignment_legality'
    | 'standby_crew_assumption'
    | 'closure_window_compliance';
  passed: boolean;
  detail: string;
  /** True when passing this check relies on a documented modelling assumption rather than official JSON data */
  reliesOnAssumption?: boolean;
}

export interface RecoveryAction {
  actionId: string;
  type: RecoveryActionType;
  label: string;
  description: string;
  /** Deterministic reason why the candidate generator proposed this recovery option */
  generationReason: string;
  /** Primary target flight(s), spare tail, or connection depending on action type */
  parameters: {
    spareTailId?: string;
    targetFlightId?: string;
    /** Explicit list of flights reassigned to a spare or swapped tail */
    reassignedFlightIds?: string[];
    /** Explicit list of flights cancelled together (e.g. out-and-back pair or remaining chain) */
    cancelledFlightIds?: string[];
    targetTailId?: string;
    secondaryTailId?: string;
    secondaryFlightId?: string;
    secondaryReassignedFlightIds?: string[];
    connectionId?: string;
    holdMinutes?: number;
    holdTargetDepMin?: number;
  };
  /** True only when EVERY required physical and crew feasibility check passes */
  isFeasible: boolean;
  feasibilityReason: string;
  feasibilityChecks: RecoveryFeasibilityCheck[];
  /** Explicit flag whenever the action depends on the configurable standby-crew assumption */
  usesAssumedStandbyCrew: boolean;
  /** Must be true only after the deterministic engine has re-simulated this action */
  isEngineVerified: boolean;
}

export interface NetworkKpiSnapshot {
  totalFlights: number;
  operatedFlights: number;
  onTimeFlights: number;
  delayedFlights: number;
  cancelledFlights: number;
  totalDelayMinutes: number;
  /** Average arrival delay among delayed operated flights (0 if no flights delayed) */
  averageDelayMinutes: number;
  maxDelayMinutes: number;
  affectedAircraftCount: number;
  missedConnectionsCount: number;
  missedConnectionPax: number;
  cancelledFlightPax: number;
  cancelledConnectionOverlapPax: number;
  totalStrandedPaxEstimate: number;
  crewViolationsCount: number;
  maxCrewOverageMins: number;
}

export interface SimulationResult {
  scenarioId: string;
  closure: AirportClosureEvent | null;
  config: SimulationConfig;
  appliedRecoveryActions: RecoveryAction[];
  /** Explicit disclosure list of active modelling assumptions applied during this run */
  activeAssumptions: string[];
  flights: SimulatedFlightState[];
  rotations: AircraftRotationSummary[];
  connections: SimulatedConnectionState[];
  passengerImpact: PassengerImpactSummary;
  crews: SimulatedCrewState[];
  kpis: NetworkKpiSnapshot;
  /** Deterministic timeline of major disruption milestones for step-by-step inspection */
  propagationLog: Array<{
    timeMin: number;
    flightId: string;
    tailId: string;
    event: string;
    dominoDepth: number;
  }>;
}

export type FlightRecoveryOutcome =
  | 'recovered'
  | 'delay_reduced'
  | 'delay_increased'
  | 'cancelled_for_recovery'
  | 'unaffected';

export interface FlightRecoveryDiff {
  flightId: string;
  tailBefore: string;
  tailAfter: string;
  route: string;
  baselineStatus: FlightOperationalStatus;
  recoveredStatus: FlightOperationalStatus;
  baselineArrivalDelayMin: number;
  recoveredArrivalDelayMin: number;
  arrivalDelayDeltaMin: number;
  outcome: FlightRecoveryOutcome;
}

export interface MetricDeltaRecord {
  metric: keyof NetworkKpiSnapshot;
  label: string;
  unit: string;
  before: number;
  after: number;
  /** after - before (negative is better for delays, cancellations, stranded pax, crew breaches) */
  delta: number;
  direction: 'improved' | 'worsened' | 'unchanged';
}

export interface RecoveryComparison {
  baseline: SimulationResult;
  recovered: SimulationResult;
  appliedAction: RecoveryAction;
  feasibilityStatus: {
    isFeasible: boolean;
    reason: string;
    checks: RecoveryFeasibilityCheck[];
    usesAssumedStandbyCrew: boolean;
  };
  deltas: {
    delayedFlightsDelta: number;
    cancelledFlightsDelta: number;
    totalDelayMinutesDelta: number;
    averageDelayMinutesDelta: number;
    maxDelayMinutesDelta: number;
    missedConnectionsDelta: number;
    missedConnectionPaxDelta: number;
    cancelledFlightPaxDelta: number;
    cancelledConnectionOverlapPaxDelta: number;
    totalStrandedPaxDelta: number;
    crewViolationsDelta: number;
    maxCrewOverageMinsDelta: number;
  };
  improvedMetrics: MetricDeltaRecord[];
  worsenedMetrics: MetricDeltaRecord[];
  unchangedMetrics: MetricDeltaRecord[];
  operationalTradeoffs: string[];
  flightDiffs: FlightRecoveryDiff[];
  /** Flights delayed in baseline that became on_time after recovery */
  recoveredFlightIds: string[];
  /** Flights still delayed in recovery, but with strictly lower arrival delay */
  delayReducedFlightIds: string[];
  /** Flights with higher delay after recovery (including on_time -> delayed) */
  delayIncreasedFlightIds: string[];
  /** Flights operated in baseline that were cancelled as part of recovery */
  cancelledForRecoveryFlightIds: string[];
  /** Flights with identical status and identical arrival delay */
  unaffectedFlightIds: string[];
  /** Convenience union: recoveredFlightIds + delayReducedFlightIds */
  improvedFlightIds: string[];
  /** Convenience union: delayIncreasedFlightIds + cancelledForRecoveryFlightIds */
  worsenedFlightIds: string[];
  resolvedCrewViolationIds: string[];
  newlyCreatedCrewViolationIds: string[];
  savedConnectionIds: string[];
  lostConnectionIds: string[];
}

export type RankingCriterionId =
  | 'feasibility_and_continuity'
  | 'passenger_impact_reduction'
  | 'total_delay_reduction'
  | 'crew_duty_compliance'
  | 'cancellation_avoidance';

export interface RankingCriterionScore {
  id: RankingCriterionId;
  label: string;
  priorityRank: 1 | 2 | 3 | 4 | 5;
  /** Explicit weight in the deterministic composite score (0..1 for scored criteria; gate for feasibility) */
  weight: number;
  rawMetricSummary: string;
  /** Normalized transparent score on [-100, +100] */
  criterionScore: number;
  weightedContribution: number;
  explanation: string;
}

export interface RecoveryRankingBreakdown {
  totalScore: number;
  criteria: RankingCriterionScore[];
  tradeoffSummary: string[];
}

export interface RankedRecoveryOption {
  rank: number;
  action: RecoveryAction;
  comparison: RecoveryComparison;
  ranking: RecoveryRankingBreakdown;
}

export interface CandidateGenerationOutput {
  candidates: RecoveryAction[];
  rejectedCandidates: RecoveryAction[];
}

