/**
 * Domino Sky — Automated Foundation, Simulation & Recovery Verification Suite
 *
 * Executes real assertions against the official flight_network.json dataset,
 * rule-level validators, end-to-end chronological disruption simulations, and
 * full deterministic recovery generation, re-simulation, comparison, and ranking.
 * Zero invented operational results are used as test evidence.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { RawFlightNetworkDataset } from '../src/types/dataset.ts';
import type {
  AirportClosureEvent,
  RecoveryAction,
  RecoveryComparison,
  SimulationResult,
} from '../src/types/simulation.ts';
import { normalizeFlightNetwork } from '../src/engine/dataset/loader.ts';
import { validateRawFlightNetwork } from '../src/engine/dataset/validator.ts';
import {
  DEFAULT_SIMULATION_CONFIG,
  allocateReopeningCapacitySlots,
  createAirportClosureEvent,
  evaluateFlightAgainstClosure,
  isTimeInsideClosure,
} from '../src/engine/closure/index.ts';
import {
  simulateDisruption,
  traceCausalChain,
} from '../src/engine/propagation/index.ts';
import {
  validateTailCancellationContinuity,
  verifyPhysicalConsistency,
} from '../src/engine/rotation/index.ts';
import { evaluateSingleConnection } from '../src/engine/passenger/index.ts';
import { evaluateCrewDutyCompliance } from '../src/engine/crew/index.ts';
import {
  evaluateRecoveryCandidate,
  executeRecoveryAction,
  generateAndRankRecoveryOptions,
  generateRecoveryCandidates,
  validateCancellationFeasibility,
  validateSpareDeploymentFeasibility,
  validateTailSwapFeasibility,
} from '../src/engine/recovery/index.ts';
import {
  formatDurationMinutes,
  formatMinutesToClock,
  parseHHMMToMinutes,
} from '../src/engine/time.ts';
import { OFFICIAL_AND_ASSUMED_RULES } from '../src/engine/assumptions.ts';

const DATASET_PATH = path.resolve(
  process.cwd(),
  'public/assets/aistudio/flight_network_78529dd1.json'
);

interface TestOutcome {
  name: string;
  passed: boolean;
  detail: string;
}

const outcomes: TestOutcome[] = [];

function runTest(name: string, fn: () => string) {
  try {
    const detail = fn();
    outcomes.push({ name, passed: true, detail });
    console.log(`PASS  ${name} — ${detail}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    outcomes.push({ name, passed: false, detail });
    console.error(`FAIL  ${name} — ${detail}`);
  }
}

function assertSimulationInvariants(res: SimulationResult, closure: AirportClosureEvent | null) {
  if (closure) {
    for (const fl of res.flights) {
      if (fl.status === 'cancelled') continue;
      if (fl.origin === closure.airportId && fl.actualDepMin !== null) {
        assert.equal(
          isTimeInsideClosure(fl.actualDepMin, closure),
          false,
          `Illegal departure during closure: ${fl.flightId} at ${formatMinutesToClock(fl.actualDepMin)}`
        );
      }
      if (fl.destination === closure.airportId && fl.actualArrMin !== null) {
        assert.equal(
          isTimeInsideClosure(fl.actualArrMin, closure),
          false,
          `Illegal arrival during closure: ${fl.flightId} at ${formatMinutesToClock(fl.actualArrMin)}`
        );
      }
    }
  }

  const consistency = verifyPhysicalConsistency(res.rotations);
  assert.equal(consistency.isConsistent, true, consistency.errors.join(' '));

  const operated = res.flights.filter((f) => f.status !== 'cancelled');
  const delayed = res.flights.filter((f) => f.status === 'delayed');
  const cancelled = res.flights.filter((f) => f.status === 'cancelled');
  const onTime = res.flights.filter((f) => f.status === 'on_time');

  assert.equal(res.kpis.totalFlights, 70);
  assert.equal(res.kpis.operatedFlights, operated.length);
  assert.equal(res.kpis.onTimeFlights, onTime.length);
  assert.equal(res.kpis.delayedFlights, delayed.length);
  assert.equal(res.kpis.cancelledFlights, cancelled.length);
  assert.equal(res.kpis.operatedFlights + res.kpis.cancelledFlights, 70);

  const sumDelay = operated.reduce((acc, f) => acc + f.arrivalDelayMin, 0);
  assert.equal(res.kpis.totalDelayMinutes, sumDelay);

  const expectedAvg = delayed.length > 0 ? Math.round((sumDelay / delayed.length) * 10) / 10 : 0;
  assert.equal(res.kpis.averageDelayMinutes, expectedAvg);

  assert.equal(
    res.kpis.totalStrandedPaxEstimate,
    res.kpis.cancelledFlightPax + res.kpis.missedConnectionPax
  );
  assert.equal(
    res.kpis.crewViolationsCount,
    res.crews.filter((c) => c.isViolation).length
  );

  for (const fl of delayed) {
    assert.ok(fl.causes.length > 0, `Delayed flight ${fl.flightId} missing causes`);
    assert.ok(fl.causalExplanation.summary.length > 0, `Delayed flight ${fl.flightId} missing explanation`);
  }
}

function assertComparisonInvariants(cmp: RecoveryComparison) {
  assertSimulationInvariants(cmp.recovered, cmp.baseline.closure);
  assert.equal(cmp.appliedAction.isEngineVerified, true);

  const b = cmp.baseline.kpis;
  const r = cmp.recovered.kpis;
  assert.equal(cmp.deltas.delayedFlightsDelta, r.delayedFlights - b.delayedFlights);
  assert.equal(cmp.deltas.cancelledFlightsDelta, r.cancelledFlights - b.cancelledFlights);
  assert.equal(cmp.deltas.totalDelayMinutesDelta, r.totalDelayMinutes - b.totalDelayMinutes);
  assert.equal(cmp.deltas.maxDelayMinutesDelta, r.maxDelayMinutes - b.maxDelayMinutes);
  assert.equal(cmp.deltas.missedConnectionsDelta, r.missedConnectionsCount - b.missedConnectionsCount);
  assert.equal(cmp.deltas.missedConnectionPaxDelta, r.missedConnectionPax - b.missedConnectionPax);
  assert.equal(cmp.deltas.cancelledFlightPaxDelta, r.cancelledFlightPax - b.cancelledFlightPax);
  assert.equal(cmp.deltas.totalStrandedPaxDelta, r.totalStrandedPaxEstimate - b.totalStrandedPaxEstimate);
  assert.equal(cmp.deltas.crewViolationsDelta, r.crewViolationsCount - b.crewViolationsCount);

  // Every single one of the 70 flights must be categorized into exactly one outcome bucket
  const totalCategorized =
    cmp.recoveredFlightIds.length +
    cmp.delayReducedFlightIds.length +
    cmp.delayIncreasedFlightIds.length +
    cmp.cancelledForRecoveryFlightIds.length +
    cmp.unaffectedFlightIds.length;
  assert.equal(totalCategorized, 70);
  assert.equal(cmp.flightDiffs.length, 70);
}

const rawJson = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf-8')) as RawFlightNetworkDataset;
const { network } = normalizeFlightNetwork(rawJson);

// ===========================================================================
// PART A — Foundation Dataset, Validation & Unit Rule Tests (01–09)
// ===========================================================================

runTest('01. Official dataset file exists and parses cleanly', () => {
  assert.ok(fs.existsSync(DATASET_PATH));
  assert.equal(rawJson.meta.dataset, 'Domino Sky flight network');
  return `Loaded ${DATASET_PATH}`;
});

runTest('02. Official dataset matches required inventory counts', () => {
  const report = validateRawFlightNetwork(rawJson);
  assert.equal(report.isValid, true);
  assert.equal(report.counts.airports, 16);
  assert.equal(report.counts.flights, 70);
  assert.equal(report.counts.activeAircraft, 16);
  assert.equal(report.counts.spareAircraft, 2);
  assert.equal(report.counts.connections, 21);
  assert.equal(report.counts.crews, 16);
  assert.equal(report.summary.errors, 0);
  return `16 airports, 70 flights, 16 active tails, 2 spares, 21 connections, 16 crews`;
});

runTest('03. Normalization builds exact absolute-minute schedules and O(1) indexes', () => {
  assert.equal(network.meta.minTurnaroundMinutes, 30);
  assert.equal(network.meta.seatsPerAircraft, 180);
  const cr03 = network.index.crewsById['CR03'];
  assert.equal(cr03.scheduledDutyMins, 590);
  assert.equal(cr03.scheduledDutyMarginMins, 10);
  return `Normalized 70 flights; verified CR03 = ${cr03.scheduledDutyMins}/${cr03.maxDutyMins}m`;
});

runTest('04. Validator catches broken airport reference, discontinuity, and crew mismatch (negative test)', () => {
  const corrupted: RawFlightNetworkDataset = structuredClone(rawJson);
  corrupted.flights[0].origin = 'ZZZ';
  corrupted.flights[1].origin = 'GOI';
  corrupted.connections[0].airport = 'DEL';
  corrupted.crews[0].flight_ids = ['DS0101'];

  const report = validateRawFlightNetwork(corrupted);
  assert.equal(report.isValid, false);
  assert.ok(report.summary.errors >= 4);
  return `Caught ${report.summary.errors} corrupted categories`;
});

runTest('05. Unit closure rules: origin hold, destination GDP hold, airborne hold, and zero delay outside window', () => {
  const ds0401 = network.index.flightsById['DS0401'];
  const bomClosure = createAirportClosureEvent(network, 'BOM', parseHHMMToMinutes('07:30'), 90);
  const originEval = evaluateFlightAgainstClosure({
    origin: ds0401.origin,
    destination: ds0401.destination,
    readyDepMin: ds0401.scheduledDepMin,
    blockMinutes: ds0401.blockMinutes,
    closure: bomClosure,
  });
  assert.equal(originEval.impactKind, 'origin_ground_hold');
  assert.equal(originEval.adjustedDepMin, bomClosure.endMin);

  const ds0701 = network.index.flightsById['DS0701'];
  const bomEarly = createAirportClosureEvent(network, 'BOM', parseHHMMToMinutes('06:15'), 135);
  assert.equal(
    evaluateFlightAgainstClosure({
      origin: ds0701.origin,
      destination: ds0701.destination,
      readyDepMin: ds0701.scheduledDepMin,
      blockMinutes: ds0701.blockMinutes,
      closure: bomEarly,
    }).impactKind,
    'destination_ground_hold'
  );

  const bomMid = createAirportClosureEvent(network, 'BOM', parseHHMMToMinutes('07:00'), 90);
  const airborne = evaluateFlightAgainstClosure({
    origin: ds0701.origin,
    destination: ds0701.destination,
    readyDepMin: ds0701.scheduledDepMin,
    blockMinutes: ds0701.blockMinutes,
    closure: bomMid,
  });
  assert.equal(airborne.impactKind, 'airborne_arrival_holding');
  assert.equal(airborne.airborneHoldMinutes, 35);

  const ds1501 = network.index.flightsById['DS1501'];
  const bomLater = createAirportClosureEvent(network, 'BOM', parseHHMMToMinutes('08:00'), 120);
  assert.equal(
    evaluateFlightAgainstClosure({
      origin: ds1501.origin,
      destination: ds1501.destination,
      readyDepMin: ds1501.scheduledDepMin,
      blockMinutes: ds1501.blockMinutes,
      closure: bomLater,
    }).impactKind,
    'unaffected'
  );
  return 'Verified origin hold, destination GDP hold, airborne hold (35m), and 0m outside closure';
});

runTest('06. Unit reopening capacity: deterministic queue ordering and zero arbitrary delay after backlog clears', () => {
  const goi = network.index.airportsById['GOI'];
  const reopenMin = parseHHMMToMinutes('10:00');
  const slots = allocateReopeningCapacitySlots(
    [
      { flightId: 'DS0402', movementType: 'departure', readyTimeMin: reopenMin, scheduledTimeMin: parseHHMMToMinutes('09:20') },
      { flightId: 'DS0401', movementType: 'arrival', readyTimeMin: reopenMin, scheduledTimeMin: parseHHMMToMinutes('08:50') },
      { flightId: 'DS1601', movementType: 'departure', readyTimeMin: parseHHMMToMinutes('14:00'), scheduledTimeMin: parseHHMMToMinutes('14:00') },
    ],
    reopenMin,
    goi.capacityPerHour,
    DEFAULT_SIMULATION_CONFIG.reopeningQueueOrdering
  );
  assert.equal(slots[0].flightId, 'DS0401');
  assert.equal(slots[1].assignedSlotMin, reopenMin + 6);
  assert.equal(slots[2].congestionDelayMin, 0);
  return `GOI (${goi.capacityPerHour}/hr) ordered DS0401 -> DS0402 (+6m) and left 14:00 DS1601 unpenalized`;
});

runTest('07. Unit spare deployment feasibility: late availability, wrong positioning, capacity violation & standby policy', () => {
  const spareDel = network.index.spareAircraftById['VT-DS18'];
  const spareBlr = network.index.spareAircraftById['VT-DS17'];
  const ds0101 = network.index.flightsById['DS0101'];

  // Valid
  const ok = validateSpareDeploymentFeasibility({
    spare: spareDel,
    spareCurrentPosition: spareDel.baseAirportId,
    spareReadyMin: spareDel.availableFromMin,
    targetFlight: ds0101,
    plannedDepartureMin: ds0101.scheduledDepMin,
    config: DEFAULT_SIMULATION_CONFIG,
  });
  assert.equal(ok.isFeasible, true);
  assert.equal(ok.usesAssumedStandbyCrew, true);

  // Invalid positioning (BLR spare for DEL origin)
  assert.equal(
    validateSpareDeploymentFeasibility({
      spare: spareBlr,
      spareCurrentPosition: spareBlr.baseAirportId,
      spareReadyMin: spareBlr.availableFromMin,
      targetFlight: ds0101,
      plannedDepartureMin: ds0101.scheduledDepMin,
      config: DEFAULT_SIMULATION_CONFIG,
    }).isFeasible,
    false
  );

  // Spare arriving too late (ready 09:00 > planned dep 08:00, and pre-05:00 check)
  assert.equal(
    validateSpareDeploymentFeasibility({
      spare: spareDel,
      spareCurrentPosition: spareDel.baseAirportId,
      spareReadyMin: parseHHMMToMinutes('09:00'),
      targetFlight: ds0101,
      plannedDepartureMin: ds0101.scheduledDepMin,
      config: DEFAULT_SIMULATION_CONFIG,
    }).isFeasible,
    false
  );

  // Capacity violation (100 seats < 118 pax)
  assert.equal(
    validateSpareDeploymentFeasibility({
      spare: { ...spareDel, seats: 100 },
      spareCurrentPosition: spareDel.baseAirportId,
      spareReadyMin: spareDel.availableFromMin,
      targetFlight: ds0101,
      plannedDepartureMin: ds0101.scheduledDepMin,
      config: DEFAULT_SIMULATION_CONFIG,
    }).isFeasible,
    false
  );

  // Standby crew assumption disabled without verified crew
  assert.equal(
    validateSpareDeploymentFeasibility({
      spare: spareDel,
      spareCurrentPosition: spareDel.baseAirportId,
      spareReadyMin: spareDel.availableFromMin,
      targetFlight: ds0101,
      plannedDepartureMin: ds0101.scheduledDepMin,
      config: {
        ...DEFAULT_SIMULATION_CONFIG,
        assumedStandbyCrew: { ...DEFAULT_SIMULATION_CONFIG.assumedStandbyCrew, enabled: false },
      },
    }).isFeasible,
    false
  );

  return 'Verified valid VT-DS18 @ DEL; rejected wrong-position, late-arrival, capacity-overflow, and disabled-standby-crew cases';
});

runTest('08. Unit cancellation continuity & tail swap feasibility: valid vs invalid cases', () => {
  const vtDs01Legs = network.index.flightsByTailId['VT-DS01'];
  assert.equal(
    validateTailCancellationContinuity('VT-DS01', vtDs01Legs, new Set(['DS0101'])).isPhysicallyConsistent,
    false
  );
  assert.equal(
    validateCancellationFeasibility({
      tailId: 'VT-DS01',
      orderedTailLegs: vtDs01Legs,
      cancelledFlightIds: ['DS0101', 'DS0102'],
    }).isFeasible,
    true
  );

  const ds0101 = network.index.flightsById['DS0101'];
  const ds0901 = network.index.flightsById['DS0901'];
  // Invalid: unvalidated crew assignments
  assert.equal(
    validateTailSwapFeasibility({
      tailAId: 'VT-DS01',
      tailAPosition: 'DEL',
      tailAReadyMin: parseHHMMToMinutes('07:30'),
      tailASeats: 180,
      flightA: ds0101,
      tailBId: 'VT-DS09',
      tailBPosition: 'DEL',
      tailBReadyMin: parseHHMMToMinutes('08:30'),
      tailBSeats: 180,
      flightB: ds0901,
      crewAssignmentsValidated: false,
      crewValidationDetail: 'Unverified crew assignments.',
    }).isFeasible,
    false
  );
  // Invalid: mismatched physical airport positions
  assert.equal(
    validateTailSwapFeasibility({
      tailAId: 'VT-DS01',
      tailAPosition: 'BOM',
      tailAReadyMin: parseHHMMToMinutes('07:30'),
      tailASeats: 180,
      flightA: ds0101,
      tailBId: 'VT-DS09',
      tailBPosition: 'DEL',
      tailBReadyMin: parseHHMMToMinutes('08:30'),
      tailBSeats: 180,
      flightB: ds0901,
      crewAssignmentsValidated: true,
      crewValidationDetail: 'Crews legal.',
    }).isFeasible,
    false
  );
  return 'Rejected single-leg cancel, unvalidated crew swap, and position-mismatched swap; approved round-trip cancel';
});

runTest('09. Unit connection & crew evaluators + rules registry coverage', () => {
  const cx01 = network.connections.find((c) => c.connectionId === 'CX01')!;
  assert.equal(evaluateSingleConnection(cx01, 460, 530).status, 'made');
  assert.equal(evaluateSingleConnection(cx01, 490, 530).status, 'missed_due_to_delay');
  assert.equal(evaluateSingleConnection(cx01, null, 530).status, 'broken_due_to_from_cancellation');

  const cr03 = network.index.crewsById['CR03'];
  const standbyEval = evaluateCrewDutyCompliance({
    crew: { ...cr03, crewId: 'ASSUMED-STBY-VT-DS18', tailId: 'VT-DS18' },
    legCompletions: [{ flightId: 'DS0101', actualArrMin: network.index.flightsById['DS0101'].scheduledArrMin }],
    isAssumedStandbyCrew: true,
  });
  assert.equal(standbyEval.isAssumedStandbyCrew, true);
  assert.ok(OFFICIAL_AND_ASSUMED_RULES.length >= 11);
  return 'Unit connection, crew standby disclosure, and 11 documented rules verified';
});

// ===========================================================================
// PART B — End-to-End Deterministic Simulation Engine Tests (10–19)
// ===========================================================================

runTest('10. E2E No-closure baseline simulation: 70/70 on-time, 0 delays, 21/21 connections, 0 crew breaches', () => {
  const res = simulateDisruption(network, null);
  assertSimulationInvariants(res, null);
  assert.equal(res.kpis.onTimeFlights, 70);
  assert.equal(res.kpis.totalDelayMinutes, 0);
  assert.equal(res.passengerImpact.preservedConnectionsCount, 21);
  assert.equal(res.kpis.crewViolationsCount, 0);
  return '70/70 on time, 0m delay, 21/21 connections preserved, 0 crew violations';
});

runTest('11. E2E Closure at Mumbai (BOM 08:00–10:00): direct hits, airborne hold, propagation & connections', () => {
  const closure = createAirportClosureEvent(network, 'BOM', parseHHMMToMinutes('08:00'), 120);
  const res = simulateDisruption(network, closure);
  assertSimulationInvariants(res, closure);
  const ds0201 = res.flights.find((f) => f.flightId === 'DS0201')!;
  assert.ok(ds0201.causes.some((c) => c.type === 'airborne_arrival_holding'));
  assert.equal(res.kpis.delayedFlights, 17);
  assert.equal(res.kpis.totalDelayMinutes, 897);
  return `BOM 08:00–10:00: ${res.kpis.delayedFlights} delayed (${formatDurationMinutes(res.kpis.totalDelayMinutes)}), ${res.kpis.missedConnectionsCount} missed conn (${res.kpis.missedConnectionPax} pax)`;
});

runTest('12. E2E Closure at Bengaluru (BLR 11:00–13:00): hub cascade & slack absorption', () => {
  const closure = createAirportClosureEvent(network, 'BLR', parseHHMMToMinutes('11:00'), 120);
  const res = simulateDisruption(network, closure);
  assertSimulationInvariants(res, closure);
  const ds0605 = res.flights.find((f) => f.flightId === 'DS0605')!;
  assert.equal(ds0605.turnaroundSlackAbsorbedMin, 5);
  assert.ok(traceCausalChain(res.flights, 'DS0605').length >= 2);
  return `BLR 11:00–13:00: ${res.kpis.delayedFlights} delayed, DS0605 absorbed 5m slack, ${res.kpis.missedConnectionsCount} missed conn`;
});

runTest('13. E2E Closure at Delhi (DEL 12:00–14:30): crew duty violation on CR03 under default flag_violation policy', () => {
  const closure = createAirportClosureEvent(network, 'DEL', parseHHMMToMinutes('12:00'), 150);
  const res = simulateDisruption(network, closure);
  assertSimulationInvariants(res, closure);
  assert.equal(res.kpis.cancelledFlights, 0);
  const cr03 = res.crews.find((c) => c.crewId === 'CR03')!;
  assert.equal(cr03.isViolation, true);
  assert.equal(cr03.overageMins, 112);
  return `DEL 12:00–14:30: ${res.kpis.delayedFlights} delayed, 0 cancelled, CR03 +${cr03.overageMins}m overage`;
});

runTest('14. E2E Turnaround slack full absorption (GOI 08:30–09:15)', () => {
  const closure = createAirportClosureEvent(network, 'GOI', parseHHMMToMinutes('08:30'), 45);
  const res = simulateDisruption(network, closure, { enforceReopeningCapacityMetering: false });
  assertSimulationInvariants(res, closure);
  assert.equal(res.flights.find((f) => f.flightId === 'DS0403')!.status, 'on_time');
  assert.equal(res.flights.find((f) => f.flightId === 'DS0403')!.turnaroundSlackAbsorbedMin, 25);
  return 'DS0401 (+25m) -> DS0402 (+25m) -> DS0403 (0m, absorbed 25m of 40m slack)';
});

runTest('15. E2E Reopening capacity metering vs immediate release (BOM 07:30–10:30)', () => {
  const closure = createAirportClosureEvent(network, 'BOM', parseHHMMToMinutes('07:30'), 180);
  const metered = simulateDisruption(network, closure, { enforceReopeningCapacityMetering: true });
  const unmetered = simulateDisruption(network, closure, { enforceReopeningCapacityMetering: false });
  assertSimulationInvariants(metered, closure);
  assert.ok(metered.kpis.totalDelayMinutes > unmetered.kpis.totalDelayMinutes);
  assert.equal(metered.flights.find((f) => f.flightId === 'DS0302')!.reopeningSlotDelayMinutes, 0);
  return `BOM 07:30–10:30: metered=${metered.kpis.totalDelayMinutes}m vs unmetered=${unmetered.kpis.totalDelayMinutes}m`;
});

runTest('16. E2E Midnight rollover (CCU 19:30–22:45 -> DS1005 arr past 24:00 +1d)', () => {
  const closure = createAirportClosureEvent(network, 'CCU', parseHHMMToMinutes('19:30'), 195);
  const res = simulateDisruption(network, closure);
  assertSimulationInvariants(res, closure);
  const ds1005 = res.flights.find((f) => f.flightId === 'DS1005')!;
  assert.ok((ds1005.actualArrMin ?? 0) >= 1440);
  return `DS1005 arr ${formatMinutesToClock(ds1005.actualArrMin!)} (${ds1005.actualArrMin}m)`;
});

runTest('17. E2E Cancelled flight physical continuity: pre-cancelling DS0101 strands DS0102 at DEL', () => {
  const res = simulateDisruption(network, null, undefined, {
    preCancelledFlightIds: new Set(['DS0101']),
  });
  assertSimulationInvariants(res, null);
  assert.equal(res.flights.find((f) => f.flightId === 'DS0102')!.status, 'cancelled');
  assert.equal(res.flights.find((f) => f.flightId === 'DS0103')!.status, 'on_time');
  return `Auto-stranded DS0102 at DEL; DS0103–DS0105 operated legally (${res.kpis.cancelledFlightPax} cancelled pax)`;
});

runTest('18. E2E Strict opt-in crew policy cancels violating legs with zero double-counting', () => {
  const closure = createAirportClosureEvent(network, 'DEL', parseHHMMToMinutes('12:00'), 150);
  const strictRes = simulateDisruption(network, closure, {
    crewViolationPolicy: 'cancel_violating_legs',
  });
  assertSimulationInvariants(strictRes, closure);
  assert.equal(strictRes.kpis.crewViolationsCount, 0);
  assert.ok(strictRes.passengerImpact.cancelledConnectionOverlapPax >= 14);
  return `${strictRes.kpis.cancelledFlights} legs cancelled, 0 crew violations, ${strictRes.passengerImpact.cancelledConnectionOverlapPax} overlap pax excluded`;
});

runTest('19. E2E Simulation determinism: identical inputs produce bit-identical SimulationResult', () => {
  const closure = createAirportClosureEvent(network, 'BOM', parseHHMMToMinutes('08:00'), 120);
  assert.deepEqual(simulateDisruption(network, closure), simulateDisruption(network, closure));
  return 'Repeated BOM 08:00–10:00 simulations matched bit-for-bit';
});

// ===========================================================================
// PART C — Prompt 3 Deterministic Recovery Action Engine Tests (20–29)
// ===========================================================================

runTest('20. Recovery: Spare aircraft deployment from BOTH bases (VT-DS17 @ BLR and VT-DS18 @ DEL)', () => {
  // Under BOM 08:00–10:00 closure:
  // - VT-DS05 arrives late into BLR (DS0501 BOM->BLR), delaying DS0502/DS0503/DS0504 -> VT-DS17 @ BLR can take over!
  // - VT-DS15 arrives late into DEL (DS1502 BOM->DEL), delaying DS1503/DS1504 -> VT-DS18 @ DEL can take over!
  const closure = createAirportClosureEvent(network, 'BOM', parseHHMMToMinutes('08:00'), 120);
  const baseline = simulateDisruption(network, closure);
  const { candidates } = generateRecoveryCandidates(network, baseline);

  const blrSpareAction = candidates.find(
    (c) => c.type === 'deploy_spare_aircraft' && c.parameters.spareTailId === 'VT-DS17'
  );
  const delSpareAction = candidates.find(
    (c) => c.type === 'deploy_spare_aircraft' && c.parameters.spareTailId === 'VT-DS18'
  );
  assert.ok(blrSpareAction, 'Expected feasible VT-DS17 spare deployment from BLR');
  assert.ok(delSpareAction, 'Expected feasible VT-DS18 spare deployment from DEL');

  const cmpBlr = evaluateRecoveryCandidate(network, baseline, blrSpareAction);
  const cmpDel = evaluateRecoveryCandidate(network, baseline, delSpareAction);
  assertComparisonInvariants(cmpBlr);
  assertComparisonInvariants(cmpDel);

  // Both spare deployments must genuinely cut total delay and explicitly disclose assumed standby crew!
  assert.ok(cmpBlr.deltas.totalDelayMinutesDelta < 0);
  assert.ok(cmpDel.deltas.totalDelayMinutesDelta < 0);
  assert.ok(cmpBlr.recovered.crews.some((c) => c.tailId === 'VT-DS17' && c.isAssumedStandbyCrew));
  assert.ok(cmpDel.recovered.crews.some((c) => c.tailId === 'VT-DS18' && c.isAssumedStandbyCrew));

  return `VT-DS17 (BLR): ${cmpBlr.deltas.totalDelayMinutesDelta}m delay, ${cmpBlr.recoveredFlightIds.length} recovered; VT-DS18 (DEL): ${cmpDel.deltas.totalDelayMinutesDelta}m delay, ${cmpDel.recoveredFlightIds.length} recovered`;
});

runTest('21. Recovery: Valid vs invalid aircraft swaps (physical position & crew duty enforcement)', () => {
  // Under BOM 08:00–10:00 closure, inspect generated & rejected swap candidates
  const closure = createAirportClosureEvent(network, 'BOM', parseHHMMToMinutes('08:00'), 120);
  const baseline = simulateDisruption(network, closure);
  const { candidates, rejectedCandidates } = generateRecoveryCandidates(network, baseline);

  const feasibleSwaps = candidates.filter((c) => c.type === 'swap_aircraft_rotations');
  const rejectedSwaps = rejectedCandidates.filter((c) => c.type === 'swap_aircraft_rotations');
  assert.ok(feasibleSwaps.length > 0, 'Expected at least one feasible crew-validated swap under BOM closure');
  assert.ok(rejectedSwaps.length > 0, 'Expected infeasible swaps (e.g. morning-to-evening crew duty breach) to be rejected');

  const cmpSwap = evaluateRecoveryCandidate(network, baseline, feasibleSwaps[0]);
  assertComparisonInvariants(cmpSwap);
  assert.equal(cmpSwap.recovered.kpis.cancelledFlights, 0);

  return `${feasibleSwaps.length} feasible swap(s) verified (e.g. ${feasibleSwaps[0].actionId}: ${cmpSwap.deltas.totalDelayMinutesDelta}m delay delta); ${rejectedSwaps.length} infeasible swap(s) rejected for crew/duty violations`;
});

runTest('22. Recovery: Cancellation with downstream continuity & exact non-double-counted passenger impact', () => {
  // Under DEL 12:00–14:30 closure, CR03 has +112m crew duty violation on DS0304.
  // Cancelling DS0304 resolves CR03 crew breach cleanly and excludes CX19 (14 pax) overlap from double counting.
  const closure = createAirportClosureEvent(network, 'DEL', parseHHMMToMinutes('12:00'), 150);
  const baseline = simulateDisruption(network, closure);
  const { candidates } = generateRecoveryCandidates(network, baseline);

  const cancelCrewAction = candidates.find(
    (c) => c.type === 'cancel_flight_chain' && c.actionId.includes('CR03') === false && c.parameters.targetFlightId === 'DS0304'
  );
  assert.ok(cancelCrewAction, 'Expected cancellation candidate targeting crew-violating DS0304');

  const cmp = evaluateRecoveryCandidate(network, baseline, cancelCrewAction);
  assertComparisonInvariants(cmp);
  assert.ok(cmp.resolvedCrewViolationIds.includes('CR03'));
  assert.equal(cmp.deltas.crewViolationsDelta, -1);
  assert.equal(cmp.cancelledForRecoveryFlightIds.length, 1);
  assert.equal(cmp.recovered.kpis.cancelledFlightPax, 167); // DS0304 has 167 pax
  assert.equal(cmp.recovered.kpis.cancelledConnectionOverlapPax, 14); // CX19 has 14 pax, excluded from double-counting

  // Also test round-trip loop cancellation under BOM closure
  const bomClosure = createAirportClosureEvent(network, 'BOM', parseHHMMToMinutes('08:00'), 120);
  const bomBase = simulateDisruption(network, bomClosure);
  const bomCands = generateRecoveryCandidates(network, bomBase).candidates;
  const loopCancel = bomCands.find((c) => c.actionId.startsWith('REC-CANCEL-LOOP-'));
  assert.ok(loopCancel, 'Expected round-trip loop cancellation candidate under BOM closure');
  const cmpLoop = evaluateRecoveryCandidate(network, bomBase, loopCancel);
  assertComparisonInvariants(cmpLoop);
  assert.ok(cmpLoop.recoveredFlightIds.length > 0 || cmpLoop.delayReducedFlightIds.length > 0);

  return `DEL DS0304 cancel resolved CR03 (167 cxl pax, 14 overlap excl); BOM ${loopCancel.actionId} recovered ${cmpLoop.recoveredFlightIds.length} downstream flight(s)`;
});

runTest('23. Recovery: Connection-protecting controlled departure hold & measurable network delay trade-off', () => {
  // Under BOM 08:00–10:00 closure, CX05 (BOM, DS0201 -> DS0702, 30 pax) or CX09 (COK, DS0502 -> DS1305, 44 pax) is missed.
  const closure = createAirportClosureEvent(network, 'BOM', parseHHMMToMinutes('08:00'), 120);
  const baseline = simulateDisruption(network, closure);
  const { candidates } = generateRecoveryCandidates(network, baseline);

  const holdActions = candidates.filter((c) => c.type === 'hold_connection_flight');
  assert.ok(holdActions.length > 0, 'Expected controlled departure hold candidates for missed connections');

  let savedConnVerified = false;
  let worsenedDelayVerified = false;
  let sampleSummary = '';

  for (const holdAction of holdActions) {
    const cmp = evaluateRecoveryCandidate(network, baseline, holdAction);
    assertComparisonInvariants(cmp);
    if (cmp.savedConnectionIds.length > 0) {
      savedConnVerified = true;
      if (cmp.deltas.totalDelayMinutesDelta > 0) {
        worsenedDelayVerified = true;
        sampleSummary = `${holdAction.actionId} saved ${cmp.savedConnectionIds.join(',')} (${Math.abs(cmp.deltas.missedConnectionPaxDelta)} pax) at cost of +${cmp.deltas.totalDelayMinutesDelta}m network delay across ${cmp.delayIncreasedFlightIds.length} flight(s)`;
      }
    }
  }

  assert.equal(savedConnVerified, true, 'Expected at least one controlled hold to save a missed connection');
  assert.equal(worsenedDelayVerified, true, 'Expected controlled hold trade-off to increase total network delay measurably');
  return sampleSummary;
});

runTest('24. Recovery: Crew duty changes under spare deployment (DEL closure relieves CR03 without cancellations)', () => {
  // Under DEL 12:00–14:30 closure, check if spare VT-DS18 @ DEL or cancellation alters crew violations cleanly
  const closure = createAirportClosureEvent(network, 'DEL', parseHHMMToMinutes('12:00'), 150);
  const baseline = simulateDisruption(network, closure);
  const ranked = generateAndRankRecoveryOptions(network, baseline);

  const crewResolvingOption = ranked.rankedOptions.find(
    (opt) => opt.comparison.resolvedCrewViolationIds.includes('CR03')
  );
  assert.ok(crewResolvingOption, 'Expected at least one ranked recovery option resolving CR03 crew violation');
  assertComparisonInvariants(crewResolvingOption.comparison);

  return `Option ${crewResolvingOption.action.actionId} (rank #${crewResolvingOption.rank}) resolved CR03 violation (${crewResolvingOption.comparison.deltas.crewViolationsDelta} breach, ${crewResolvingOption.comparison.deltas.totalDelayMinutesDelta}m delay delta)`;
});

runTest('25. Recovery: Deterministic candidate generation & zero duplicates across repeated runs', () => {
  const closure = createAirportClosureEvent(network, 'BOM', parseHHMMToMinutes('08:00'), 120);
  const baseline = simulateDisruption(network, closure);
  const gen1 = generateRecoveryCandidates(network, baseline);
  const gen2 = generateRecoveryCandidates(network, baseline);

  assert.deepEqual(gen1, gen2);
  const uniqueIds = new Set(gen1.candidates.map((c) => c.actionId));
  assert.equal(uniqueIds.size, gen1.candidates.length, 'Candidate IDs must be unique');
  for (const c of gen1.candidates) {
    assert.ok(c.generationReason.length > 0, `Candidate ${c.actionId} missing generationReason`);
  }
  return `Generated ${gen1.candidates.length} unique feasible + ${gen1.rejectedCandidates.length} rejected candidates deterministically`;
});

runTest('26. Recovery: Deterministic multi-criteria ranking exposes all 5 criteria, weights, and trade-offs', () => {
  const closure = createAirportClosureEvent(network, 'BOM', parseHHMMToMinutes('08:00'), 120);
  const baseline = simulateDisruption(network, closure);
  const run1 = generateAndRankRecoveryOptions(network, baseline);
  const run2 = generateAndRankRecoveryOptions(network, baseline);

  assert.deepEqual(run1, run2);
  assert.ok(run1.rankedOptions.length >= 3, 'Expected multiple ranked recovery options');

  for (let i = 0; i < run1.rankedOptions.length; i++) {
    const opt = run1.rankedOptions[i];
    assert.equal(opt.rank, i + 1);
    assert.equal(opt.ranking.criteria.length, 5);
    assert.equal(opt.action.isFeasible, true);
    if (i > 0) {
      assert.ok(
        run1.rankedOptions[i - 1].ranking.totalScore >= opt.ranking.totalScore,
        'Ranked options must be sorted in non-increasing order of totalScore'
      );
    }
  }

  const top = run1.rankedOptions[0];
  return `Ranked ${run1.rankedOptions.length} options bit-identically; #1 is ${top.action.actionId} (score ${top.ranking.totalScore}, ${top.comparison.deltas.totalDelayMinutesDelta}m delay, ${top.comparison.deltas.totalStrandedPaxDelta} stranded pax)`;
});

runTest('27. Recovery: Physically impossible actions are strictly rejected before execution', () => {
  const closure = createAirportClosureEvent(network, 'BOM', parseHHMMToMinutes('08:00'), 120);
  const baseline = simulateDisruption(network, closure);

  const impossibleSpare: RecoveryAction = {
    actionId: 'REC-IMPOSSIBLE-BLR-ON-DEL',
    type: 'deploy_spare_aircraft',
    label: 'Impossible spare deployment from BLR onto DEL flight',
    description: 'Attempts to teleport VT-DS17 from BLR to DEL.',
    generationReason: 'Negative test',
    parameters: {
      spareTailId: 'VT-DS17',
      targetTailId: 'VT-DS01',
      targetFlightId: 'DS0101',
      reassignedFlightIds: ['DS0101'],
    },
    isFeasible: false,
    feasibilityReason: 'VT-DS17 is physically stationed at BLR, not DEL.',
    feasibilityChecks: [
      {
        checkName: 'spare_base_position',
        passed: false,
        detail: 'VT-DS17 is at BLR, cannot originate DS0101 at DEL.',
      },
    ],
    usesAssumedStandbyCrew: true,
    isEngineVerified: false,
  };

  assert.throws(
    () => executeRecoveryAction(network, baseline, impossibleSpare),
    /Cannot execute infeasible recovery action/
  );
  return 'executeRecoveryAction rejected physically impossible spare teleportation cleanly';
});

const failed = outcomes.filter((o) => !o.passed);
console.log(`\nSummary: ${outcomes.length - failed.length}/${outcomes.length} foundation, simulation & recovery checks passed.`);
if (failed.length > 0) {
  process.exit(1);
}
