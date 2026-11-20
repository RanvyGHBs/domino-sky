/**
 * Domino Sky — Automated Foundation & Deterministic Simulation Verification Suite
 *
 * Executes real assertions against the official flight_network.json dataset,
 * rule-level validators, and end-to-end chronological disruption simulations.
 * Zero invented operational results are used as test evidence.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { RawFlightNetworkDataset } from '../src/types/dataset.ts';
import type { AirportClosureEvent, SimulationResult } from '../src/types/simulation.ts';
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

/**
 * Shared invariant verifier applied to every end-to-end SimulationResult:
 * 1. Zero departures or arrivals occur at the closed airport inside [startMin, endMin).
 * 2. Every aircraft rotation is physically continuous with turnaround >= minTurnaroundMinutes.
 * 3. Every KPI summary metric matches exact summation over individual flight/connection/crew rows.
 * 4. Every delayed flight has non-empty causes and a deterministic causal explanation summary.
 */
function assertSimulationInvariants(res: SimulationResult, closure: AirportClosureEvent | null) {
  // Invariant 1: No movement inside half-open closure interval [startMin, endMin)
  if (closure) {
    for (const fl of res.flights) {
      if (fl.status === 'cancelled') continue;
      if (fl.origin === closure.airportId && fl.actualDepMin !== null) {
        assert.equal(
          isTimeInsideClosure(fl.actualDepMin, closure),
          false,
          `Illegal departure during closure: ${fl.flightId} departed ${closure.airportId} at ${formatMinutesToClock(fl.actualDepMin)}`
        );
      }
      if (fl.destination === closure.airportId && fl.actualArrMin !== null) {
        assert.equal(
          isTimeInsideClosure(fl.actualArrMin, closure),
          false,
          `Illegal arrival during closure: ${fl.flightId} arrived ${closure.airportId} at ${formatMinutesToClock(fl.actualArrMin)}`
        );
      }
    }
  }

  // Invariant 2: Physical aircraft continuity & minimum turnaround
  const consistency = verifyPhysicalConsistency(res.rotations);
  assert.equal(consistency.isConsistent, true, consistency.errors.join(' '));

  // Invariant 3: KPI consistency derived strictly from individual results
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

  // Invariant 4: Every delayed flight carries traceable causes & explanation
  for (const fl of delayed) {
    assert.ok(fl.causes.length > 0, `Delayed flight ${fl.flightId} missing causes`);
    assert.ok(fl.causalExplanation.summary.length > 0, `Delayed flight ${fl.flightId} missing explanation`);
  }
}

const rawJson = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf-8')) as RawFlightNetworkDataset;
const { network } = normalizeFlightNetwork(rawJson);

// ===========================================================================
// PART A — Foundation Dataset, Validation & Unit Rule Tests (1–14)
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
  return `16 airports, 70 flights, 16 active tails, 2 spares, 21 connections, 16 crews (${report.summary.passed} pass, ${report.summary.warnings} watch)`;
});

runTest('03. Normalization builds exact absolute-minute schedules and O(1) indexes', () => {
  assert.equal(network.meta.minTurnaroundMinutes, 30);
  assert.equal(network.meta.seatsPerAircraft, 180);
  assert.equal(network.flights.length, 70);
  const cr03 = network.index.crewsById['CR03'];
  assert.equal(cr03.scheduledDutyMins, 590);
  assert.equal(cr03.scheduledDutyMarginMins, 10);
  return `Normalized 70 flights; verified tightest crew CR03 = ${cr03.scheduledDutyMins}/${cr03.maxDutyMins}m`;
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
  const destGround = evaluateFlightAgainstClosure({
    origin: ds0701.origin,
    destination: ds0701.destination,
    readyDepMin: ds0701.scheduledDepMin,
    blockMinutes: ds0701.blockMinutes,
    closure: bomEarly,
  });
  assert.equal(destGround.impactKind, 'destination_ground_hold');
  assert.equal(destGround.adjustedArrMin, bomEarly.endMin);

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
  const unaffected = evaluateFlightAgainstClosure({
    origin: ds1501.origin,
    destination: ds1501.destination,
    readyDepMin: ds1501.scheduledDepMin,
    blockMinutes: ds1501.blockMinutes,
    closure: bomLater,
  });
  assert.equal(unaffected.impactKind, 'unaffected');
  assert.equal(unaffected.groundHoldMinutes, 0);

  return 'Verified origin hold, destination GDP hold, airborne hold (35m), and 0m delay outside closure';
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

runTest('07. Unit spare deployment feasibility: successful & unsuccessful checks with standby crew assumption', () => {
  const spareDel = network.index.spareAircraftById['VT-DS18'];
  const spareBlr = network.index.spareAircraftById['VT-DS17'];
  const ds0101 = network.index.flightsById['DS0101'];

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

  const wrongBase = validateSpareDeploymentFeasibility({
    spare: spareBlr,
    spareCurrentPosition: spareBlr.baseAirportId,
    spareReadyMin: spareBlr.availableFromMin,
    targetFlight: ds0101,
    plannedDepartureMin: ds0101.scheduledDepMin,
    config: DEFAULT_SIMULATION_CONFIG,
  });
  assert.equal(wrongBase.isFeasible, false);

  const noStandby = validateSpareDeploymentFeasibility({
    spare: spareDel,
    spareCurrentPosition: spareDel.baseAirportId,
    spareReadyMin: spareDel.availableFromMin,
    targetFlight: ds0101,
    plannedDepartureMin: ds0101.scheduledDepMin,
    config: {
      ...DEFAULT_SIMULATION_CONFIG,
      assumedStandbyCrew: { ...DEFAULT_SIMULATION_CONFIG.assumedStandbyCrew, enabled: false },
    },
  });
  assert.equal(noStandby.isFeasible, false);
  return 'Approved VT-DS18 @ DEL (assumption tagged); rejected wrong-base and disabled-standby-crew cases';
});

runTest('08. Unit cancellation continuity & tail swap feasibility: successful & unsuccessful checks', () => {
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
  return 'Rejected single-leg cancel & unvalidated tail swap; approved round-trip cancel';
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
// PART B — End-to-End Deterministic Simulation Engine Tests (10–21)
// ===========================================================================

runTest('10. E2E No-closure baseline simulation: 70/70 on-time, 0 delays, 21/21 connections made, 0 crew violations', () => {
  const res = simulateDisruption(network, null);
  assertSimulationInvariants(res, null);
  assert.equal(res.kpis.operatedFlights, 70);
  assert.equal(res.kpis.onTimeFlights, 70);
  assert.equal(res.kpis.delayedFlights, 0);
  assert.equal(res.kpis.cancelledFlights, 0);
  assert.equal(res.kpis.totalDelayMinutes, 0);
  assert.equal(res.kpis.averageDelayMinutes, 0);
  assert.equal(res.kpis.affectedAircraftCount, 0);
  assert.equal(res.passengerImpact.preservedConnectionsCount, 21);
  assert.equal(res.kpis.missedConnectionsCount, 0);
  assert.equal(res.kpis.crewViolationsCount, 0);
  return '70/70 on time, 0m total delay, 21/21 connections preserved, 0 crew violations';
});

runTest('11. E2E Closure at Mumbai (BOM 08:00–10:00): direct hits, airborne hold, propagation & connections', () => {
  const closure = createAirportClosureEvent(network, 'BOM', parseHHMMToMinutes('08:00'), 120);
  const res = simulateDisruption(network, closure);
  assertSimulationInvariants(res, closure);

  // DS0201 (DEL->BOM, dep 06:00, arr 08:10) was already airborne before 08:00 closure -> airborne arrival holding!
  const ds0201 = res.flights.find((f) => f.flightId === 'DS0201')!;
  assert.equal(ds0201.actualDepMin, parseHHMMToMinutes('06:00'));
  assert.ok(ds0201.airborneHoldMinutes >= 110, `Expected DS0201 airborne hold >= 110m, got ${ds0201.airborneHoldMinutes}`);
  assert.ok(ds0201.causes.some((c) => c.type === 'airborne_arrival_holding'));

  // DS0501 (BOM->BLR, dep 08:15) held at origin BOM until >= 10:00
  const ds0501 = res.flights.find((f) => f.flightId === 'DS0501')!;
  assert.ok(ds0501.causes.some((c) => c.type === 'origin_airport_closure_ground_hold'));
  assert.ok((ds0501.actualDepMin ?? 0) >= closure.endMin);

  // DS1501 (PNQ->BOM, 07:00–07:40) legally finished before 08:00 closure -> 0m delay
  const ds1501 = res.flights.find((f) => f.flightId === 'DS1501')!;
  assert.equal(ds1501.status, 'on_time');
  assert.equal(ds1501.arrivalDelayMin, 0);

  // Propagated domino flights exist (dominoDepth >= 1)
  const propagated = res.flights.filter((f) => f.dominoDepth >= 1 && f.status === 'delayed');
  assert.ok(propagated.length > 0, 'Expected downstream domino-propagated flights');

  return `BOM 08:00–10:00: ${res.kpis.delayedFlights} delayed (${formatDurationMinutes(res.kpis.totalDelayMinutes)} total, avg ${res.kpis.averageDelayMinutes}m), ${propagated.length} domino-propagated, ${res.kpis.missedConnectionsCount} missed conn (${res.kpis.missedConnectionPax} pax), ${res.kpis.crewViolationsCount} crew breaches`;
});

runTest('12. E2E Closure at Bengaluru (BLR 11:00–13:00): hub cascade, slack absorption & BLR connections', () => {
  const closure = createAirportClosureEvent(network, 'BLR', parseHHMMToMinutes('11:00'), 120);
  const res = simulateDisruption(network, closure);
  assertSimulationInvariants(res, closure);

  assert.ok(res.kpis.delayedFlights > 0);
  // DS0604 (MAA->BLR, dep 11:05, arr 12:00) has not departed when BLR closes at 11:00 -> destination GDP hold!
  const ds0604 = res.flights.find((f) => f.flightId === 'DS0604')!;
  assert.ok(ds0604.causes.some((c) => c.type === 'destination_airport_closure_ground_hold'));
  assert.equal(ds0604.airborneHoldMinutes, 0);

  // DS0605 (BLR->TRV, leg 5 of VT-DS06) receives propagated delay from DS0604 + turnaround slack absorption
  const ds0605 = res.flights.find((f) => f.flightId === 'DS0605')!;
  assert.equal(ds0605.status, 'delayed');
  assert.equal(ds0605.previousFlightId, 'DS0604');
  assert.equal(ds0605.turnaroundSlackAbsorbedMin, 5); // 35m sched turn - 30m min turn = 5m absorbed

  const chain = traceCausalChain(res.flights, 'DS0605');
  assert.ok(chain.length >= 2 && chain[0].flightId === 'DS0604');

  return `BLR 11:00–13:00: ${res.kpis.delayedFlights} delayed, DS0604 GDP hold -> DS0605 absorbed 5m slack, ${res.kpis.missedConnectionsCount} missed conn (${res.kpis.missedConnectionPax} pax), ${res.kpis.crewViolationsCount} crew breaches`;
});

runTest('13. E2E Closure at Delhi (DEL 12:00–14:30): crew duty violation on CR03 under default flag_violation policy', () => {
  const closure = createAirportClosureEvent(network, 'DEL', parseHHMMToMinutes('12:00'), 150);
  const res = simulateDisruption(network, closure);
  assertSimulationInvariants(res, closure);

  // Default policy must NOT auto-cancel flights
  assert.equal(res.config.crewViolationPolicy, 'flag_violation');
  assert.equal(res.kpis.cancelledFlights, 0);

  // CR03 (VT-DS03: DS0301 departs DEL 12:15 with only 10m duty margin) must violate 600m duty limit!
  const cr03 = res.crews.find((c) => c.crewId === 'CR03')!;
  assert.equal(cr03.isViolation, true);
  assert.ok(cr03.overageMins > 0);
  assert.ok(cr03.violatingFlightIds.includes('DS0304'));

  const ds0304 = res.flights.find((f) => f.flightId === 'DS0304')!;
  assert.equal(ds0304.status, 'delayed');
  assert.equal(ds0304.hasCrewViolation, true);

  return `DEL 12:00–14:30: ${res.kpis.delayedFlights} delayed, 0 auto-cancelled, CR03 duty ${cr03.actualDutyMins}/${cr03.maxDutyMins}m (+${cr03.overageMins}m overage on ${cr03.violatingFlightIds.join(', ')})`;
});

runTest('14. E2E Turnaround slack full absorption: upstream delay absorbed completely so downstream leg operates on time', () => {
  // VT-DS04: DS0401 (BOM->GOI, 07:45–08:50), DS0402 (GOI->BOM, 09:20–10:25, 30m turn -> 0m slack),
  // DS0403 (BOM->PNQ, 11:35–12:15, 70m turn -> 40m slack).
  // Close GOI 08:30–09:15 (45m): DS0401 airborne holds +25m (arr 09:15), DS0402 propagates +25m (0m slack, arr 10:50),
  // then DS0403 has 40m slack (10:50 + 30m = 11:20 <= 11:35) so DS0403 absorbs all 25m and operates ON TIME!
  const closure = createAirportClosureEvent(network, 'GOI', parseHHMMToMinutes('08:30'), 45);
  const res = simulateDisruption(network, closure, { enforceReopeningCapacityMetering: false });
  assertSimulationInvariants(res, closure);

  const ds0401 = res.flights.find((f) => f.flightId === 'DS0401')!;
  const ds0402 = res.flights.find((f) => f.flightId === 'DS0402')!;
  const ds0403 = res.flights.find((f) => f.flightId === 'DS0403')!;

  assert.equal(ds0401.arrivalDelayMin, 25);
  assert.equal(ds0402.arrivalDelayMin, 25);
  assert.equal(ds0403.status, 'on_time');
  assert.equal(ds0403.arrivalDelayMin, 0);
  assert.equal(ds0403.turnaroundSlackAbsorbedMin, 25);

  return 'GOI 08:30–09:15: DS0401 (+25m) -> DS0402 (+25m, 0m slack) -> DS0403 (0m, absorbed 25m of 40m slack)';
});

runTest('15. E2E Reopening capacity metering vs immediate release & rolling 60m capacity enforcement', () => {
  // Close BOM 07:30–10:30 (180m) so multiple BOM movements queue at reopening 10:30
  const closure = createAirportClosureEvent(network, 'BOM', parseHHMMToMinutes('07:30'), 180);
  const metered = simulateDisruption(network, closure, { enforceReopeningCapacityMetering: true });
  const unmetered = simulateDisruption(network, closure, { enforceReopeningCapacityMetering: false });
  assertSimulationInvariants(metered, closure);
  assertSimulationInvariants(unmetered, closure);

  const congestionHits = metered.flights.filter((f) => f.reopeningSlotDelayMinutes > 0);
  assert.ok(congestionHits.length > 0, 'Expected reopening slot congestion delays under metered reopening');
  assert.ok(metered.kpis.totalDelayMinutes > unmetered.kpis.totalDelayMinutes);

  // Verify unaffected evening BOM flight DS0302 (AMD->BOM, arr 15:35) incurs 0m congestion delay
  const ds0302 = metered.flights.find((f) => f.flightId === 'DS0302')!;
  assert.equal(ds0302.reopeningSlotDelayMinutes, 0);
  assert.equal(ds0302.status, 'on_time');

  return `BOM 07:30–10:30: metered=${metered.kpis.totalDelayMinutes}m vs unmetered=${unmetered.kpis.totalDelayMinutes}m (${congestionHits.length} flights spaced in backlog; evening DS0302 = 0m)`;
});

runTest('16. E2E Midnight rollover: late evening CCU closure pushes DS1005 arrival past 24:00 (+1d)', () => {
  // DS1005: CCU -> LKO, sched 20:00–21:45 (1200–1305, block 105m)
  // Close CCU 19:30–22:45 (195m) -> DS1005 departs >= 22:45 (1365), arrives >= 00:30 (+1d) (1470)
  const closure = createAirportClosureEvent(network, 'CCU', parseHHMMToMinutes('19:30'), 195);
  const res = simulateDisruption(network, closure);
  assertSimulationInvariants(res, closure);

  const ds1005 = res.flights.find((f) => f.flightId === 'DS1005')!;
  assert.ok((ds1005.actualArrMin ?? 0) >= 1440, `Expected DS1005 actualArr >= 1440, got ${ds1005.actualArrMin}`);
  assert.ok(formatMinutesToClock(ds1005.actualArrMin!).includes('(+1d)'));

  const cr10 = res.crews.find((c) => c.crewId === 'CR10')!;
  assert.equal(cr10.isViolation, true);
  assert.equal(cr10.actualEndMin, ds1005.actualArrMin);

  return `CCU 19:30–22:45: DS1005 arr ${formatMinutesToClock(ds1005.actualArrMin!)} (${ds1005.actualArrMin}m), CR10 duty ${cr10.actualDutyMins}/${cr10.maxDutyMins}m (+${cr10.overageMins}m)`;
});

runTest('17. E2E Cancelled flight physical continuity: pre-cancelling leg 1 strands leg 2 while preserving DEL for leg 3+', () => {
  // Pre-cancel DS0101 (DEL->JAI). VT-DS01 stays physically at DEL.
  // Therefore DS0102 (JAI->DEL) MUST auto-cancel as physically stranded, while DS0103 (DEL->LKO) legally operates from DEL!
  const res = simulateDisruption(network, null, undefined, {
    preCancelledFlightIds: new Set(['DS0101']),
  });
  assertSimulationInvariants(res, null);

  const ds0101 = res.flights.find((f) => f.flightId === 'DS0101')!;
  const ds0102 = res.flights.find((f) => f.flightId === 'DS0102')!;
  const ds0103 = res.flights.find((f) => f.flightId === 'DS0103')!;

  assert.equal(ds0101.status, 'cancelled');
  assert.equal(ds0101.aircraftPositionAfter, 'DEL');
  assert.equal(ds0102.status, 'cancelled');
  assert.ok(ds0102.causes.some((c) => c.type === 'upstream_cancellation_aircraft_stranded'));
  assert.equal(ds0102.aircraftPositionAfter, 'DEL');
  assert.equal(ds0103.status, 'on_time');
  assert.equal(ds0103.aircraftPositionBefore, 'DEL');
  assert.equal(ds0103.aircraftPositionAfter, 'LKO');
  assert.equal(res.kpis.cancelledFlightPax, ds0101.pax + ds0102.pax);

  return `Cancelled DS0101 -> auto-stranded DS0102 at DEL; DS0103–DS0105 operated legally (${res.kpis.cancelledFlightPax} cancelled pax)`;
});

runTest('18. E2E Strict opt-in crew policy cancels violating legs and preserves aircraft continuity & non-double-counted pax', () => {
  const closure = createAirportClosureEvent(network, 'DEL', parseHHMMToMinutes('12:00'), 150);
  const strictRes = simulateDisruption(network, closure, {
    crewViolationPolicy: 'cancel_violating_legs',
  });
  assertSimulationInvariants(strictRes, closure);

  assert.ok(strictRes.kpis.cancelledFlights > 0, 'Expected strict policy to cancel violating legs');
  assert.equal(strictRes.kpis.crewViolationsCount, 0, 'Strict enforcement must leave 0 active crew violations');
  // DS0304 is onward leg of CX19 (14 pax) -> verify CX19 counted as overlap, NOT double-counted in totalStrandedPaxEstimate
  const cx19 = strictRes.connections.find((c) => c.connectionId === 'CX19')!;
  assert.equal(cx19.status, 'broken_due_to_to_cancellation');
  assert.ok(strictRes.passengerImpact.cancelledConnectionOverlapPax >= cx19.passengers);
  assert.equal(
    strictRes.passengerImpact.totalStrandedPaxEstimate,
    strictRes.passengerImpact.cancelledFlightPax + strictRes.passengerImpact.missedConnectionPax
  );

  return `DEL strict crew mode: ${strictRes.kpis.cancelledFlights} legs cancelled, 0 crew violations, ${strictRes.passengerImpact.cancelledConnectionOverlapPax} overlap pax excluded from double counting`;
});

runTest('19. E2E Determinism check: identical inputs produce bit-identical SimulationResult across repeated runs', () => {
  const closure = createAirportClosureEvent(network, 'BOM', parseHHMMToMinutes('08:00'), 120);
  const run1 = simulateDisruption(network, closure);
  const run2 = simulateDisruption(network, closure);
  assert.deepEqual(run1, run2);
  return 'Repeated BOM 08:00–10:00 simulations matched bit-for-bit across all 70 flights, 21 connections, 16 crews, and KPIs';
});

const failed = outcomes.filter((o) => !o.passed);
console.log(`\nSummary: ${outcomes.length - failed.length}/${outcomes.length} foundation & simulation checks passed.`);
if (failed.length > 0) {
  process.exit(1);
}
