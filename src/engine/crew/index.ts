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
  SimulationConfig,
} from '../../types/index.ts';
import { formatMinutesToClock } from '../time.ts';

export interface CrewDutyAnalyzer {
  analyzeCrewDuty(
    network: NormalizedFlightNetwork,
    simulatedFlights: SimulatedFlightState[],
    config?: SimulationConfig
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
 * Evaluates all 16 official crew rosters against actual simulated flight completion times
 * (including any swapped leg assignments), PLUS explicitly disclosed assumed standby crews
 * whenever a spare aircraft (VT-DS17 / VT-DS18) is deployed in recovery.
 */
export function analyzeCrewDuty(
  network: NormalizedFlightNetwork,
  simulatedFlights: SimulatedFlightState[],
  config?: SimulationConfig
): SimulatedCrewState[] {
  const flightsByAssignedTail = new Map<string, SimulatedFlightState[]>();
  for (const sf of simulatedFlights) {
    const list = flightsByAssignedTail.get(sf.assignedTailId) ?? [];
    list.push(sf);
    flightsByAssignedTail.set(sf.assignedTailId, list);
  }

  for (const list of flightsByAssignedTail.values()) {
    list.sort((a, b) => {
      if (a.scheduledDepMin !== b.scheduledDepMin) {
        return a.scheduledDepMin - b.scheduledDepMin;
      }
      return a.legOrder - b.legOrder;
    });
  }

  const results: SimulatedCrewState[] = network.crews.map((crew) => {
    const assignedFlights = flightsByAssignedTail.get(crew.tailId) ?? [];
    const legCompletions: LegActualCompletion[] = assignedFlights.map((sf) => ({
      flightId: sf.flightId,
      actualArrMin: sf.status === 'cancelled' ? null : sf.actualArrMin,
    }));

    return evaluateCrewDutyCompliance({
      crew,
      legCompletions,
      isAssumedStandbyCrew: false,
    });
  });

  // Evaluate any deployed spare aircraft using the explicit configurable standby-crew modelling assumption
  for (const spare of network.spareAircraft) {
    const spareFlights = flightsByAssignedTail.get(spare.tailId);
    if (!spareFlights || spareFlights.length === 0) continue;

    const operatedSpareFlights = spareFlights.filter(
      (sf) => sf.status !== 'cancelled' && sf.actualDepMin !== null && sf.actualArrMin !== null
    );
    const firstDepMin =
      operatedSpareFlights.length > 0
        ? operatedSpareFlights[0].actualDepMin!
        : spareFlights[0].scheduledDepMin;
    const briefingMins = config?.assumedStandbyCrew.preDepartureBriefingMins ?? 45;
    const maxDutyMins = config?.assumedStandbyCrew.maxDutyMins ?? 600;
    const dutyStartMin = Math.max(0, firstDepMin - briefingMins);
    const lastSchedArrMin = spareFlights[spareFlights.length - 1].scheduledArrMin;
    const scheduledDutyMins = Math.max(0, lastSchedArrMin - dutyStartMin);

    const syntheticCrew: CrewRecord = {
      crewId: `ASSUMED-STBY-${spare.tailId}`,
      tailId: spare.tailId,
      baseAirportId: spare.baseAirportId,
      dutyStartStr: formatMinutesToClock(dutyStartMin),
      dutyStartMin,
      maxDutyMins,
      flightIds: spareFlights.map((sf) => sf.flightId),
      scheduledDutyMins,
      scheduledDutyMarginMins: maxDutyMins - scheduledDutyMins,
    };

    results.push(
      evaluateCrewDutyCompliance({
        crew: syntheticCrew,
        legCompletions: spareFlights.map((sf) => ({
          flightId: sf.flightId,
          actualArrMin: sf.status === 'cancelled' ? null : sf.actualArrMin,
        })),
        isAssumedStandbyCrew: true,
        assumptionDisclosure: `MODELLING ASSUMPTION (not in official JSON): Assumes standby crew at ${spare.baseAirportId} reporting ${briefingMins}m prior (${formatMinutesToClock(dutyStartMin)}) with ${maxDutyMins}m max duty.`,
      })
    );
  }

  return results;
}
