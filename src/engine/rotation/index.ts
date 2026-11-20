/**
 * Module 4: Aircraft Rotation Tracking & Physical Continuity
 *
 * Guarantees that aircraft NEVER teleport across cancelled flights, tracks physical
 * tail locations before and after every leg, and validates downstream rotation impact
 * whenever any flight is cancelled (whether by recovery action or strict crew policy).
 */

import type {
  AircraftRotationLegState,
  AircraftRotationSummary,
  NormalizedFlightNetwork,
  ScheduledFlight,
  SimulatedFlightState,
} from '../../types/index.ts';

export interface CancellationContinuityCheck {
  tailId: string;
  isPhysicallyConsistent: boolean;
  /** Physical airport where the aircraft finishes after applying the cancellation set */
  finalAircraftPosition: string;
  /** Downstream flights that become physically unreachable because the aircraft is stranded */
  strandedDownstreamFlightIds: string[];
  errors: string[];
}

export interface AircraftRotationTracker {
  buildRotationSummaries(
    network: NormalizedFlightNetwork,
    simulatedFlights: SimulatedFlightState[]
  ): AircraftRotationSummary[];

  verifyPhysicalConsistency(rotations: AircraftRotationSummary[]): {
    isConsistent: boolean;
    errors: string[];
  };
}

/**
 * Validates whether cancelling a specific subset of flights on a given tail preserves
 * physical aircraft location continuity for all remaining operated flights on that tail.
 */
export function validateTailCancellationContinuity(
  tailId: string,
  orderedTailLegs: ScheduledFlight[],
  cancelledFlightIds: ReadonlySet<string>
): CancellationContinuityCheck {
  if (orderedTailLegs.length === 0) {
    return {
      tailId,
      isPhysicallyConsistent: true,
      finalAircraftPosition: '',
      strandedDownstreamFlightIds: [],
      errors: [],
    };
  }

  let currentPosition = orderedTailLegs[0].origin;
  const strandedDownstreamFlightIds: string[] = [];
  const errors: string[] = [];

  for (const leg of orderedTailLegs) {
    if (cancelledFlightIds.has(leg.flightId)) {
      continue;
    }

    if (leg.origin !== currentPosition) {
      strandedDownstreamFlightIds.push(leg.flightId);
      errors.push(
        `Aircraft ${tailId} is physically at ${currentPosition} and cannot operate ${leg.flightId} departing from ${leg.origin}.`
      );
    } else {
      currentPosition = leg.destination;
    }
  }

  return {
    tailId,
    isPhysicallyConsistent: errors.length === 0,
    finalAircraftPosition: currentPosition,
    strandedDownstreamFlightIds,
    errors,
  };
}

/**
 * Constructs per-aircraft rotation summaries from simulated flights and verifies
 * physical aircraft location continuity and minimum turnaround invariants across
 * every active and used spare aircraft.
 */
export function buildRotationSummaries(
  network: NormalizedFlightNetwork,
  simulatedFlights: SimulatedFlightState[],
  minTurnaroundMinutes: number = network.meta.minTurnaroundMinutes
): AircraftRotationSummary[] {
  const flightsByAssignedTail = new Map<string, SimulatedFlightState[]>();

  for (const active of network.activeAircraft) {
    flightsByAssignedTail.set(active.tailId, []);
  }

  for (const sf of simulatedFlights) {
    const list = flightsByAssignedTail.get(sf.assignedTailId) ?? [];
    list.push(sf);
    flightsByAssignedTail.set(sf.assignedTailId, list);
  }

  const summaries: AircraftRotationSummary[] = [];

  for (const [tailId, tailFlights] of [...flightsByAssignedTail.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    const ordered = [...tailFlights].sort((a, b) => {
      if (a.legOrder !== b.legOrder) return a.legOrder - b.legOrder;
      return a.scheduledDepMin - b.scheduledDepMin;
    });

    const spareMeta = network.index.spareAircraftById[tailId];
    const isSpare = Boolean(spareMeta);
    const activeMeta = network.activeAircraft.find((a) => a.tailId === tailId);
    const startingAirportId =
      spareMeta?.baseAirportId ??
      activeMeta?.baseAirportId ??
      ordered[0]?.origin ??
      '';

    let currentPosition = startingAirportId;
    let lastOperatedArrMin: number | null = null;
    let totalDelayMin = 0;
    let delayedLegCount = 0;
    let cancelledLegCount = 0;
    const consistencyErrors: string[] = [];
    const legs: AircraftRotationLegState[] = [];

    for (const sf of ordered) {
      const posBefore = currentPosition;

      if (sf.status === 'cancelled') {
        cancelledLegCount += 1;
        legs.push({
          flightId: sf.flightId,
          legOrder: sf.legOrder,
          origin: sf.origin,
          destination: sf.destination,
          status: sf.status,
          actualDepMin: null,
          actualArrMin: null,
          requiredTurnaroundMin: lastOperatedArrMin === null ? 0 : minTurnaroundMinutes,
          actualTurnaroundMin: null,
          aircraftPositionBeforeLeg: posBefore,
          aircraftPositionAfterLeg: currentPosition,
        });
        continue;
      }

      if (sf.origin !== currentPosition) {
        consistencyErrors.push(
          `Physical discontinuity on ${tailId}: aircraft at ${currentPosition} cannot depart ${sf.flightId} from ${sf.origin}.`
        );
      }

      let actualTurnaroundMin: number | null = null;
      if (lastOperatedArrMin !== null && sf.actualDepMin !== null) {
        actualTurnaroundMin = sf.actualDepMin - lastOperatedArrMin;
        if (actualTurnaroundMin < minTurnaroundMinutes) {
          consistencyErrors.push(
            `Turnaround violation on ${tailId} before ${sf.flightId}: ${actualTurnaroundMin}m < ${minTurnaroundMinutes}m.`
          );
        }
      }

      if (sf.status === 'delayed') {
        delayedLegCount += 1;
      }
      totalDelayMin += sf.arrivalDelayMin;

      currentPosition = sf.destination;
      lastOperatedArrMin = sf.actualArrMin;

      legs.push({
        flightId: sf.flightId,
        legOrder: sf.legOrder,
        origin: sf.origin,
        destination: sf.destination,
        status: sf.status,
        actualDepMin: sf.actualDepMin,
        actualArrMin: sf.actualArrMin,
        requiredTurnaroundMin: actualTurnaroundMin === null ? 0 : minTurnaroundMinutes,
        actualTurnaroundMin,
        aircraftPositionBeforeLeg: posBefore,
        aircraftPositionAfterLeg: currentPosition,
      });
    }

    summaries.push({
      tailId,
      isSpare,
      startingAirportId,
      endingAirportId: currentPosition,
      legs,
      totalDelayMin,
      delayedLegCount,
      cancelledLegCount,
      isPhysicallyConsistent: consistencyErrors.length === 0,
      consistencyErrors,
    });
  }

  return summaries;
}

export function verifyPhysicalConsistency(rotations: AircraftRotationSummary[]): {
  isConsistent: boolean;
  errors: string[];
} {
  const errors = rotations.flatMap((r) => r.consistencyErrors);
  return {
    isConsistent: errors.length === 0,
    errors,
  };
}
