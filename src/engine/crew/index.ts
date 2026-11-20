/**
 * Module 6: Crew Duty-Time Compliance Analyzer
 *
 * Evaluates each crew roster using ACTUAL flight completion times
 * (actualArrMin of the crew's last operated leg minus dutyStartMin) against maxDutyMins.
 *
 * Governance:
 * - Default policy is 'flag_violation': violations are flagged clearly without auto-cancelling.
 * - Strict enforcement ('cancel_violating_legs') is an explicit configurable opt-in and
 *   any cancelled leg must pass physical aircraft-position and downstream rotation validation.
 * - Any standby crew synthesized for a spare aircraft MUST set isAssumedStandbyCrew = true
 *   with an explicit assumptionDisclosure string.
 */

import type {
  CrewRecord,
  NormalizedFlightNetwork,
  SimulatedCrewState,
  SimulatedFlightState,
} from '../../types/index.ts';

export interface CrewDutyAnalyzer {
  analyzeCrewDuty(
    network: NormalizedFlightNetwork,
    simulatedFlights: SimulatedFlightState[]
  ): SimulatedCrewState[];
}

export interface LegActualCompletion {
  flightId: string;
  actualArrMin: number | null;
}

/**
 * Pure evaluator for a single crew roster using ACTUAL flight arrival times.
 */
export function evaluateCrewDutyCompliance(params: {
  crew: CrewRecord;
  legCompletions: LegActualCompletion[];
  isAssumedStandbyCrew?: boolean;
  assumptionDisclosure?: string;
}): SimulatedCrewState {
  const {
    crew,
    legCompletions,
    isAssumedStandbyCrew = false,
    assumptionDisclosure,
  } = params;

  const dutyDeadlineMin = crew.dutyStartMin + crew.maxDutyMins;
  const operatedFlightIds: string[] = [];
  const cancelledFlightIds: string[] = [];
  const violatingFlightIds: string[] = [];

  let actualEndMin = crew.dutyStartMin;

  for (const leg of legCompletions) {
    if (leg.actualArrMin === null) {
      cancelledFlightIds.push(leg.flightId);
      continue;
    }
    operatedFlightIds.push(leg.flightId);
    if (leg.actualArrMin > actualEndMin) {
      actualEndMin = leg.actualArrMin;
    }
    if (leg.actualArrMin > dutyDeadlineMin) {
      violatingFlightIds.push(leg.flightId);
    }
  }

  const actualDutyMins = Math.max(0, actualEndMin - crew.dutyStartMin);
  const overageMins = Math.max(0, actualDutyMins - crew.maxDutyMins);
  const scheduledEndMin = crew.dutyStartMin + crew.scheduledDutyMins;

  return {
    crewId: crew.crewId,
    tailId: crew.tailId,
    baseAirportId: crew.baseAirportId,
    isAssumedStandbyCrew,
    assumptionDisclosure: isAssumedStandbyCrew
      ? assumptionDisclosure ??
        'Modelling assumption: Official dataset has no standby crew records; assumed standby crew at spare base.'
      : undefined,
    dutyStartMin: crew.dutyStartMin,
    maxDutyMins: crew.maxDutyMins,
    scheduledEndMin,
    actualEndMin,
    scheduledDutyMins: crew.scheduledDutyMins,
    actualDutyMins,
    overageMins,
    isViolation: overageMins > 0,
    violatingFlightIds,
    operatedFlightIds,
    cancelledFlightIds,
  };
}

/**
 * Evaluates all 16 official crew rosters against actual simulated flight completion times.
 */
export function analyzeCrewDuty(
  network: NormalizedFlightNetwork,
  simulatedFlights: SimulatedFlightState[]
): SimulatedCrewState[] {
  const flightMap = new Map<string, SimulatedFlightState>();
  for (const sf of simulatedFlights) {
    flightMap.set(sf.flightId, sf);
  }

  return network.crews.map((crew) => {
    // Only evaluate legs still operated by this crew's assigned tail (supports future spare/swap reassignments)
    const legCompletions: LegActualCompletion[] = crew.flightIds
      .map((flightId) => {
        const sf = flightMap.get(flightId);
        if (!sf) {
          return { flightId, actualArrMin: null };
        }
        // If flight was reassigned away from this crew's tail, crew no longer flies it
        if (sf.assignedTailId !== crew.tailId) {
          return null;
        }
        return {
          flightId,
          actualArrMin: sf.status === 'cancelled' ? null : sf.actualArrMin,
        };
      })
      .filter((item): item is LegActualCompletion => item !== null);

    return evaluateCrewDutyCompliance({
      crew,
      legCompletions,
      isAssumedStandbyCrew: false,
    });
  });
}
