/**
 * Module 2: Airport Closure Events & Timeline Evaluation
 *
 * Evaluates closures strictly against ACTUAL departure and arrival timelines:
 * - No arrival or departure movement may occur inside [startMin, endMin).
 * - Flights not yet departed may be ground-held at origin (GDP).
 * - Flights already airborne (actualDepMin < startMin) with arrival inside [startMin, endMin)
 *   are handled as airborne disruptions (airborne arrival holding until >= endMin).
 * - Flights that can legally operate completely outside [startMin, endMin) receive ZERO
 *   arbitrary closure delay.
 * - Reopening capacity metering applies a deterministic queue-ordering policy and slot spacing.
 */

import type {
  AirportClosureEvent,
  NormalizedFlightNetwork,
  ReopeningQueueOrderingPolicy,
  SimulationConfig,
} from '../../types/index.ts';

export const DEFAULT_SIMULATION_CONFIG: SimulationConfig = {
  minTurnaroundMinutes: 30,
  enforceReopeningCapacityMetering: true,
  reopeningQueueOrdering: 'earliest_ready_then_scheduled_then_flight_id',
  autoCancelDelayThresholdMin: null,
  crewViolationPolicy: 'flag_violation',
  assumedStandbyCrew: {
    enabled: true,
    preDepartureBriefingMins: 45,
    maxDutyMins: 600,
  },
};

export type ClosureImpactKind =
  | 'unaffected'
  | 'origin_ground_hold'
  | 'destination_ground_hold'
  | 'airborne_arrival_holding'
  | 'origin_and_destination_ground_hold';

export interface ClosureTimelineEvaluation {
  impactKind: ClosureImpactKind;
  isOriginAffected: boolean;
  isDestinationAffected: boolean;
  isAlreadyAirborne: boolean;
  /** Earliest departure minute satisfying closure constraints (no movement in [startMin, endMin)) */
  adjustedDepMin: number;
  /** Earliest arrival minute satisfying closure constraints (no movement in [startMin, endMin)) */
  adjustedArrMin: number;
  groundHoldMinutes: number;
  airborneHoldMinutes: number;
}

export interface ReopeningQueueItem {
  flightId: string;
  movementType: 'departure' | 'arrival';
  readyTimeMin: number;
  scheduledTimeMin: number;
}

export interface ReopeningSlotAssignment {
  flightId: string;
  movementType: 'departure' | 'arrival';
  readyTimeMin: number;
  assignedSlotMin: number;
  congestionDelayMin: number;
}

export interface AirportClosureEngine {
  createClosureEvent(
    network: NormalizedFlightNetwork,
    airportId: string,
    startMin: number,
    durationMinutes: number,
    reason?: string
  ): AirportClosureEvent;
}

export function isTimeInsideClosure(timeMin: number, closure: AirportClosureEvent): boolean {
  return timeMin >= closure.startMin && timeMin < closure.endMin;
}

export function createAirportClosureEvent(
  network: NormalizedFlightNetwork,
  airportId: string,
  startMin: number,
  durationMinutes: number,
  reason?: string
): AirportClosureEvent {
  if (!network.index.airportsById[airportId]) {
    throw new Error(`Cannot create closure for unknown airport "${airportId}"`);
  }
  if (!Number.isFinite(startMin) || startMin < 0) {
    throw new Error(`Invalid closure startMin: ${String(startMin)}`);
  }
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    throw new Error(`Invalid closure durationMinutes: ${String(durationMinutes)}`);
  }
  const normalizedStart = Math.round(startMin);
  const normalizedDuration = Math.round(durationMinutes);
  return {
    id: `CLOSURE-${airportId}-${normalizedStart}-${normalizedDuration}`,
    airportId,
    startMin: normalizedStart,
    endMin: normalizedStart + normalizedDuration,
    durationMinutes: normalizedDuration,
    reason,
  };
}

/**
 * Evaluates a single flight's ACTUAL ready departure and estimated arrival timeline
 * against an airport closure window [startMin, endMin).
 *
 * Guarantees:
 * 1. No departure or arrival occurs inside [startMin, endMin) at closure.airportId.
 * 2. Flights already airborne before closure.startMin keep actualDep unchanged and incur airborne holding.
 * 3. Flights that can legally operate outside [startMin, endMin) incur 0 closure delay.
 */
export function evaluateFlightAgainstClosure(params: {
  origin: string;
  destination: string;
  readyDepMin: number;
  blockMinutes: number;
  closure: AirportClosureEvent | null;
}): ClosureTimelineEvaluation {
  const { origin, destination, readyDepMin, blockMinutes, closure } = params;
  const estArrMin = readyDepMin + blockMinutes;

  if (!closure || (origin !== closure.airportId && destination !== closure.airportId)) {
    return {
      impactKind: 'unaffected',
      isOriginAffected: false,
      isDestinationAffected: false,
      isAlreadyAirborne: false,
      adjustedDepMin: readyDepMin,
      adjustedArrMin: estArrMin,
      groundHoldMinutes: 0,
      airborneHoldMinutes: 0,
    };
  }

  let depMin = readyDepMin;
  let arrMin = estArrMin;
  let isOriginAffected = false;
  let isDestinationAffected = false;
  let isAlreadyAirborne = false;
  let airborneHoldMinutes = 0;

  // 1. Origin departure check against actual ready timeline
  if (origin === closure.airportId && isTimeInsideClosure(depMin, closure)) {
    isOriginAffected = true;
    depMin = closure.endMin;
    arrMin = depMin + blockMinutes;
  }

  // 2. Destination arrival check against actual estimated arrival timeline
  if (destination === closure.airportId && isTimeInsideClosure(arrMin, closure)) {
    isDestinationAffected = true;
    if (depMin < closure.startMin) {
      // Flight has already departed before closure begins -> airborne arrival disruption
      isAlreadyAirborne = true;
      airborneHoldMinutes = closure.endMin - arrMin;
      arrMin = closure.endMin;
    } else {
      // Flight has not departed yet -> hold at origin (Ground Delay Program) so arrival >= endMin
      const requiredDepForLegalArrival = closure.endMin - blockMinutes;
      depMin = Math.max(depMin, requiredDepForLegalArrival);
      arrMin = depMin + blockMinutes;
    }
  }

  const groundHoldMinutes = depMin - readyDepMin;

  let impactKind: ClosureImpactKind = 'unaffected';
  if (isOriginAffected && isDestinationAffected) {
    impactKind = 'origin_and_destination_ground_hold';
  } else if (isOriginAffected) {
    impactKind = 'origin_ground_hold';
  } else if (isDestinationAffected) {
    impactKind = isAlreadyAirborne ? 'airborne_arrival_holding' : 'destination_ground_hold';
  }

  return {
    impactKind,
    isOriginAffected,
    isDestinationAffected,
    isAlreadyAirborne,
    adjustedDepMin: depMin,
    adjustedArrMin: arrMin,
    groundHoldMinutes,
    airborneHoldMinutes,
  };
}

/**
 * Deterministic reopening slot allocator enforcing airport.capacityPerHour.
 *
 * Queue ordering policy:
 * - 'earliest_ready_then_scheduled_then_flight_id' (default):
 *   Orders by readyTimeMin ASC, then scheduledTimeMin ASC, then flightId ASC.
 * - 'scheduled_time_then_flight_id':
 *   Orders by scheduledTimeMin ASC, then flightId ASC.
 *
 * Slot allocation uses a sliding 60-minute rolling capacity window starting at closure.endMin
 * so that:
 * - No movement is ever assigned earlier than its own readyTimeMin or closure.endMin.
 * - At most `capacityPerHour` movements occur in any 60-minute window [t, t + 60).
 * - Movements arriving well after the backlog clears incur ZERO arbitrary delay.
 */
export function allocateReopeningCapacitySlots(
  items: ReopeningQueueItem[],
  reopenMin: number,
  capacityPerHour: number,
  ordering: ReopeningQueueOrderingPolicy = 'earliest_ready_then_scheduled_then_flight_id'
): ReopeningSlotAssignment[] {
  if (capacityPerHour <= 0) {
    throw new Error(`Invalid airport capacityPerHour: ${String(capacityPerHour)}`);
  }

  const sorted = [...items].sort((a, b) => {
    if (ordering === 'earliest_ready_then_scheduled_then_flight_id') {
      if (a.readyTimeMin !== b.readyTimeMin) return a.readyTimeMin - b.readyTimeMin;
      if (a.scheduledTimeMin !== b.scheduledTimeMin) return a.scheduledTimeMin - b.scheduledTimeMin;
      return a.flightId.localeCompare(b.flightId);
    }
    if (a.scheduledTimeMin !== b.scheduledTimeMin) return a.scheduledTimeMin - b.scheduledTimeMin;
    if (a.readyTimeMin !== b.readyTimeMin) return a.readyTimeMin - b.readyTimeMin;
    return a.flightId.localeCompare(b.flightId);
  });

  const assignedTimes: number[] = [];
  const results: ReopeningSlotAssignment[] = [];

  for (const item of sorted) {
    const earliestCandidate = Math.max(item.readyTimeMin, reopenMin);
    let slotMin = earliestCandidate;

    // Enforce rolling 60-minute window capacity: at most `capacityPerHour` movements in (slotMin - 60, slotMin]
    if (assignedTimes.length >= capacityPerHour) {
      const blockingMovementTime = assignedTimes[assignedTimes.length - capacityPerHour];
      const nextWindowOpen = blockingMovementTime + 60;
      if (slotMin < nextWindowOpen) {
        slotMin = nextWindowOpen;
      }
    }

    // Keep minimum inter-movement runway separation consistent when backlog exists
    if (assignedTimes.length > 0) {
      const prevTime = assignedTimes[assignedTimes.length - 1];
      const minSpacing = Math.floor(60 / capacityPerHour);
      // Only space when competing within the reopening backlog window
      if (item.readyTimeMin <= prevTime + minSpacing && slotMin < prevTime + minSpacing) {
        slotMin = prevTime + minSpacing;
      }
    }

    assignedTimes.push(slotMin);
    results.push({
      flightId: item.flightId,
      movementType: item.movementType,
      readyTimeMin: item.readyTimeMin,
      assignedSlotMin: slotMin,
      congestionDelayMin: Math.max(0, slotMin - item.readyTimeMin),
    });
  }

  return results;
}
