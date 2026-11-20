/**
 * Module 3: Flight Scheduling & Deterministic Delay Propagation Engine
 *
 * Chronologically simulates all 70 scheduled flights across 16 aircraft rotations:
 * - Evaluates airport closures strictly against actual departure & arrival timelines.
 * - Enforces the half-open closure interval [startMin, endMin) with zero movements inside.
 * - Distinguishes origin ground hold, destination GDP hold, airborne arrival holding,
 *   and reopening runway capacity metering (with deterministic queue ordering).
 * - Enforces minimum 30-minute turnaround, absorbs turnaround slack where available,
 *   and maintains strict physical aircraft location continuity (no aircraft teleporting).
 * - Integrates passenger connection analysis (21 official connections, no double-counting)
 *   and crew duty-time analysis (16 official crews, flag_violation default).
 */

import type {
  AirportClosureEvent,
  DisruptionCause,
  FlightImpactCategory,
  NetworkKpiSnapshot,
  NormalizedFlightNetwork,
  RecoveryAction,
  ScheduledFlight,
  SimulatedCrewState,
  SimulatedFlightState,
  SimulationConfig,
  SimulationResult,
} from '../../types/index.ts';
import {
  DEFAULT_SIMULATION_CONFIG,
  evaluateFlightAgainstClosure,
  type ClosureTimelineEvaluation,
} from '../closure/index.ts';
import { buildRotationSummaries, verifyPhysicalConsistency } from '../rotation/index.ts';
import { analyzePassengerImpact } from '../passenger/index.ts';
import { analyzeCrewDuty } from '../crew/index.ts';
import { formatMinutesToClock } from '../time.ts';
import { buildFlightCausalExplanation } from './causalExplanation.ts';

export interface DelayPropagationEngine {
  simulateScenario(
    network: NormalizedFlightNetwork,
    closure: AirportClosureEvent | null,
    config?: Partial<SimulationConfig>,
    recoveryActions?: RecoveryAction[]
  ): SimulationResult;

  traceCausalChain(
    flights: SimulatedFlightState[],
    flightId: string
  ): SimulatedFlightState[];
}

export interface SimulationExecutionOptions {
  /** Explicit set of flights cancelled prior to propagation (e.g., recovery action or continuity test) */
  preCancelledFlightIds?: ReadonlySet<string>;
  /** Recovery actions attached to this simulation run */
  appliedRecoveryActions?: RecoveryAction[];
  /** Custom scenario identifier */
  scenarioId?: string;
}

interface AircraftCursor {
  tailId: string;
  legs: ScheduledFlight[];
  nextIdx: number;
  currentPosition: string;
  lastOperatedFlightId: string | null;
  lastOperatedSchedArrMin: number | null;
  lastOperatedActualArrMin: number | null;
  lastOperatedDominoDepth: number;
}

interface TentativeLegPlan {
  cursor: AircraftCursor;
  leg: ScheduledFlight;
  previousFlightId: string | null;
  isPreCancelled: boolean;
  isPhysicallyStranded: boolean;
  incomingUpstreamDelayMin: number;
  turnaroundSlackAvailableMin: number;
  turnaroundSlackAbsorbedMin: number;
  readyDepMin: number;
  residualUpstreamDelayMin: number;
  closureEval: ClosureTimelineEvaluation;
  touchesReopenedOrigin: boolean;
  touchesReopenedDest: boolean;
  isCompetingAtReopenedAirport: boolean;
  wasClosureHeld: boolean;
  eventTimeMin: number;
  movementScheduledMin: number;
}

function resolveSimulationConfig(
  network: NormalizedFlightNetwork,
  overrides?: Partial<SimulationConfig>
): SimulationConfig {
  return {
    ...DEFAULT_SIMULATION_CONFIG,
    minTurnaroundMinutes: network.meta.minTurnaroundMinutes,
    ...overrides,
    assumedStandbyCrew: {
      ...DEFAULT_SIMULATION_CONFIG.assumedStandbyCrew,
      ...(overrides?.assumedStandbyCrew ?? {}),
    },
  };
}

function buildActiveAssumptionsList(
  closure: AirportClosureEvent | null,
  config: SimulationConfig
): string[] {
  const assumptions: string[] = [
    'Absolute-minute time axis from 00:00 IST (monotonic past midnight, formatted +1d).',
    'Passenger impact separates cancelledFlightPax and missedConnectionPax; connections broken by cancelled flights are tracked separately to prevent double counting.',
    config.crewViolationPolicy === 'flag_violation'
      ? 'Crew duty policy: flag_violation (default) — violations are flagged with exact overage minutes without auto-cancelling flights.'
      : 'Crew duty policy: cancel_violating_legs (strict opt-in) — legs exceeding max_duty_mins are cancelled and validated for physical aircraft continuity.',
  ];

  if (closure) {
    assumptions.push(
      `Airport closure [${formatMinutesToClock(closure.startMin)}, ${formatMinutesToClock(closure.endMin)}) at ${closure.airportId} evaluated against actual timelines (ground hold vs airborne holding; zero movements inside closure).`
    );
    if (config.enforceReopeningCapacityMetering) {
      assumptions.push(
        `Reopening capacity metering enabled (ordering: ${config.reopeningQueueOrdering}); unaffected flights outside active backlog incur 0m congestion delay.`
      );
    } else {
      assumptions.push('Reopening capacity metering disabled (immediate release at reopening time).');
    }
  }

  return assumptions;
}

function evaluateCursorNextLeg(
  cursor: AircraftCursor,
  closure: AirportClosureEvent | null,
  config: SimulationConfig,
  preCancelledFlightIds: ReadonlySet<string>
): TentativeLegPlan {
  const leg = cursor.legs[cursor.nextIdx];
  const previousFlightId = cursor.nextIdx > 0 ? cursor.legs[cursor.nextIdx - 1].flightId : null;

  const isPreCancelled = preCancelledFlightIds.has(leg.flightId);
  const isPhysicallyStranded = !isPreCancelled && cursor.currentPosition !== leg.origin;

  let incomingUpstreamDelayMin = 0;
  let turnaroundSlackAvailableMin = 0;
  let turnaroundSlackAbsorbedMin = 0;
  let readyDepMin = leg.scheduledDepMin;
  let residualUpstreamDelayMin = 0;

  if (!isPreCancelled && !isPhysicallyStranded && cursor.lastOperatedActualArrMin !== null && cursor.lastOperatedSchedArrMin !== null) {
    const scheduledTurnaround = leg.scheduledDepMin - cursor.lastOperatedSchedArrMin;
    turnaroundSlackAvailableMin = Math.max(0, scheduledTurnaround - config.minTurnaroundMinutes);
    incomingUpstreamDelayMin = Math.max(
      0,
      cursor.lastOperatedActualArrMin - cursor.lastOperatedSchedArrMin
    );
    turnaroundSlackAbsorbedMin = Math.min(incomingUpstreamDelayMin, turnaroundSlackAvailableMin);
    readyDepMin = Math.max(
      leg.scheduledDepMin,
      cursor.lastOperatedActualArrMin + config.minTurnaroundMinutes
    );
    residualUpstreamDelayMin = Math.max(0, readyDepMin - leg.scheduledDepMin);
  }

  const closureEval = evaluateFlightAgainstClosure({
    origin: leg.origin,
    destination: leg.destination,
    readyDepMin,
    blockMinutes: leg.blockMinutes,
    closure,
  });

  const touchesReopenedOrigin = Boolean(
    closure && leg.origin === closure.airportId && closureEval.adjustedDepMin >= closure.endMin
  );
  const touchesReopenedDest = Boolean(
    closure &&
      leg.destination === closure.airportId &&
      closureEval.adjustedArrMin >= closure.endMin
  );
  const isCompetingAtReopenedAirport = Boolean(
    closure &&
      config.enforceReopeningCapacityMetering &&
      (touchesReopenedOrigin || touchesReopenedDest)
  );
  const wasClosureHeld =
    closureEval.isOriginAffected || closureEval.isDestinationAffected;

  const eventTimeMin = touchesReopenedOrigin
    ? closureEval.adjustedDepMin
    : touchesReopenedDest
      ? closureEval.adjustedArrMin
      : closureEval.adjustedDepMin;

  const movementScheduledMin = touchesReopenedOrigin
    ? leg.scheduledDepMin
    : touchesReopenedDest
      ? leg.scheduledArrMin
      : leg.scheduledDepMin;

  return {
    cursor,
    leg,
    previousFlightId,
    isPreCancelled,
    isPhysicallyStranded,
    incomingUpstreamDelayMin,
    turnaroundSlackAvailableMin,
    turnaroundSlackAbsorbedMin,
    readyDepMin,
    residualUpstreamDelayMin,
    closureEval,
    touchesReopenedOrigin,
    touchesReopenedDest,
    isCompetingAtReopenedAirport,
    wasClosureHeld,
    eventTimeMin,
    movementScheduledMin,
  };
}

function compareTentativePlans(
  a: TentativeLegPlan,
  b: TentativeLegPlan,
  closure: AirportClosureEvent | null,
  config: SimulationConfig
): number {
  // 1. Immediately drain cancelled/stranded legs so aircraft positions stay settled
  const aCancelled = a.isPreCancelled || a.isPhysicallyStranded ? 0 : 1;
  const bCancelled = b.isPreCancelled || b.isPhysicallyStranded ? 0 : 1;
  if (aCancelled !== bCancelled) return aCancelled - bCancelled;

  // 2. Always settle legs completing at or before closure reopening before allocating reopening slots
  if (closure) {
    const aPreReopen = !a.isCompetingAtReopenedAirport && a.closureEval.adjustedArrMin <= closure.endMin ? 0 : 1;
    const bPreReopen = !b.isCompetingAtReopenedAirport && b.closureEval.adjustedArrMin <= closure.endMin ? 0 : 1;
    if (aPreReopen !== bPreReopen) return aPreReopen - bPreReopen;
  }

  // 3. Reopening queue ordering when both compete for reopened runway slots
  if (
    a.isCompetingAtReopenedAirport &&
    b.isCompetingAtReopenedAirport &&
    config.reopeningQueueOrdering === 'scheduled_time_then_flight_id' &&
    a.wasClosureHeld &&
    b.wasClosureHeld
  ) {
    if (a.movementScheduledMin !== b.movementScheduledMin) {
      return a.movementScheduledMin - b.movementScheduledMin;
    }
    if (a.eventTimeMin !== b.eventTimeMin) {
      return a.eventTimeMin - b.eventTimeMin;
    }
    return a.leg.flightId.localeCompare(b.leg.flightId);
  }

  // 4. Strict chronological causality by ready/movement event time
  if (a.eventTimeMin !== b.eventTimeMin) {
    return a.eventTimeMin - b.eventTimeMin;
  }
  if (a.movementScheduledMin !== b.movementScheduledMin) {
    return a.movementScheduledMin - b.movementScheduledMin;
  }
  return a.leg.flightId.localeCompare(b.leg.flightId);
}

/**
 * Pure deterministic simulation runner.
 * Given identical (network, closure, config, options), always returns bit-identical output.
 */
export function simulateDisruption(
  network: NormalizedFlightNetwork,
  closure: AirportClosureEvent | null,
  configOverrides?: Partial<SimulationConfig>,
  options?: SimulationExecutionOptions
): SimulationResult {
  const config = resolveSimulationConfig(network, configOverrides);
  const preCancelledFlightIds = options?.preCancelledFlightIds ?? new Set<string>();
  const appliedRecoveryActions = options?.appliedRecoveryActions ?? [];

  // Initialize one deterministic cursor per active aircraft tail
  const cursors: AircraftCursor[] = network.activeAircraft.map((ac) => {
    const legs = network.index.flightsByTailId[ac.tailId];
    return {
      tailId: ac.tailId,
      legs,
      nextIdx: 0,
      currentPosition: legs[0].origin,
      lastOperatedFlightId: null,
      lastOperatedSchedArrMin: null,
      lastOperatedActualArrMin: null,
      lastOperatedDominoDepth: -1,
    };
  });

  // Shared reopening runway capacity state for the closed airport
  const closedAirportCapacity = closure
    ? network.index.airportsById[closure.airportId].capacityPerHour
    : 0;
  const minRunwaySpacing =
    closedAirportCapacity > 0 ? Math.max(1, Math.floor(60 / closedAirportCapacity)) : 0;
  const reopenedMovementTimes: number[] = [];
  let backlogActiveUntilMin = closure ? closure.endMin : 0;

  const simulatedByFlightId = new Map<string, SimulatedFlightState>();
  const propagationLog: SimulationResult['propagationLog'] = [];

  const reserveReopeningSlotPreview = (
    readyTimeMin: number,
    wasClosureHeld: boolean
  ): { slotMin: number; congestionDelayMin: number } => {
    if (!closure || !config.enforceReopeningCapacityMetering || closedAirportCapacity <= 0) {
      return { slotMin: readyTimeMin, congestionDelayMin: 0 };
    }

    let slotMin = Math.max(readyTimeMin, closure.endMin);

    // Rolling 60-minute capacity ceiling: at most `closedAirportCapacity` movements per 60m window
    if (reopenedMovementTimes.length >= closedAirportCapacity) {
      const blockingMovement =
        reopenedMovementTimes[reopenedMovementTimes.length - closedAirportCapacity];
      const nextWindowOpen = blockingMovement + 60;
      if (slotMin < nextWindowOpen) {
        slotMin = nextWindowOpen;
      }
    }

    // Active reopening backlog spacing (never delays flights operating outside an active backlog wave)
    if (reopenedMovementTimes.length > 0) {
      const prevTime = reopenedMovementTimes[reopenedMovementTimes.length - 1];
      const inActiveBacklog = wasClosureHeld || readyTimeMin < backlogActiveUntilMin;
      if (inActiveBacklog && slotMin < prevTime + minRunwaySpacing) {
        slotMin = prevTime + minRunwaySpacing;
      }
    }

    return {
      slotMin,
      congestionDelayMin: Math.max(0, slotMin - readyTimeMin),
    };
  };

  const commitReopeningSlot = (
    slotMin: number,
    readyTimeMin: number,
    wasClosureHeld: boolean
  ) => {
    reopenedMovementTimes.push(slotMin);
    if (wasClosureHeld || readyTimeMin < backlogActiveUntilMin || slotMin > readyTimeMin) {
      backlogActiveUntilMin = Math.max(backlogActiveUntilMin, slotMin + minRunwaySpacing);
    }
  };

  // Chronological event loop across all aircraft rotations
  while (true) {
    const frontier: TentativeLegPlan[] = [];
    for (const cursor of cursors) {
      if (cursor.nextIdx < cursor.legs.length) {
        frontier.push(
          evaluateCursorNextLeg(cursor, closure, config, preCancelledFlightIds)
        );
      }
    }
    if (frontier.length === 0) break;

    frontier.sort((a, b) => compareTentativePlans(a, b, closure, config));
    const chosen = frontier[0];
    const { cursor, leg } = chosen;
    const posBefore = cursor.currentPosition;
    const crew = network.index.crewByTailId[cursor.tailId];

    // Path A: Pre-cancelled or physically stranded by an earlier cancellation on this tail
    if (chosen.isPreCancelled || chosen.isPhysicallyStranded) {
      const causes: DisruptionCause[] = chosen.isPreCancelled
        ? [
            {
              type: 'recovery_action_cancellation',
              delayContributionMin: 0,
              sourceRefId: leg.flightId,
              explanation: `Flight ${leg.flightId} (${leg.origin}→${leg.destination}) was cancelled.`,
            },
          ]
        : [
            {
              type: 'upstream_cancellation_aircraft_stranded',
              delayContributionMin: 0,
              sourceRefId: chosen.previousFlightId ?? cursor.tailId,
              explanation: `Cancelled due to aircraft continuity: ${cursor.tailId} remains physically at ${posBefore} and cannot depart ${leg.flightId} from ${leg.origin}.`,
            },
          ];

      const impactCategory: FlightImpactCategory = chosen.isPreCancelled
        ? 'direct'
        : 'propagated';
      const dominoDepth = chosen.isPreCancelled
        ? 0
        : Math.max(1, cursor.lastOperatedDominoDepth + 1);

      const causalExplanation = buildFlightCausalExplanation({
        flight: leg,
        status: 'cancelled',
        impactCategory,
        precedingFlightId: chosen.previousFlightId,
        incomingUpstreamDelayMin: 0,
        turnaroundSlackAvailableMin: 0,
        turnaroundSlackAbsorbedMin: 0,
        residualUpstreamDelayMin: 0,
        closureGroundHoldMinutes: 0,
        airborneHoldMinutes: 0,
        reopeningSlotDelayMinutes: 0,
        finalArrivalDelayMin: 0,
        causes,
        closure,
        minTurnaroundMinutes: config.minTurnaroundMinutes,
      });

      simulatedByFlightId.set(leg.flightId, {
        flightId: leg.flightId,
        assignedTailId: cursor.tailId,
        originalTailId: leg.tailId,
        legOrder: leg.legOrder,
        previousFlightId: chosen.previousFlightId,
        origin: leg.origin,
        destination: leg.destination,
        scheduledDepMin: leg.scheduledDepMin,
        scheduledArrMin: leg.scheduledArrMin,
        actualDepMin: null,
        actualArrMin: null,
        departureDelayMin: 0,
        arrivalDelayMin: 0,
        closureGroundHoldMinutes: 0,
        airborneHoldMinutes: 0,
        reopeningSlotDelayMinutes: 0,
        aircraftPositionBefore: posBefore,
        aircraftPositionAfter: posBefore,
        status: 'cancelled',
        impactCategory,
        causes,
        causalExplanation,
        dominoDepth,
        turnaroundSlackAbsorbedMin: 0,
        pax: leg.pax,
        hasCrewViolation: false,
      });

      propagationLog.push({
        timeMin: leg.scheduledDepMin,
        flightId: leg.flightId,
        tailId: cursor.tailId,
        event: causes[0].explanation,
        dominoDepth,
      });

      cursor.nextIdx += 1;
      continue;
    }

    // Path B: Physically operable leg — apply reopening runway capacity if competing
    let actualDepMin = chosen.closureEval.adjustedDepMin;
    let actualArrMin = chosen.closureEval.adjustedArrMin;
    let closureGroundHoldMinutes = chosen.closureEval.groundHoldMinutes;
    let airborneHoldMinutes = chosen.closureEval.airborneHoldMinutes;
    let reopeningSlotDelayMinutes = 0;
    let committedSlotTime: number | null = null;
    let slotReadyRef = 0;

    if (chosen.isCompetingAtReopenedAirport) {
      slotReadyRef = chosen.touchesReopenedOrigin ? actualDepMin : actualArrMin;
      const slotPreview = reserveReopeningSlotPreview(slotReadyRef, chosen.wasClosureHeld);
      reopeningSlotDelayMinutes = slotPreview.congestionDelayMin;
      committedSlotTime = slotPreview.slotMin;

      if (reopeningSlotDelayMinutes > 0) {
        if (chosen.touchesReopenedOrigin) {
          actualDepMin = slotPreview.slotMin;
          actualArrMin = actualDepMin + leg.blockMinutes;
        } else if (chosen.closureEval.isAlreadyAirborne) {
          // Already airborne before closure started -> extends airborne holding
          actualArrMin = slotPreview.slotMin;
          airborneHoldMinutes += reopeningSlotDelayMinutes;
        } else {
          // Not yet departed -> hold at origin so arrival matches assigned runway slot
          actualDepMin += reopeningSlotDelayMinutes;
          actualArrMin = slotPreview.slotMin;
        }
      }
    }

    const departureDelayMin = Math.max(0, actualDepMin - leg.scheduledDepMin);
    const arrivalDelayMin = Math.max(0, actualArrMin - leg.scheduledArrMin);

    // Check optional strict crew cutoff or auto-cancel threshold (both OFF by default)
    const exceedsAutoCancel =
      config.autoCancelDelayThresholdMin !== null &&
      arrivalDelayMin > config.autoCancelDelayThresholdMin;
    const exceedsStrictCrewLimit =
      config.crewViolationPolicy === 'cancel_violating_legs' &&
      crew &&
      actualArrMin > crew.dutyStartMin + crew.maxDutyMins;

    if (exceedsStrictCrewLimit || exceedsAutoCancel) {
      const overage = crew ? actualArrMin - (crew.dutyStartMin + crew.maxDutyMins) : 0;
      const cancelCause: DisruptionCause = exceedsStrictCrewLimit
        ? {
            type: 'crew_duty_limit_exceeded',
            delayContributionMin: 0,
            sourceRefId: crew.crewId,
            explanation: `Cancelled under strict crew duty policy: ${crew.crewId} would finish at ${formatMinutesToClock(actualArrMin)} (+${overage}m over ${crew.maxDutyMins}m limit). Aircraft ${cursor.tailId} remains at ${posBefore}.`,
          }
        : {
            type: 'recovery_action_cancellation',
            delayContributionMin: 0,
            sourceRefId: leg.flightId,
            explanation: `Cancelled under auto-cancel threshold (${arrivalDelayMin}m > ${config.autoCancelDelayThresholdMin}m). Aircraft ${cursor.tailId} remains at ${posBefore}.`,
          };

      const dominoDepth =
        chosen.wasClosureHeld
          ? 0
          : Math.max(1, cursor.lastOperatedDominoDepth + 1);

      const causalExplanation = buildFlightCausalExplanation({
        flight: leg,
        status: 'cancelled',
        impactCategory: chosen.wasClosureHeld ? 'direct' : 'propagated',
        precedingFlightId: chosen.previousFlightId,
        incomingUpstreamDelayMin: chosen.incomingUpstreamDelayMin,
        turnaroundSlackAvailableMin: chosen.turnaroundSlackAvailableMin,
        turnaroundSlackAbsorbedMin: chosen.turnaroundSlackAbsorbedMin,
        residualUpstreamDelayMin: chosen.residualUpstreamDelayMin,
        closureGroundHoldMinutes,
        airborneHoldMinutes,
        reopeningSlotDelayMinutes,
        finalArrivalDelayMin: 0,
        causes: [cancelCause],
        closure,
        minTurnaroundMinutes: config.minTurnaroundMinutes,
      });

      simulatedByFlightId.set(leg.flightId, {
        flightId: leg.flightId,
        assignedTailId: cursor.tailId,
        originalTailId: leg.tailId,
        legOrder: leg.legOrder,
        previousFlightId: chosen.previousFlightId,
        origin: leg.origin,
        destination: leg.destination,
        scheduledDepMin: leg.scheduledDepMin,
        scheduledArrMin: leg.scheduledArrMin,
        actualDepMin: null,
        actualArrMin: null,
        departureDelayMin: 0,
        arrivalDelayMin: 0,
        closureGroundHoldMinutes: 0,
        airborneHoldMinutes: 0,
        reopeningSlotDelayMinutes: 0,
        aircraftPositionBefore: posBefore,
        aircraftPositionAfter: posBefore,
        status: 'cancelled',
        impactCategory: chosen.wasClosureHeld ? 'direct' : 'propagated',
        causes: [cancelCause],
        causalExplanation,
        dominoDepth,
        turnaroundSlackAbsorbedMin: chosen.turnaroundSlackAbsorbedMin,
        pax: leg.pax,
        hasCrewViolation: false,
      });

      propagationLog.push({
        timeMin: leg.scheduledDepMin,
        flightId: leg.flightId,
        tailId: cursor.tailId,
        event: cancelCause.explanation,
        dominoDepth,
      });

      // Aircraft does NOT move and does NOT consume a runway slot
      cursor.nextIdx += 1;
      continue;
    }

    // Commit reopening slot now that the leg is confirmed operated
    if (committedSlotTime !== null) {
      commitReopeningSlot(committedSlotTime, slotReadyRef, chosen.wasClosureHeld);
    }

    // Assemble ordered deterministic causes for this operated leg
    const causes: DisruptionCause[] = [];

    if (chosen.residualUpstreamDelayMin > 0 && chosen.previousFlightId) {
      causes.push({
        type: 'upstream_aircraft_rotation',
        delayContributionMin: chosen.residualUpstreamDelayMin,
        sourceRefId: chosen.previousFlightId,
        explanation:
          chosen.turnaroundSlackAbsorbedMin > 0
            ? `Previous leg ${chosen.previousFlightId} arrived ${chosen.incomingUpstreamDelayMin}m late; ${chosen.turnaroundSlackAbsorbedMin}m turnaround slack absorbed, leaving +${chosen.residualUpstreamDelayMin}m delay (${config.minTurnaroundMinutes}m min turnaround).`
            : `Previous leg ${chosen.previousFlightId} arrived ${chosen.incomingUpstreamDelayMin}m late with 0m turnaround slack (${config.minTurnaroundMinutes}m min turnaround), propagating +${chosen.residualUpstreamDelayMin}m.`,
      });
    }

    if (chosen.closureEval.isOriginAffected && closure) {
      causes.push({
        type: 'origin_airport_closure_ground_hold',
        delayContributionMin: closureGroundHoldMinutes,
        sourceRefId: closure.airportId,
        explanation: `Origin ${closure.airportId} closed ${formatMinutesToClock(closure.startMin)}–${formatMinutesToClock(closure.endMin)}; held at gate until ${formatMinutesToClock(chosen.closureEval.adjustedDepMin)} (+${closureGroundHoldMinutes}m).`,
      });
    }

    if (chosen.closureEval.isDestinationAffected && closure) {
      if (chosen.closureEval.isAlreadyAirborne) {
        causes.push({
          type: 'airborne_arrival_holding',
          delayContributionMin: chosen.closureEval.airborneHoldMinutes,
          sourceRefId: closure.airportId,
          explanation: `Already airborne (dep ${formatMinutesToClock(actualDepMin)}) when destination ${closure.airportId} closed ${formatMinutesToClock(closure.startMin)}–${formatMinutesToClock(closure.endMin)}; airborne arrival hold of +${chosen.closureEval.airborneHoldMinutes}m until reopening.`,
        });
      } else {
        causes.push({
          type: 'destination_airport_closure_ground_hold',
          delayContributionMin: closureGroundHoldMinutes,
          sourceRefId: closure.airportId,
          explanation: `Destination ${closure.airportId} closed ${formatMinutesToClock(closure.startMin)}–${formatMinutesToClock(closure.endMin)}; ground-held at origin ${leg.origin} (+${closureGroundHoldMinutes}m) to arrive at reopening.`,
        });
      }
    }

    if (reopeningSlotDelayMinutes > 0 && closure) {
      causes.push({
        type: 'reopening_slot_congestion',
        delayContributionMin: reopeningSlotDelayMinutes,
        sourceRefId: closure.airportId,
        explanation: `Reopening runway capacity queue at ${closure.airportId} (${closedAirportCapacity}/hr) added +${reopeningSlotDelayMinutes}m.`,
      });
    }

    const isDelayed = departureDelayMin > 0 || arrivalDelayMin > 0;
    const hasDirectHit =
      closureGroundHoldMinutes > 0 ||
      airborneHoldMinutes > 0 ||
      reopeningSlotDelayMinutes > 0;
    const hasPropagatedHit = chosen.residualUpstreamDelayMin > 0;

    let impactCategory: FlightImpactCategory = 'unaffected';
    if (hasDirectHit && hasPropagatedHit) {
      impactCategory = 'direct_and_propagated';
    } else if (hasDirectHit) {
      impactCategory = 'direct';
    } else if (hasPropagatedHit) {
      impactCategory = 'propagated';
    }

    let dominoDepth = 0;
    if (hasDirectHit) {
      dominoDepth = 0;
    } else if (hasPropagatedHit) {
      dominoDepth = cursor.lastOperatedDominoDepth >= 0 ? cursor.lastOperatedDominoDepth + 1 : 1;
    } else {
      dominoDepth = 0;
    }

    const status = isDelayed ? 'delayed' : 'on_time';

    const causalExplanation = buildFlightCausalExplanation({
      flight: leg,
      status,
      impactCategory,
      precedingFlightId: chosen.previousFlightId,
      incomingUpstreamDelayMin: chosen.incomingUpstreamDelayMin,
      turnaroundSlackAvailableMin: chosen.turnaroundSlackAvailableMin,
      turnaroundSlackAbsorbedMin: chosen.turnaroundSlackAbsorbedMin,
      residualUpstreamDelayMin: chosen.residualUpstreamDelayMin,
      closureGroundHoldMinutes,
      airborneHoldMinutes,
      reopeningSlotDelayMinutes,
      finalArrivalDelayMin: arrivalDelayMin,
      causes,
      closure,
      minTurnaroundMinutes: config.minTurnaroundMinutes,
    });

    simulatedByFlightId.set(leg.flightId, {
      flightId: leg.flightId,
      assignedTailId: cursor.tailId,
      originalTailId: leg.tailId,
      legOrder: leg.legOrder,
      previousFlightId: chosen.previousFlightId,
      origin: leg.origin,
      destination: leg.destination,
      scheduledDepMin: leg.scheduledDepMin,
      scheduledArrMin: leg.scheduledArrMin,
      actualDepMin,
      actualArrMin,
      departureDelayMin,
      arrivalDelayMin,
      closureGroundHoldMinutes,
      airborneHoldMinutes,
      reopeningSlotDelayMinutes,
      aircraftPositionBefore: posBefore,
      aircraftPositionAfter: leg.destination,
      status,
      impactCategory,
      causes,
      causalExplanation,
      dominoDepth,
      turnaroundSlackAbsorbedMin: chosen.turnaroundSlackAbsorbedMin,
      pax: leg.pax,
      hasCrewViolation: false,
    });

    if (isDelayed) {
      propagationLog.push({
        timeMin: actualDepMin,
        flightId: leg.flightId,
        tailId: cursor.tailId,
        event: causalExplanation.summary,
        dominoDepth,
      });
    }

    // Advance physical aircraft state
    cursor.currentPosition = leg.destination;
    cursor.lastOperatedFlightId = leg.flightId;
    cursor.lastOperatedSchedArrMin = leg.scheduledArrMin;
    cursor.lastOperatedActualArrMin = actualArrMin;
    cursor.lastOperatedDominoDepth = isDelayed ? dominoDepth : -1;
    cursor.nextIdx += 1;
  }

  // Canonical dataset order for deterministic results
  const simulatedFlights: SimulatedFlightState[] = network.flights.map((f) => {
    const state = simulatedByFlightId.get(f.flightId);
    if (!state) {
      throw new Error(`Simulation invariant error: missing state for flight ${f.flightId}`);
    }
    return state;
  });

  // Crew duty compliance analysis (using ACTUAL flight completion times)
  const crews: SimulatedCrewState[] = analyzeCrewDuty(network, simulatedFlights);
  const violatingFlightSet = new Set<string>(crews.flatMap((c) => c.violatingFlightIds));
  for (const sf of simulatedFlights) {
    if (violatingFlightSet.has(sf.flightId)) {
      sf.hasCrewViolation = true;
    }
  }

  // Aircraft rotation summaries & physical continuity invariant guard
  const rotations = buildRotationSummaries(
    network,
    simulatedFlights,
    config.minTurnaroundMinutes
  );
  const consistency = verifyPhysicalConsistency(rotations);
  if (!consistency.isConsistent) {
    throw new Error(
      `Simulation physical continuity violation: ${consistency.errors.join(' ')}`
    );
  }

  // Passenger connection & non-double-counted impact analysis
  const { connections, summary: passengerImpact } = analyzePassengerImpact(
    network,
    simulatedFlights
  );

  // Derive every summary KPI strictly from individual flight, passenger, rotation & crew results
  const operatedFlightsList = simulatedFlights.filter((f) => f.status !== 'cancelled');
  const delayedFlightsList = simulatedFlights.filter((f) => f.status === 'delayed');
  const onTimeFlights = simulatedFlights.filter((f) => f.status === 'on_time').length;
  const cancelledFlights = simulatedFlights.filter((f) => f.status === 'cancelled').length;

  const totalDelayMinutes = operatedFlightsList.reduce(
    (sum, f) => sum + f.arrivalDelayMin,
    0
  );
  const averageDelayMinutes =
    delayedFlightsList.length > 0
      ? Math.round((totalDelayMinutes / delayedFlightsList.length) * 10) / 10
      : 0;
  const maxDelayMinutes = operatedFlightsList.reduce(
    (max, f) => (f.arrivalDelayMin > max ? f.arrivalDelayMin : max),
    0
  );
  const affectedAircraftCount = rotations.filter(
    (r) => r.delayedLegCount > 0 || r.cancelledLegCount > 0
  ).length;

  const violatingCrews = crews.filter((c) => c.isViolation);
  const maxCrewOverageMins = violatingCrews.reduce(
    (max, c) => (c.overageMins > max ? c.overageMins : max),
    0
  );

  const kpis: NetworkKpiSnapshot = {
    totalFlights: simulatedFlights.length,
    operatedFlights: operatedFlightsList.length,
    onTimeFlights,
    delayedFlights: delayedFlightsList.length,
    cancelledFlights,
    totalDelayMinutes,
    averageDelayMinutes,
    maxDelayMinutes,
    affectedAircraftCount,
    missedConnectionsCount: passengerImpact.missedConnectionsCount,
    missedConnectionPax: passengerImpact.missedConnectionPax,
    cancelledFlightPax: passengerImpact.cancelledFlightPax,
    cancelledConnectionOverlapPax: passengerImpact.cancelledConnectionOverlapPax,
    totalStrandedPaxEstimate: passengerImpact.totalStrandedPaxEstimate,
    crewViolationsCount: violatingCrews.length,
    maxCrewOverageMins,
  };

  propagationLog.sort((a, b) => {
    if (a.timeMin !== b.timeMin) return a.timeMin - b.timeMin;
    if (a.dominoDepth !== b.dominoDepth) return a.dominoDepth - b.dominoDepth;
    return a.flightId.localeCompare(b.flightId);
  });

  const scenarioId =
    options?.scenarioId ??
    (closure ? `SIM-${closure.id}` : 'SIM-BASELINE-NO-CLOSURE');

  return {
    scenarioId,
    closure,
    config,
    appliedRecoveryActions,
    activeAssumptions: buildActiveAssumptionsList(closure, config),
    flights: simulatedFlights,
    rotations,
    connections,
    passengerImpact,
    crews,
    kpis,
    propagationLog,
  };
}

/**
 * Traces the full backward rotation dependency chain from a target flight back to
 * the root leg on the same aircraft that initiated its disruption.
 */
export function traceCausalChain(
  flights: SimulatedFlightState[],
  flightId: string
): SimulatedFlightState[] {
  const byId = new Map<string, SimulatedFlightState>();
  for (const f of flights) {
    byId.set(f.flightId, f);
  }

  const chain: SimulatedFlightState[] = [];
  let cursor = byId.get(flightId);
  const visited = new Set<string>();

  while (cursor && !visited.has(cursor.flightId)) {
    visited.add(cursor.flightId);
    chain.unshift(cursor);
    if (cursor.impactCategory === 'direct' || !cursor.previousFlightId) {
      break;
    }
    const prev = byId.get(cursor.previousFlightId);
    if (!prev || (prev.status === 'on_time' && cursor.status !== 'cancelled')) {
      break;
    }
    cursor = prev;
  }

  return chain;
}

export const defaultDelayPropagationEngine: DelayPropagationEngine = {
  simulateScenario: (network, closure, config, recoveryActions) =>
    simulateDisruption(network, closure, config, {
      appliedRecoveryActions: recoveryActions,
    }),
  traceCausalChain,
};
