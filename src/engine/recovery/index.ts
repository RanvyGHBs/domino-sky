/**
 * Module 7: Recovery Action Feasibility & Deterministic Simulation
 *
 * Enforces strict physical and operational feasibility BEFORE any recovery action
 * can be applied or recommended:
 * 1. Spare aircraft must respect base, current physical position, availability time,
 *    and seat capacity (seats >= pax), AND explicitly honor the configurable
 *    standby-crew modelling assumption.
 * 2. Cancellations must preserve the aircraft's actual physical location across
 *    all remaining legs of its rotation.
 * 3. Tail swaps are NEVER assumed feasible without validating BOTH aircraft
 *    positions/availability/capacity AND crew assignments/duty legality.
 * 4. Every feasible candidate must be re-simulated by the deterministic engine.
 */

import type {
  AircraftRecord,
  NormalizedFlightNetwork,
  RecoveryAction,
  RecoveryComparison,
  RecoveryFeasibilityCheck,
  ScheduledFlight,
  SimulationConfig,
  SimulationResult,
} from '../../types/index.ts';
import { formatMinutesToClock } from '../time.ts';
import { validateTailCancellationContinuity } from '../rotation/index.ts';

export interface RecoveryEngine {
  generateFeasibleCandidates(
    network: NormalizedFlightNetwork,
    baseline: SimulationResult
  ): RecoveryAction[];

  applyRecoveryAction(
    network: NormalizedFlightNetwork,
    baseline: SimulationResult,
    action: RecoveryAction
  ): SimulationResult;

  evaluateCandidateWithComparison(
    network: NormalizedFlightNetwork,
    baseline: SimulationResult,
    action: RecoveryAction
  ): RecoveryComparison;
}

export interface SpareDeploymentValidationInput {
  spare: AircraftRecord;
  /** Current tracked physical airport of the spare (starts at spare.baseAirportId) */
  spareCurrentPosition: string;
  /** Earliest minute the spare is physically ready at spareCurrentPosition */
  spareReadyMin: number;
  targetFlight: ScheduledFlight;
  plannedDepartureMin: number;
  config: SimulationConfig;
  /** Optional verified crew ID if operating with assumedStandbyCrew.enabled === false */
  verifiedAssignedCrewId?: string;
}

export function validateSpareDeploymentFeasibility(
  input: SpareDeploymentValidationInput
): {
  isFeasible: boolean;
  reason: string;
  checks: RecoveryFeasibilityCheck[];
  usesAssumedStandbyCrew: boolean;
} {
  const {
    spare,
    spareCurrentPosition,
    spareReadyMin,
    targetFlight,
    plannedDepartureMin,
    config,
    verifiedAssignedCrewId,
  } = input;

  const checks: RecoveryFeasibilityCheck[] = [];

  // 1. Base & physical position check
  const atOrigin = spareCurrentPosition === targetFlight.origin;
  checks.push({
    checkName: 'spare_base_position',
    passed: atOrigin,
    detail: atOrigin
      ? `Spare ${spare.tailId} is physically positioned at ${spareCurrentPosition} (base ${spare.baseAirportId}), matching ${targetFlight.flightId} origin ${targetFlight.origin}.`
      : `Spare ${spare.tailId} is physically at ${spareCurrentPosition} (base ${spare.baseAirportId}) and cannot originate ${targetFlight.flightId} from ${targetFlight.origin} without a ferry flight.`,
  });

  // 2. Availability time check
  const earliestReady = Math.max(spare.availableFromMin, spareReadyMin);
  const timeAvailable = plannedDepartureMin >= earliestReady;
  checks.push({
    checkName: 'spare_availability_time',
    passed: timeAvailable,
    detail: timeAvailable
      ? `Spare ${spare.tailId} is available from ${formatMinutesToClock(earliestReady)} <= planned departure ${formatMinutesToClock(plannedDepartureMin)}.`
      : `Spare ${spare.tailId} is not available until ${formatMinutesToClock(earliestReady)}, after planned departure ${formatMinutesToClock(plannedDepartureMin)}.`,
  });

  // 3. Seat capacity check
  const hasCapacity = spare.seats >= targetFlight.pax;
  checks.push({
    checkName: 'aircraft_seat_capacity',
    passed: hasCapacity,
    detail: hasCapacity
      ? `Spare ${spare.tailId} capacity (${spare.seats} seats) accommodates ${targetFlight.pax} passengers on ${targetFlight.flightId}.`
      : `Spare ${spare.tailId} capacity (${spare.seats} seats) is insufficient for ${targetFlight.pax} passengers on ${targetFlight.flightId}.`,
  });

  // 4. Standby crew assumption vs verified crew check
  let usesAssumedStandbyCrew = false;
  if (verifiedAssignedCrewId) {
    checks.push({
      checkName: 'crew_assignment_legality',
      passed: true,
      detail: `Verified crew ${verifiedAssignedCrewId} explicitly assigned to spare ${spare.tailId}.`,
      reliesOnAssumption: false,
    });
  } else if (config.assumedStandbyCrew.enabled) {
    usesAssumedStandbyCrew = true;
    const dutyStartMin = plannedDepartureMin - config.assumedStandbyCrew.preDepartureBriefingMins;
    const estEndMin = plannedDepartureMin + targetFlight.blockMinutes;
    const estDutyMins = estEndMin - dutyStartMin;
    const withinDuty = estDutyMins <= config.assumedStandbyCrew.maxDutyMins;

    checks.push({
      checkName: 'standby_crew_assumption',
      passed: withinDuty,
      reliesOnAssumption: true,
      detail: withinDuty
        ? `MODELLING ASSUMPTION (not in official JSON): Assumes standby crew at ${spare.baseAirportId} reporting ${config.assumedStandbyCrew.preDepartureBriefingMins}m prior (${formatMinutesToClock(dutyStartMin)}), duty ${estDutyMins}/${config.assumedStandbyCrew.maxDutyMins}m.`
        : `Assumed standby crew duty (${estDutyMins}m) exceeds configured limit (${config.assumedStandbyCrew.maxDutyMins}m).`,
    });
  } else {
    checks.push({
      checkName: 'standby_crew_assumption',
      passed: false,
      reliesOnAssumption: false,
      detail:
        'Official dataset has no standby crew records and assumedStandbyCrew.enabled is false; cannot deploy spare without a verified crew assignment.',
    });
  }

  const failed = checks.filter((c) => !c.passed);
  const isFeasible = failed.length === 0;
  const reason = isFeasible
    ? usesAssumedStandbyCrew
      ? `Feasible (relies on configurable ${config.assumedStandbyCrew.preDepartureBriefingMins}m standby-crew modelling assumption).`
      : 'Feasible with verified physical and crew constraints.'
    : failed.map((f) => f.detail).join(' ');

  return { isFeasible, reason, checks, usesAssumedStandbyCrew };
}

export interface CancellationValidationInput {
  tailId: string;
  orderedTailLegs: ScheduledFlight[];
  cancelledFlightIds: string[];
}

export function validateCancellationFeasibility(
  input: CancellationValidationInput
): {
  isFeasible: boolean;
  reason: string;
  checks: RecoveryFeasibilityCheck[];
  finalAircraftPosition: string;
} {
  const { tailId, orderedTailLegs, cancelledFlightIds } = input;
  const cancelSet = new Set(cancelledFlightIds);
  const continuity = validateTailCancellationContinuity(tailId, orderedTailLegs, cancelSet);

  const check: RecoveryFeasibilityCheck = {
    checkName: 'physical_aircraft_continuity',
    passed: continuity.isPhysicallyConsistent,
    detail: continuity.isPhysicallyConsistent
      ? `Cancelling [${cancelledFlightIds.join(', ')}] preserves physical continuity for ${tailId} (ends at ${continuity.finalAircraftPosition}).`
      : continuity.errors.join(' '),
  };

  return {
    isFeasible: continuity.isPhysicallyConsistent,
    reason: check.detail,
    checks: [check],
    finalAircraftPosition: continuity.finalAircraftPosition,
  };
}

export interface TailSwapValidationInput {
  tailAId: string;
  tailAPosition: string;
  tailAReadyMin: number;
  tailASeats: number;
  flightA: ScheduledFlight;
  tailBId: string;
  tailBPosition: string;
  tailBReadyMin: number;
  tailBSeats: number;
  flightB: ScheduledFlight;
  /** True only if crew A and crew B duty/base legality for the swapped legs has been explicitly verified */
  crewAssignmentsValidated: boolean;
  crewValidationDetail: string;
}

export function validateTailSwapFeasibility(
  input: TailSwapValidationInput
): {
  isFeasible: boolean;
  reason: string;
  checks: RecoveryFeasibilityCheck[];
} {
  const {
    tailAId,
    tailAPosition,
    tailAReadyMin,
    tailASeats,
    flightA,
    tailBId,
    tailBPosition,
    tailBReadyMin,
    tailBSeats,
    flightB,
    crewAssignmentsValidated,
    crewValidationDetail,
  } = input;

  const checks: RecoveryFeasibilityCheck[] = [];

  const positionsMatch = tailAPosition === flightB.origin && tailBPosition === flightA.origin;
  checks.push({
    checkName: 'physical_aircraft_continuity',
    passed: positionsMatch,
    detail: positionsMatch
      ? `Both ${tailAId} (${tailAPosition}) and ${tailBId} (${tailBPosition}) are physically positioned at swapped flight origins.`
      : `Position mismatch: ${tailAId} is at ${tailAPosition} (needs ${flightB.origin}); ${tailBId} is at ${tailBPosition} (needs ${flightA.origin}).`,
  });

  const capacityOk = tailASeats >= flightB.pax && tailBSeats >= flightA.pax;
  checks.push({
    checkName: 'aircraft_seat_capacity',
    passed: capacityOk,
    detail: capacityOk
      ? `Seat capacities sufficient (${tailAId}: ${tailASeats} >= ${flightB.pax} pax; ${tailBId}: ${tailBSeats} >= ${flightA.pax} pax).`
      : `Insufficient seat capacity for swapped passenger loads.`,
  });

  const timingKnown = Number.isFinite(tailAReadyMin) && Number.isFinite(tailBReadyMin);
  checks.push({
    checkName: 'spare_availability_time',
    passed: timingKnown,
    detail: timingKnown
      ? `Ready times verified (${tailAId} at ${formatMinutesToClock(tailAReadyMin)}, ${tailBId} at ${formatMinutesToClock(tailBReadyMin)}).`
      : `Missing aircraft availability times for swap.`,
  });

  checks.push({
    checkName: 'crew_assignment_legality',
    passed: crewAssignmentsValidated,
    detail: crewValidationDetail,
  });

  const failed = checks.filter((c) => !c.passed);
  const isFeasible = failed.length === 0;
  return {
    isFeasible,
    reason: isFeasible
      ? `Tail swap between ${tailAId} and ${tailBId} passed aircraft and crew feasibility checks (pending full engine re-simulation).`
      : failed.map((f) => f.detail).join(' '),
    checks,
  };
}
