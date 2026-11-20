/**
 * Module 7: Recovery Action Candidate Generation, Feasibility Validation & Execution
 *
 * Supports all 4 operational recovery action types:
 * 1. deploy_spare_aircraft  — Deploy VT-DS17 (BLR) or VT-DS18 (DEL) on physically reachable legs
 * 2. cancel_flight_chain    — Cancel a round-trip loop or tail suffix while preserving aircraft continuity
 * 3. swap_aircraft_rotations — Swap remaining flight chains between two aircraft physically at the same airport
 * 4. hold_connection_flight — Controlled departure hold to protect a missed passenger connection
 *
 * Every feasible candidate is re-simulated via simulateDisruption so all outcomes are
 * 100% deterministic and derived from the simulation engine.
 */

import type {
  AircraftRecord,
  CandidateGenerationOutput,
  NormalizedFlightNetwork,
  RankedRecoveryOption,
  RecoveryAction,
  RecoveryComparison,
  RecoveryFeasibilityCheck,
  ScheduledFlight,
  SimulatedFlightState,
  SimulationConfig,
  SimulationResult,
} from '../../types/index.ts';
import { formatMinutesToClock } from '../time.ts';
import { isTimeInsideClosure } from '../closure/index.ts';
import { validateTailCancellationContinuity } from '../rotation/index.ts';
import {
  simulateDisruption,
  type CustomTailRotationPlan,
  type SimulationExecutionOptions,
} from '../propagation/index.ts';
import { compareScenarios } from '../comparison/index.ts';
import { rankRecoveryComparisons } from './ranking.ts';

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

// ---------------------------------------------------------------------------
// 1. Individual Feasibility Validators (Unit-Testable & Reused by Generator)
// ---------------------------------------------------------------------------

export interface SpareDeploymentValidationInput {
  spare: AircraftRecord;
  spareCurrentPosition: string;
  spareReadyMin: number;
  targetFlight: ScheduledFlight;
  /** Optional full sequence of legs the spare will fly (defaults to [targetFlight]) */
  assignedLegs?: ScheduledFlight[];
  plannedDepartureMin: number;
  config: SimulationConfig;
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
    assignedLegs = [targetFlight],
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

  // 2. Subsequent leg geographic continuity check
  let legsContinuous = true;
  let continuityDetail = `Assigned sequence [${assignedLegs.map((l) => l.flightId).join(' → ')}] is geographically continuous from ${targetFlight.origin}.`;
  for (let i = 1; i < assignedLegs.length; i++) {
    if (assignedLegs[i].origin !== assignedLegs[i - 1].destination) {
      legsContinuous = false;
      continuityDetail = `Subsequent spare leg discontinuity: ${assignedLegs[i - 1].flightId} ends at ${assignedLegs[i - 1].destination}, cannot start ${assignedLegs[i].flightId} from ${assignedLegs[i].origin}.`;
      break;
    }
  }
  checks.push({
    checkName: 'physical_aircraft_continuity',
    passed: legsContinuous,
    detail: continuityDetail,
  });

  // 3. Availability time check
  const earliestReady = Math.max(spare.availableFromMin, spareReadyMin);
  const timeAvailable = plannedDepartureMin >= earliestReady;
  checks.push({
    checkName: 'spare_availability_time',
    passed: timeAvailable,
    detail: timeAvailable
      ? `Spare ${spare.tailId} is available from ${formatMinutesToClock(earliestReady)} <= planned departure ${formatMinutesToClock(plannedDepartureMin)}.`
      : `Spare ${spare.tailId} is not available until ${formatMinutesToClock(earliestReady)}, after planned departure ${formatMinutesToClock(plannedDepartureMin)}.`,
  });

  // 4. Seat capacity check across ALL assigned legs
  const overloadedLeg = assignedLegs.find((l) => l.pax > spare.seats);
  const hasCapacity = !overloadedLeg;
  checks.push({
    checkName: 'aircraft_seat_capacity',
    passed: hasCapacity,
    detail: hasCapacity
      ? `Spare ${spare.tailId} capacity (${spare.seats} seats) accommodates all ${assignedLegs.length} assigned leg${assignedLegs.length === 1 ? '' : 's'} (max ${Math.max(...assignedLegs.map((l) => l.pax))} pax).`
      : `Spare ${spare.tailId} capacity (${spare.seats} seats) is insufficient for ${overloadedLeg.pax} passengers on ${overloadedLeg.flightId}.`,
  });

  // 5. Standby crew assumption vs verified crew check
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
    const lastLeg = assignedLegs[assignedLegs.length - 1];
    const estEndMin = Math.max(
      plannedDepartureMin + targetFlight.blockMinutes,
      lastLeg.scheduledArrMin
    );
    const estDutyMins = estEndMin - dutyStartMin;
    const withinDuty = estDutyMins <= config.assumedStandbyCrew.maxDutyMins;

    checks.push({
      checkName: 'standby_crew_assumption',
      passed: withinDuty,
      reliesOnAssumption: true,
      detail: withinDuty
        ? `MODELLING ASSUMPTION (not in official JSON): Assumes standby crew at ${spare.baseAirportId} reporting ${config.assumedStandbyCrew.preDepartureBriefingMins}m prior (${formatMinutesToClock(dutyStartMin)}), est. duty ${estDutyMins}/${config.assumedStandbyCrew.maxDutyMins}m.`
        : `Assumed standby crew est. duty (${estDutyMins}m) exceeds configured limit (${config.assumedStandbyCrew.maxDutyMins}m).`,
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
  strandedDownstreamFlightIds: string[];
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
    strandedDownstreamFlightIds: continuity.strandedDownstreamFlightIds,
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
  /** Optional full suffix legs taken by each aircraft for full capacity verification */
  tailANewLegs?: ScheduledFlight[];
  tailBNewLegs?: ScheduledFlight[];
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
    tailANewLegs = [flightB],
    tailBNewLegs = [flightA],
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

  const maxPaxForA = Math.max(...tailANewLegs.map((l) => l.pax));
  const maxPaxForB = Math.max(...tailBNewLegs.map((l) => l.pax));
  const capacityOk = tailASeats >= maxPaxForA && tailBSeats >= maxPaxForB;
  checks.push({
    checkName: 'aircraft_seat_capacity',
    passed: capacityOk,
    detail: capacityOk
      ? `Seat capacities sufficient (${tailAId}: ${tailASeats} >= ${maxPaxForA} pax; ${tailBId}: ${tailBSeats} >= ${maxPaxForB} pax).`
      : `Insufficient seat capacity for swapped passenger loads (${tailAId}: ${tailASeats} vs ${maxPaxForA}; ${tailBId}: ${tailBSeats} vs ${maxPaxForB}).`,
  });

  const timingKnown = Number.isFinite(tailAReadyMin) && Number.isFinite(tailBReadyMin);
  checks.push({
    checkName: 'spare_availability_time',
    passed: timingKnown,
    detail: timingKnown
      ? `Ready times verified (${tailAId} at ${formatMinutesToClock(tailAReadyMin)}, ${tailBId} at ${formatMinutesToClock(tailBReadyMin)}).`
      : 'Missing aircraft availability times for swap.',
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
      ? `Tail swap between ${tailAId} and ${tailBId} passed aircraft, capacity, and crew validation checks.`
      : failed.map((f) => f.detail).join(' '),
    checks,
  };
}

export interface ControlledHoldValidationInput {
  connectionId: string;
  fromFlight: SimulatedFlightState;
  toFlight: SimulatedFlightState;
  minConnectMinutes: number;
  closure: SimulationResult['closure'];
  /** Optional ceiling on hold length (minutes beyond baseline departure) */
  maxHoldMinutes?: number;
}

export function validateControlledHoldFeasibility(
  input: ControlledHoldValidationInput
): {
  isFeasible: boolean;
  reason: string;
  checks: RecoveryFeasibilityCheck[];
  targetDepMin: number;
  additionalHoldMin: number;
} {
  const {
    connectionId,
    fromFlight,
    toFlight,
    minConnectMinutes,
    closure,
    maxHoldMinutes = 120,
  } = input;

  const checks: RecoveryFeasibilityCheck[] = [];

  if (
    fromFlight.status === 'cancelled' ||
    toFlight.status === 'cancelled' ||
    fromFlight.actualArrMin === null ||
    toFlight.actualDepMin === null
  ) {
    const check: RecoveryFeasibilityCheck = {
      checkName: 'physical_aircraft_continuity',
      passed: false,
      detail: `Cannot hold ${toFlight.flightId} for ${connectionId} because either feeder or onward flight is cancelled.`,
    };
    return {
      isFeasible: false,
      reason: check.detail,
      checks: [check],
      targetDepMin: toFlight.scheduledDepMin,
      additionalHoldMin: 0,
    };
  }

  let targetDepMin = fromFlight.actualArrMin + minConnectMinutes;
  // Closure compliance: if targetDepMin lands inside closure at onward origin, push to reopening
  if (closure && toFlight.origin === closure.airportId && isTimeInsideClosure(targetDepMin, closure)) {
    targetDepMin = closure.endMin;
  }

  const additionalHoldMin = Math.max(0, targetDepMin - toFlight.actualDepMin);
  const closureCompliant =
    !closure ||
    toFlight.origin !== closure.airportId ||
    !isTimeInsideClosure(targetDepMin, closure);

  checks.push({
    checkName: 'closure_window_compliance',
    passed: closureCompliant,
    detail: closureCompliant
      ? `Held departure ${formatMinutesToClock(targetDepMin)} for ${toFlight.flightId} complies with airport closure rules.`
      : `Held departure ${formatMinutesToClock(targetDepMin)} falls inside active closure window.`,
  });

  const withinHoldBounds = additionalHoldMin > 0 && additionalHoldMin <= maxHoldMinutes;
  checks.push({
    checkName: 'spare_availability_time',
    passed: withinHoldBounds,
    detail: withinHoldBounds
      ? `Holding ${toFlight.flightId} by +${additionalHoldMin}m (to ${formatMinutesToClock(targetDepMin)}) restores ${minConnectMinutes}m MCT for ${connectionId}.`
      : additionalHoldMin <= 0
        ? `Connection ${connectionId} does not require an additional hold.`
        : `Required hold (+${additionalHoldMin}m) exceeds maximum controlled hold limit (${maxHoldMinutes}m).`,
  });

  const failed = checks.filter((c) => !c.passed);
  const isFeasible = failed.length === 0;
  return {
    isFeasible,
    reason: isFeasible
      ? `Feasible controlled departure hold (+${additionalHoldMin}m on ${toFlight.flightId}) to protect ${connectionId}.`
      : failed.map((f) => f.detail).join(' '),
    checks,
    targetDepMin,
    additionalHoldMin,
  };
}

// ---------------------------------------------------------------------------
// 2. Deterministic Candidate Generator (All 4 Recovery Action Types)
// ---------------------------------------------------------------------------

/**
 * Generates deterministic, deduplicated recovery candidates for a disrupted baseline,
 * rejecting physically or legally infeasible candidates prior to full simulation.
 */
export function generateRecoveryCandidates(
  network: NormalizedFlightNetwork,
  baseline: SimulationResult
): CandidateGenerationOutput {
  const candidates: RecoveryAction[] = [];
  const rejectedCandidates: RecoveryAction[] = [];
  const seenIds = new Set<string>();

  const registerAction = (action: RecoveryAction) => {
    if (seenIds.has(action.actionId)) return;
    seenIds.add(action.actionId);
    if (action.isFeasible) {
      candidates.push(action);
    } else {
      rejectedCandidates.push(action);
    }
  };

  const baselineFlightById = new Map(baseline.flights.map((f) => [f.flightId, f]));
  const delayedFlights = baseline.flights.filter((f) => f.status === 'delayed');
  const violatingCrewTails = new Set(
    baseline.crews.filter((c) => c.isViolation).map((c) => c.tailId)
  );

  // If no disruption exists, return empty candidate set cleanly
  if (delayedFlights.length === 0 && baseline.kpis.crewViolationsCount === 0) {
    return { candidates, rejectedCandidates };
  }

  // -------------------------------------------------------------------------
  // Type 1: Deploy Spare Aircraft (VT-DS17 @ BLR, VT-DS18 @ DEL)
  // -------------------------------------------------------------------------
  // Consider every delayed leg (or crew-violating leg) whose origin matches a spare's base
  // AND where substituting the spare can eliminate inherited upstream delay or crew violation.
  for (const spare of network.spareAircraft) {
    for (const active of network.activeAircraft) {
      const tailLegs = network.index.flightsByTailId[active.tailId];
      for (let targetIdx = 0; targetIdx < tailLegs.length; targetIdx++) {
        const targetLeg = tailLegs[targetIdx];
        if (targetLeg.origin !== spare.baseAirportId) continue;

        const simTarget = baselineFlightById.get(targetLeg.flightId);
        if (!simTarget || simTarget.status === 'cancelled') continue;

        const hasUpstreamDelay = simTarget.causalExplanation.residualUpstreamDelayMin > 0;
        const tailHasCrewBreach = violatingCrewTails.has(active.tailId) && simTarget.status === 'delayed';
        // Spare only improves delay if there is upstream delay from prior legs or crew breach relief
        if (!hasUpstreamDelay && !tailHasCrewBreach) continue;

        const suffixLegs = tailLegs.slice(targetIdx);

        // Effective earliest departure for the spare (respects active closure at spare's base)
        let plannedDep = targetLeg.scheduledDepMin;
        if (
          baseline.closure &&
          targetLeg.origin === baseline.closure.airportId &&
          isTimeInsideClosure(plannedDep, baseline.closure)
        ) {
          plannedDep = baseline.closure.endMin;
        }

        const check = validateSpareDeploymentFeasibility({
          spare,
          spareCurrentPosition: spare.baseAirportId,
          spareReadyMin: spare.availableFromMin,
          targetFlight: targetLeg,
          assignedLegs: suffixLegs,
          plannedDepartureMin: plannedDep,
          config: baseline.config,
        });

        const actionId = `REC-SPARE-${spare.tailId}-${targetLeg.flightId}`;
        registerAction({
          actionId,
          type: 'deploy_spare_aircraft',
          label: `Deploy spare ${spare.tailId} (${spare.baseAirportId}) on ${targetLeg.flightId} chain`,
          description: `Reassign ${suffixLegs.map((l) => l.flightId).join(', ')} (${suffixLegs.length} leg${suffixLegs.length === 1 ? '' : 's'}) from ${active.tailId} to spare ${spare.tailId} stationed at ${spare.baseAirportId}.`,
          generationReason:
            simTarget.causalExplanation.residualUpstreamDelayMin > 0
              ? `${targetLeg.flightId} departs ${spare.baseAirportId} with +${simTarget.causalExplanation.residualUpstreamDelayMin}m inherited rotation delay from ${simTarget.previousFlightId}; ${spare.tailId} is already positioned at ${spare.baseAirportId}.`
              : `${active.tailId} faces crew duty violation; deploying spare ${spare.tailId} from ${spare.baseAirportId} relieves the remaining ${suffixLegs.length} leg(s).`,
          parameters: {
            spareTailId: spare.tailId,
            targetTailId: active.tailId,
            targetFlightId: targetLeg.flightId,
            reassignedFlightIds: suffixLegs.map((l) => l.flightId),
          },
          isFeasible: check.isFeasible,
          feasibilityReason: check.reason,
          feasibilityChecks: check.checks,
          usesAssumedStandbyCrew: check.usesAssumedStandbyCrew,
          isEngineVerified: false,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Type 2: Cancel Flight Chain (Out-and-Back Loops & Crew-Breach Tail Suffixes)
  // -------------------------------------------------------------------------
  for (const active of network.activeAircraft) {
    const tailLegs = network.index.flightsByTailId[active.tailId];
    const simTailLegs = tailLegs.map((l) => baselineFlightById.get(l.flightId)!);
    const hasDelayedLeg = simTailLegs.some((s) => s.status === 'delayed');
    if (!hasDelayedLeg) continue;

    // 2A. Out-and-back loop cancellation starting at any delayed leg that returns to the same airport
    //     before at least one delayed downstream leg (classic airline schedule-reset cancellation).
    for (let startIdx = 0; startIdx < tailLegs.length - 1; startIdx++) {
      if (simTailLegs[startIdx].status !== 'delayed') continue;
      const startLeg = tailLegs[startIdx];
      // Find earliest return leg back to startLeg.origin
      let returnIdx = -1;
      for (let m = startIdx + 1; m < tailLegs.length; m++) {
        if (tailLegs[m].destination === startLeg.origin) {
          returnIdx = m;
          break;
        }
      }
      if (returnIdx === -1 || returnIdx >= tailLegs.length - 1) continue;

      const downstreamSimLegs = simTailLegs.slice(returnIdx + 1);
      if (!downstreamSimLegs.some((s) => s.status === 'delayed')) continue;

      const loopIds = tailLegs.slice(startIdx, returnIdx + 1).map((l) => l.flightId);
      const check = validateCancellationFeasibility({
        tailId: active.tailId,
        orderedTailLegs: tailLegs,
        cancelledFlightIds: loopIds,
      });
      const downstreamIds = tailLegs.slice(returnIdx + 1).map((l) => l.flightId);
      registerAction({
        actionId: `REC-CANCEL-LOOP-${active.tailId}-${loopIds[0]}-${loopIds[loopIds.length - 1]}`,
        type: 'cancel_flight_chain',
        label: `Cancel round-trip ${loopIds.join(' + ')} on ${active.tailId}`,
        description: `Cancel out-and-back loop ${loopIds.join(', ')} so ${active.tailId} remains physically at ${startLeg.origin} and operates ${downstreamIds.join(', ')} on schedule.`,
        generationReason: `${startLeg.flightId} is delayed +${simTailLegs[startIdx].arrivalDelayMin}m and propagates delay down ${active.tailId}; cancelling the closed loop preserves aircraft continuity at ${startLeg.origin} and resets downstream ${downstreamIds.join(', ')}.`,
        parameters: {
          targetTailId: active.tailId,
          targetFlightId: startLeg.flightId,
          cancelledFlightIds: loopIds,
        },
        isFeasible: check.isFeasible,
        feasibilityReason: check.reason,
        feasibilityChecks: check.checks,
        usesAssumedStandbyCrew: false,
        isEngineVerified: false,
      });
    }

    // 2B. Terminal / crew-violating suffix cancellation (specifically resolves crew duty breaches cleanly!)
    const crewState = baseline.crews.find((c) => c.tailId === active.tailId);
    if (crewState && crewState.isViolation && crewState.violatingFlightIds.length > 0) {
      const firstViolatingId = crewState.violatingFlightIds[0];
      const firstViolatingIdx = tailLegs.findIndex((l) => l.flightId === firstViolatingId);
      if (firstViolatingIdx >= 0) {
        const suffixIds = tailLegs.slice(firstViolatingIdx).map((l) => l.flightId);
        const check = validateCancellationFeasibility({
          tailId: active.tailId,
          orderedTailLegs: tailLegs,
          cancelledFlightIds: suffixIds,
        });
        registerAction({
          actionId: `REC-CANCEL-CREW-${active.tailId}-${firstViolatingId}`,
          type: 'cancel_flight_chain',
          label: `Cancel ${suffixIds.join(', ')} to resolve ${crewState.crewId} duty breach`,
          description: `Cancel final leg sequence ${suffixIds.join(', ')} on ${active.tailId} to bring ${crewState.crewId} back within the ${crewState.maxDutyMins}m duty limit (baseline +${crewState.overageMins}m overage).`,
          generationReason: `${crewState.crewId} exceeds legal duty by +${crewState.overageMins}m on ${crewState.violatingFlightIds.join(', ')}; cancelling the suffix eliminates the duty breach without stranding ${active.tailId}.`,
          parameters: {
            targetTailId: active.tailId,
            targetFlightId: firstViolatingId,
            cancelledFlightIds: suffixIds,
          },
          isFeasible: check.isFeasible,
          feasibilityReason: check.reason,
          feasibilityChecks: check.checks,
          usesAssumedStandbyCrew: false,
          isEngineVerified: false,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Type 3: Swap Aircraft Rotations (Two Active Tails Physically at Same Hub)
  // -------------------------------------------------------------------------
  for (const tailA of network.activeAircraft) {
    const legsA = network.index.flightsByTailId[tailA.tailId];
    for (let idxA = 0; idxA < legsA.length; idxA++) {
      const flightA = legsA[idxA];
      const simA = baselineFlightById.get(flightA.flightId)!;
      // Only try swapping into a leg that actually has upstream delay from a late inbound aircraft
      if (simA.status !== 'delayed' || simA.causalExplanation.residualUpstreamDelayMin <= 0) {
        continue;
      }

      const prevSimA = idxA > 0 ? baselineFlightById.get(legsA[idxA - 1].flightId)! : null;
      const tailAReadyMin =
        prevSimA && prevSimA.actualArrMin !== null
          ? prevSimA.actualArrMin + baseline.config.minTurnaroundMinutes
          : flightA.scheduledDepMin;
      const hub = flightA.origin;
      const suffixA = legsA.slice(idxA);
      const crewA = network.index.crewByTailId[tailA.tailId];

      for (const tailB of network.activeAircraft) {
        if (tailB.tailId === tailA.tailId) continue;
        const legsB = network.index.flightsByTailId[tailB.tailId];

        for (let idxB = 0; idxB < legsB.length; idxB++) {
          const flightB = legsB[idxB];
          if (flightB.origin !== hub) continue;
          const simB = baselineFlightById.get(flightB.flightId)!;
          if (simB.status === 'cancelled') continue;

          const prevSimB = idxB > 0 ? baselineFlightById.get(legsB[idxB - 1].flightId)! : null;
          if (prevSimB && prevSimB.status === 'cancelled') continue;

          const tailBReadyMin =
            prevSimB && prevSimB.actualArrMin !== null
              ? prevSimB.actualArrMin + baseline.config.minTurnaroundMinutes
              : 0;

          // Swap is only relevant if tailB is ready earlier at `hub` than tailA, AND tailA arrives
          // early enough to cover flightB without massive impractical delay (within 180m of flightB sched)
          if (tailBReadyMin >= tailAReadyMin) continue;
          if (tailBReadyMin >= (simA.actualDepMin ?? Infinity)) continue;
          if (tailAReadyMin > flightB.scheduledDepMin + 120) continue;

          const suffixB = legsB.slice(idxB);
          const crewB = network.index.crewByTailId[tailB.tailId];

          // Validate crew duty legality for BOTH swapped crews before calling swap feasible!
          const estLastArrA = Math.max(
            suffixB[suffixB.length - 1].scheduledArrMin,
            tailAReadyMin +
              suffixB.reduce(
                (acc, l, i) =>
                  acc + l.blockMinutes + (i > 0 ? baseline.config.minTurnaroundMinutes : 0),
                0
              )
          );
          const estLastArrB = Math.max(
            suffixA[suffixA.length - 1].scheduledArrMin,
            Math.max(flightA.scheduledDepMin, tailBReadyMin) +
              suffixA.reduce(
                (acc, l, i) =>
                  acc + l.blockMinutes + (i > 0 ? baseline.config.minTurnaroundMinutes : 0),
                0
              )
          );

          const estDutyA = estLastArrA - crewA.dutyStartMin;
          const estDutyB = estLastArrB - crewB.dutyStartMin;
          const crewALegal = estDutyA <= crewA.maxDutyMins;
          const crewBLegal = estDutyB <= crewB.maxDutyMins;
          const crewAssignmentsValidated = crewALegal && crewBLegal;
          const crewValidationDetail = crewAssignmentsValidated
            ? `Both crews remain within 600m duty limits: ${crewA.crewId} est. ${estDutyA}/${crewA.maxDutyMins}m, ${crewB.crewId} est. ${estDutyB}/${crewB.maxDutyMins}m.`
            : `Crew duty violation blocks swap: ${crewA.crewId} est. ${estDutyA}/${crewA.maxDutyMins}m, ${crewB.crewId} est. ${estDutyB}/${crewB.maxDutyMins}m.`;

          const check = validateTailSwapFeasibility({
            tailAId: tailA.tailId,
            tailAPosition: hub,
            tailAReadyMin,
            tailASeats: tailA.seats,
            flightA,
            tailBId: tailB.tailId,
            tailBPosition: hub,
            tailBReadyMin,
            tailBSeats: tailB.seats,
            flightB,
            tailANewLegs: suffixB,
            tailBNewLegs: suffixA,
            crewAssignmentsValidated,
            crewValidationDetail,
          });

          const actionId = `REC-SWAP-${tailA.tailId}-${flightA.flightId}-${tailB.tailId}-${flightB.flightId}`;
          registerAction({
            actionId,
            type: 'swap_aircraft_rotations',
            label: `Swap ${tailA.tailId} (${flightA.flightId}) ↔ ${tailB.tailId} (${flightB.flightId}) at ${hub}`,
            description: `Assign ${tailB.tailId} (ready ${formatMinutesToClock(tailBReadyMin)} at ${hub}) to operate ${suffixA.map((l) => l.flightId).join(', ')}, and assign ${tailA.tailId} (ready ${formatMinutesToClock(tailAReadyMin)}) to operate ${suffixB.map((l) => l.flightId).join(', ')}.`,
            generationReason: `${tailB.tailId} is available ${tailAReadyMin - tailBReadyMin}m earlier at ${hub} than delayed ${tailA.tailId}, enabling earlier departure of ${flightA.flightId}.`,
            parameters: {
              targetTailId: tailA.tailId,
              targetFlightId: flightA.flightId,
              reassignedFlightIds: suffixA.map((l) => l.flightId),
              secondaryTailId: tailB.tailId,
              secondaryFlightId: flightB.flightId,
              secondaryReassignedFlightIds: suffixB.map((l) => l.flightId),
            },
            isFeasible: check.isFeasible,
            feasibilityReason: check.reason,
            feasibilityChecks: check.checks,
            usesAssumedStandbyCrew: false,
            isEngineVerified: false,
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Type 4: Controlled Departure Hold (Protect Missed Passenger Connections)
  // -------------------------------------------------------------------------
  for (const conn of baseline.connections) {
    if (conn.status !== 'missed_due_to_delay') continue;
    const fromFl = baselineFlightById.get(conn.fromFlightId);
    const toFl = baselineFlightById.get(conn.toFlightId);
    if (!fromFl || !toFl) continue;

    const check = validateControlledHoldFeasibility({
      connectionId: conn.connectionId,
      fromFlight: fromFl,
      toFlight: toFl,
      minConnectMinutes: conn.minConnectMinutes,
      closure: baseline.closure,
    });

    const actionId = `REC-HOLD-${conn.connectionId}-${toFl.flightId}`;
    registerAction({
      actionId,
      type: 'hold_connection_flight',
      label: `Hold ${toFl.flightId} (+${check.additionalHoldMin}m) for ${conn.connectionId} (${conn.passengers} pax)`,
      description: `Hold ${toFl.flightId} (${toFl.origin}→${toFl.destination}) until ${formatMinutesToClock(check.targetDepMin)} at ${conn.airportId} to protect ${conn.passengers} connecting passengers arriving on ${conn.fromFlightId}.`,
      generationReason: `Connection ${conn.connectionId} (${conn.passengers} pax at ${conn.airportId}) missed by ${conn.shortfallMinutes}m in baseline; holding ${toFl.flightId} by +${check.additionalHoldMin}m restores ${conn.minConnectMinutes}m MCT.`,
      parameters: {
        connectionId: conn.connectionId,
        targetFlightId: toFl.flightId,
        targetTailId: toFl.assignedTailId,
        holdMinutes: check.additionalHoldMin,
        holdTargetDepMin: check.targetDepMin,
      },
      isFeasible: check.isFeasible,
      feasibilityReason: check.reason,
      feasibilityChecks: check.checks,
      usesAssumedStandbyCrew: false,
      isEngineVerified: false,
    });
  }

  // Sort deterministically by actionId
  candidates.sort((a, b) => a.actionId.localeCompare(b.actionId));
  rejectedCandidates.sort((a, b) => a.actionId.localeCompare(b.actionId));

  return { candidates, rejectedCandidates };
}

// ---------------------------------------------------------------------------
// 3. Deterministic Execution & Evaluation via simulateDisruption
// ---------------------------------------------------------------------------

function buildExecutionOptionsForAction(
  network: NormalizedFlightNetwork,
  baseline: SimulationResult,
  action: RecoveryAction
): SimulationExecutionOptions {
  if (!action.isFeasible) {
    throw new Error(
      `Cannot execute infeasible recovery action ${action.actionId}: ${action.feasibilityReason}`
    );
  }

  const verifiedAction: RecoveryAction = { ...action, isEngineVerified: true };

  if (action.type === 'cancel_flight_chain') {
    const cancelIds = action.parameters.cancelledFlightIds ?? (
      action.parameters.targetFlightId ? [action.parameters.targetFlightId] : []
    );
    return {
      preCancelledFlightIds: new Set(cancelIds),
      appliedRecoveryActions: [verifiedAction],
      scenarioId: `${baseline.scenarioId}__${action.actionId}`,
    };
  }

  if (action.type === 'hold_connection_flight') {
    const targetFlightId = action.parameters.targetFlightId;
    const holdTargetDepMin = action.parameters.holdTargetDepMin;
    if (!targetFlightId || holdTargetDepMin === undefined) {
      throw new Error(`Invalid hold_connection_flight parameters on ${action.actionId}`);
    }
    return {
      flightMinDepartureByFlightId: {
        [targetFlightId]: {
          minDepMin: holdTargetDepMin,
          sourceRefId: action.parameters.connectionId ?? action.actionId,
          reason: `Controlled departure hold to ${formatMinutesToClock(holdTargetDepMin)} to protect connection ${action.parameters.connectionId ?? ''}.`,
        },
      },
      appliedRecoveryActions: [verifiedAction],
      scenarioId: `${baseline.scenarioId}__${action.actionId}`,
    };
  }

  if (action.type === 'deploy_spare_aircraft') {
    const spareId = action.parameters.spareTailId;
    const targetTailId = action.parameters.targetTailId;
    const reassignedIds = new Set(action.parameters.reassignedFlightIds ?? []);
    if (!spareId || !targetTailId || reassignedIds.size === 0) {
      throw new Error(`Invalid deploy_spare_aircraft parameters on ${action.actionId}`);
    }

    const spare = network.index.spareAircraftById[spareId];
    if (!spare) {
      throw new Error(`Unknown spare aircraft "${spareId}"`);
    }

    const spareLegs: ScheduledFlight[] = [];
    const customRotations: CustomTailRotationPlan[] = network.activeAircraft.map((ac) => {
      const fullLegs = network.index.flightsByTailId[ac.tailId];
      if (ac.tailId !== targetTailId) {
        return {
          tailId: ac.tailId,
          isSpare: false,
          startingAirportId: fullLegs[0].origin,
          availableFromMin: 0,
          legs: fullLegs,
        };
      }
      const keptLegs: ScheduledFlight[] = [];
      for (const leg of fullLegs) {
        if (reassignedIds.has(leg.flightId)) {
          spareLegs.push(leg);
        } else {
          keptLegs.push(leg);
        }
      }
      return {
        tailId: ac.tailId,
        isSpare: false,
        startingAirportId: fullLegs[0].origin,
        availableFromMin: 0,
        legs: keptLegs,
      };
    });

    customRotations.push({
      tailId: spare.tailId,
      isSpare: true,
      startingAirportId: spare.baseAirportId,
      availableFromMin: spare.availableFromMin,
      legs: spareLegs,
    });

    return {
      customRotations,
      appliedRecoveryActions: [verifiedAction],
      scenarioId: `${baseline.scenarioId}__${action.actionId}`,
    };
  }

  if (action.type === 'swap_aircraft_rotations') {
    const tailAId = action.parameters.targetTailId;
    const tailBId = action.parameters.secondaryTailId;
    const suffixAIds = new Set(action.parameters.reassignedFlightIds ?? []);
    const suffixBIds = new Set(action.parameters.secondaryReassignedFlightIds ?? []);
    if (!tailAId || !tailBId || suffixAIds.size === 0 || suffixBIds.size === 0) {
      throw new Error(`Invalid swap_aircraft_rotations parameters on ${action.actionId}`);
    }

    const legsA = network.index.flightsByTailId[tailAId];
    const legsB = network.index.flightsByTailId[tailBId];
    const prefixA = legsA.filter((l) => !suffixAIds.has(l.flightId));
    const movedA = legsA.filter((l) => suffixAIds.has(l.flightId));
    const prefixB = legsB.filter((l) => !suffixBIds.has(l.flightId));
    const movedB = legsB.filter((l) => suffixBIds.has(l.flightId));

    const customRotations: CustomTailRotationPlan[] = network.activeAircraft.map((ac) => {
      const fullLegs = network.index.flightsByTailId[ac.tailId];
      if (ac.tailId === tailAId) {
        return {
          tailId: ac.tailId,
          isSpare: false,
          startingAirportId: fullLegs[0].origin,
          availableFromMin: 0,
          legs: [...prefixA, ...movedB],
        };
      }
      if (ac.tailId === tailBId) {
        return {
          tailId: ac.tailId,
          isSpare: false,
          startingAirportId: fullLegs[0].origin,
          availableFromMin: 0,
          legs: [...prefixB, ...movedA],
        };
      }
      return {
        tailId: ac.tailId,
        isSpare: false,
        startingAirportId: fullLegs[0].origin,
        availableFromMin: 0,
        legs: fullLegs,
      };
    });

    return {
      customRotations,
      appliedRecoveryActions: [verifiedAction],
      scenarioId: `${baseline.scenarioId}__${action.actionId}`,
    };
  }

  throw new Error(`Unsupported recovery action type: ${String(action.type)}`);
}

/**
 * Re-simulates the entire airline network with a feasible recovery action applied.
 */
export function executeRecoveryAction(
  network: NormalizedFlightNetwork,
  baseline: SimulationResult,
  action: RecoveryAction
): SimulationResult {
  const execOptions = buildExecutionOptionsForAction(network, baseline, action);
  return simulateDisruption(network, baseline.closure, baseline.config, execOptions);
}

/**
 * Executes a feasible candidate through the deterministic engine and produces its
 * full before-and-after RecoveryComparison.
 */
export function evaluateRecoveryCandidate(
  network: NormalizedFlightNetwork,
  baseline: SimulationResult,
  action: RecoveryAction
): RecoveryComparison {
  const recovered = executeRecoveryAction(network, baseline, action);
  return compareScenarios(baseline, recovered, action);
}

/**
 * End-to-end deterministic recovery pipeline:
 * 1. Generate feasible candidates & capture rejected infeasible options.
 * 2. Re-simulate every feasible candidate via simulateDisruption.
 * 3. Filter out controlled holds that fail to produce measurable passenger/network benefit.
 * 4. Rank all verified options transparently by explicit multi-criteria scores.
 */
export function generateAndRankRecoveryOptions(
  network: NormalizedFlightNetwork,
  baseline: SimulationResult
): {
  baseline: SimulationResult;
  rankedOptions: RankedRecoveryOption[];
  rejectedCandidates: RecoveryAction[];
} {
  const { candidates, rejectedCandidates } = generateRecoveryCandidates(network, baseline);
  const comparisons: RecoveryComparison[] = [];
  const allRejected: RecoveryAction[] = [...rejectedCandidates];

  for (const candidate of candidates) {
    const comparison = evaluateRecoveryCandidate(network, baseline, candidate);

    // Per operational rule: do not recommend a controlled departure hold unless its impact is measurable
    if (candidate.type === 'hold_connection_flight') {
      const hasMeasurableBenefit =
        comparison.savedConnectionIds.length > 0 ||
        comparison.deltas.totalStrandedPaxDelta < 0 ||
        comparison.deltas.totalDelayMinutesDelta < 0;
      if (!hasMeasurableBenefit) {
        allRejected.push({
          ...candidate,
          isFeasible: false,
          isEngineVerified: true,
          feasibilityReason:
            'Rejected after deterministic re-simulation: controlled hold produced no measurable connection protection or delay reduction.',
        });
        continue;
      }
    }

    comparisons.push(comparison);
  }

  const rankedOptions = rankRecoveryComparisons(comparisons);
  return {
    baseline,
    rankedOptions,
    rejectedCandidates: allRejected,
  };
}

export const defaultRecoveryEngine: RecoveryEngine = {
  generateFeasibleCandidates: (network, baseline) =>
    generateRecoveryCandidates(network, baseline).candidates,
  applyRecoveryAction: executeRecoveryAction,
  evaluateCandidateWithComparison: evaluateRecoveryCandidate,
};
