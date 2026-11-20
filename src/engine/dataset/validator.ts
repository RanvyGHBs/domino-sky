/**
 * Domino Sky — Official Dataset Validator
 *
 * Runs deterministic referential-integrity and operational-consistency checks
 * on the official flight_network.json dataset. Every check executes real logic
 * against the loaded data — zero hardcoded pass states.
 */

import type {
  AirportTier,
  DatasetValidationReport,
  RawFlightNetworkDataset,
  ValidationCheckResult,
} from '../../types/dataset.ts';
import { formatMinutesToClock, isValidHHMM, parseHHMMToMinutes } from '../time.ts';

const VALID_TIERS: ReadonlySet<string> = new Set<AirportTier>([
  'mega_hub',
  'regional_hub',
  'spoke',
]);

function makeCheck(
  id: string,
  category: ValidationCheckResult['category'],
  label: string,
  errors: string[],
  warnings: string[],
  passSummary: string
): ValidationCheckResult {
  if (errors.length > 0) {
    return {
      id,
      category,
      label,
      severity: 'error',
      summary: `${errors.length} integrity error${errors.length === 1 ? '' : 's'} detected`,
      details: errors,
    };
  }
  if (warnings.length > 0) {
    return {
      id,
      category,
      label,
      severity: 'warning',
      summary: `${warnings.length} operational note${warnings.length === 1 ? '' : 's'} flagged`,
      details: warnings,
    };
  }
  return {
    id,
    category,
    label,
    severity: 'pass',
    summary: passSummary,
    details: [],
  };
}

export function validateRawFlightNetwork(raw: RawFlightNetworkDataset): DatasetValidationReport {
  const checks: ValidationCheckResult[] = [];

  // 1. Schema & metadata check
  {
    const errors: string[] = [];
    if (!raw || typeof raw !== 'object') {
      errors.push('Dataset root is not a valid JSON object.');
    }
    if (!raw.meta) {
      errors.push('Missing top-level "meta" object.');
    } else {
      if (typeof raw.meta.min_turnaround_minutes !== 'number' || raw.meta.min_turnaround_minutes <= 0) {
        errors.push(`Invalid meta.min_turnaround_minutes: ${String(raw.meta.min_turnaround_minutes)}`);
      }
      if (typeof raw.meta.seats_per_aircraft !== 'number' || raw.meta.seats_per_aircraft <= 0) {
        errors.push(`Invalid meta.seats_per_aircraft: ${String(raw.meta.seats_per_aircraft)}`);
      }
    }
    if (!Array.isArray(raw.airports)) errors.push('Missing "airports" array.');
    if (!Array.isArray(raw.flights)) errors.push('Missing "flights" array.');
    if (!Array.isArray(raw.connections)) errors.push('Missing "connections" array.');
    if (!Array.isArray(raw.crews)) errors.push('Missing "crews" array.');
    if (!Array.isArray(raw.spare_aircraft)) errors.push('Missing "spare_aircraft" array.');

    checks.push(
      makeCheck(
        'CHK-SCHEMA',
        'schema',
        'Dataset Schema & Operational Metadata',
        errors,
        [],
        `Verified meta rules: min turnaround ${raw.meta?.min_turnaround_minutes ?? '?'} min, aircraft capacity ${raw.meta?.seats_per_aircraft ?? '?'} seats`
      )
    );
  }

  const airports = Array.isArray(raw.airports) ? raw.airports : [];
  const flights = Array.isArray(raw.flights) ? raw.flights : [];
  const connections = Array.isArray(raw.connections) ? raw.connections : [];
  const crews = Array.isArray(raw.crews) ? raw.crews : [];
  const spares = Array.isArray(raw.spare_aircraft) ? raw.spare_aircraft : [];
  const minTurnaround = raw.meta?.min_turnaround_minutes ?? 30;
  const maxSeats = raw.meta?.seats_per_aircraft ?? 180;

  // 2. Airport uniqueness, coordinates, tiers & capacities
  const airportIds = new Set<string>();
  {
    const errors: string[] = [];
    for (const ap of airports) {
      if (!ap.id || !/^[A-Z]{3}$/.test(ap.id)) {
        errors.push(`Invalid IATA airport id: "${ap.id}"`);
      } else if (airportIds.has(ap.id)) {
        errors.push(`Duplicate airport id: "${ap.id}"`);
      } else {
        airportIds.add(ap.id);
      }
      if (!VALID_TIERS.has(ap.tier)) {
        errors.push(`Airport ${ap.id} has invalid tier "${String(ap.tier)}"`);
      }
      if (typeof ap.lat !== 'number' || ap.lat < -90 || ap.lat > 90) {
        errors.push(`Airport ${ap.id} has out-of-range latitude ${String(ap.lat)}`);
      }
      if (typeof ap.lng !== 'number' || ap.lng < -180 || ap.lng > 180) {
        errors.push(`Airport ${ap.id} has out-of-range longitude ${String(ap.lng)}`);
      }
      if (typeof ap.capacity_per_hour !== 'number' || ap.capacity_per_hour <= 0) {
        errors.push(`Airport ${ap.id} has invalid capacity_per_hour ${String(ap.capacity_per_hour)}`);
      }
    }
    const tierCounts = airports.reduce<Record<string, number>>((acc, a) => {
      acc[a.tier] = (acc[a.tier] ?? 0) + 1;
      return acc;
    }, {});
    checks.push(
      makeCheck(
        'CHK-AIRPORTS',
        'airports',
        'Airport Registry, Coordinates & Capacity',
        errors,
        [],
        `${airports.length} unique airports validated (${tierCounts.mega_hub ?? 0} mega hubs, ${tierCounts.regional_hub ?? 0} regional hubs, ${tierCounts.spoke ?? 0} spokes)`
      )
    );
  }

  // 3. Flight IDs, airport refs, HH:MM timing, block minutes, seat bounds
  const flightById = new Map<string, (typeof flights)[number]>();
  const flightsByTail = new Map<string, Array<(typeof flights)[number]>>();
  let earliestActivityMin = Number.POSITIVE_INFINITY;
  let latestArrivalMin = 0;

  {
    const errors: string[] = [];
    for (const fl of flights) {
      if (flightById.has(fl.flight_id)) {
        errors.push(`Duplicate flight_id: ${fl.flight_id}`);
      } else {
        flightById.set(fl.flight_id, fl);
      }

      if (!airportIds.has(fl.origin)) {
        errors.push(`Flight ${fl.flight_id} references unknown origin "${fl.origin}"`);
      }
      if (!airportIds.has(fl.destination)) {
        errors.push(`Flight ${fl.flight_id} references unknown destination "${fl.destination}"`);
      }
      if (fl.origin === fl.destination) {
        errors.push(`Flight ${fl.flight_id} has identical origin and destination (${fl.origin})`);
      }

      if (!isValidHHMM(fl.dep) || !isValidHHMM(fl.arr)) {
        errors.push(`Flight ${fl.flight_id} has invalid HH:MM time (dep="${fl.dep}", arr="${fl.arr}")`);
      } else {
        const depMin = parseHHMMToMinutes(fl.dep);
        const arrMin = parseHHMMToMinutes(fl.arr);
        if (depMin < earliestActivityMin) earliestActivityMin = depMin;
        if (arrMin > latestArrivalMin) latestArrivalMin = arrMin;

        const computedBlock = arrMin - depMin;
        if (computedBlock !== fl.block_minutes || fl.block_minutes <= 0) {
          errors.push(
            `Flight ${fl.flight_id} block_minutes mismatch: arr(${fl.arr}) - dep(${fl.dep}) = ${computedBlock}m, recorded ${fl.block_minutes}m`
          );
        }
      }

      if (fl.pax < 0 || fl.pax > maxSeats) {
        errors.push(`Flight ${fl.flight_id} passenger load (${fl.pax}) exceeds seat capacity (${maxSeats})`);
      }

      const list = flightsByTail.get(fl.tail_id) ?? [];
      list.push(fl);
      flightsByTail.set(fl.tail_id, list);
    }

    checks.push(
      makeCheck(
        'CHK-FLIGHTS',
        'flights',
        'Flight References, Block Durations & Seat Capacity',
        errors,
        [],
        `All ${flights.length} flights verified across ${flightsByTail.size} active aircraft (0 capacity or block-time mismatches)`
      )
    );
  }

  // 4. Aircraft rotation leg ordering, geographic continuity, and turnaround consistency
  {
    const errors: string[] = [];
    let tightestTurnaround = Number.POSITIVE_INFINITY;
    let tightestFlightId = '';

    for (const [tailId, tailFlights] of flightsByTail.entries()) {
      const sorted = [...tailFlights].sort((a, b) => a.leg_order - b.leg_order);
      for (let i = 0; i < sorted.length; i++) {
        const leg = sorted[i];
        const expectedOrder = i + 1;
        if (leg.leg_order !== expectedOrder) {
          errors.push(
            `Aircraft ${tailId} has non-sequential leg_order on ${leg.flight_id} (expected ${expectedOrder}, got ${leg.leg_order})`
          );
        }
        if (i === 0) {
          if (leg.turnaround_before_min !== null) {
            errors.push(
              `Aircraft ${tailId} first leg ${leg.flight_id} should have turnaround_before_min = null (got ${String(leg.turnaround_before_min)})`
            );
          }
        } else {
          const prev = sorted[i - 1];
          if (leg.origin !== prev.destination) {
            errors.push(
              `Aircraft ${tailId} geographic discontinuity: ${prev.flight_id} arrives ${prev.destination} but ${leg.flight_id} departs ${leg.origin}`
            );
          }
          if (isValidHHMM(prev.arr) && isValidHHMM(leg.dep)) {
            const actualGap = parseHHMMToMinutes(leg.dep) - parseHHMMToMinutes(prev.arr);
            if (leg.turnaround_before_min !== actualGap) {
              errors.push(
                `Aircraft ${tailId} turnaround mismatch on ${leg.flight_id}: computed ${actualGap}m vs recorded ${String(leg.turnaround_before_min)}m`
              );
            }
            if (actualGap < minTurnaround) {
              errors.push(
                `Aircraft ${tailId} violates min turnaround (${minTurnaround}m) before ${leg.flight_id}: only ${actualGap}m`
              );
            }
            if (actualGap < tightestTurnaround) {
              tightestTurnaround = actualGap;
              tightestFlightId = leg.flight_id;
            }
          }
        }
      }
    }

    checks.push(
      makeCheck(
        'CHK-ROTATIONS',
        'rotations',
        'Aircraft Rotation Continuity & Minimum Turnaround',
        errors,
        [],
        `All ${flightsByTail.size} rotations geographically continuous; tightest scheduled turnaround is ${tightestTurnaround}m (${tightestFlightId}, min ${minTurnaround}m)`
      )
    );
  }

  // 5. Passenger connection referential integrity, MCT feasibility & passenger load bounds
  {
    const errors: string[] = [];
    const seenConnIds = new Set<string>();
    const outgoingPaxByFlight = new Map<string, number>();
    const incomingPaxByFlight = new Map<string, number>();
    let tightestConnectMargin = Number.POSITIVE_INFINITY;
    let tightestConnId = '';

    for (const conn of connections) {
      if (seenConnIds.has(conn.connection_id)) {
        errors.push(`Duplicate connection_id: ${conn.connection_id}`);
      } else {
        seenConnIds.add(conn.connection_id);
      }

      if (!airportIds.has(conn.airport)) {
        errors.push(`Connection ${conn.connection_id} references unknown airport "${conn.airport}"`);
      }

      const fromFl = flightById.get(conn.from_flight);
      const toFl = flightById.get(conn.to_flight);
      if (!fromFl) {
        errors.push(`Connection ${conn.connection_id} references unknown from_flight "${conn.from_flight}"`);
      }
      if (!toFl) {
        errors.push(`Connection ${conn.connection_id} references unknown to_flight "${conn.to_flight}"`);
      }
      if (conn.from_flight === conn.to_flight) {
        errors.push(`Connection ${conn.connection_id} links a flight to itself (${conn.from_flight})`);
      }

      if (fromFl && toFl) {
        if (fromFl.destination !== conn.airport) {
          errors.push(
            `Connection ${conn.connection_id} airport mismatch: ${fromFl.flight_id} arrives at ${fromFl.destination}, expected ${conn.airport}`
          );
        }
        if (toFl.origin !== conn.airport) {
          errors.push(
            `Connection ${conn.connection_id} airport mismatch: ${toFl.flight_id} departs from ${toFl.origin}, expected ${conn.airport}`
          );
        }
        if (isValidHHMM(fromFl.arr) && isValidHHMM(toFl.dep)) {
          const schedConnect = parseHHMMToMinutes(toFl.dep) - parseHHMMToMinutes(fromFl.arr);
          if (schedConnect < conn.min_connect_minutes) {
            errors.push(
              `Connection ${conn.connection_id} is infeasible even on schedule: ${schedConnect}m < MCT ${conn.min_connect_minutes}m`
            );
          }
          const margin = schedConnect - conn.min_connect_minutes;
          if (margin < tightestConnectMargin) {
            tightestConnectMargin = margin;
            tightestConnId = conn.connection_id;
          }
        }
      }

      if (conn.passengers <= 0) {
        errors.push(`Connection ${conn.connection_id} has non-positive passenger count (${conn.passengers})`);
      }
      outgoingPaxByFlight.set(
        conn.from_flight,
        (outgoingPaxByFlight.get(conn.from_flight) ?? 0) + conn.passengers
      );
      incomingPaxByFlight.set(
        conn.to_flight,
        (incomingPaxByFlight.get(conn.to_flight) ?? 0) + conn.passengers
      );
    }

    for (const [fId, sumPax] of outgoingPaxByFlight.entries()) {
      const fl = flightById.get(fId);
      if (fl && sumPax > fl.pax) {
        errors.push(
          `Flight ${fId} has ${sumPax} outgoing connecting passengers exceeding its total pax (${fl.pax})`
        );
      }
    }
    for (const [fId, sumPax] of incomingPaxByFlight.entries()) {
      const fl = flightById.get(fId);
      if (fl && sumPax > fl.pax) {
        errors.push(
          `Flight ${fId} has ${sumPax} incoming connecting passengers exceeding its total pax (${fl.pax})`
        );
      }
    }

    checks.push(
      makeCheck(
        'CHK-CONNECTIONS',
        'connections',
        'Passenger Connection Links, MCT & Load Bounds',
        errors,
        [],
        `All ${connections.length} connections valid and feasible; tightest MCT slack is ${tightestConnectMargin}m (${tightestConnId})`
      )
    );
  }

  // 6. Crew rosters, tail alignment, base matching, and baseline duty limits
  {
    const errors: string[] = [];
    const warnings: string[] = [];
    const seenCrewIds = new Set<string>();
    const assignedTails = new Set<string>();
    let tightestCrewId = '';
    let tightestMargin = Number.POSITIVE_INFINITY;

    for (const cr of crews) {
      if (seenCrewIds.has(cr.crew_id)) {
        errors.push(`Duplicate crew_id: ${cr.crew_id}`);
      } else {
        seenCrewIds.add(cr.crew_id);
      }
      if (!airportIds.has(cr.base)) {
        errors.push(`Crew ${cr.crew_id} references unknown base airport "${cr.base}"`);
      }
      if (assignedTails.has(cr.tail_id)) {
        errors.push(`Multiple crews assigned to tail ${cr.tail_id}`);
      } else {
        assignedTails.add(cr.tail_id);
      }

      const tailFlights = flightsByTail.get(cr.tail_id);
      if (!tailFlights) {
        errors.push(`Crew ${cr.crew_id} assigned to unknown tail "${cr.tail_id}"`);
        continue;
      }

      const expectedIds = [...tailFlights]
        .sort((a, b) => a.leg_order - b.leg_order)
        .map((f) => f.flight_id);

      if (
        cr.flight_ids.length !== expectedIds.length ||
        cr.flight_ids.some((id, idx) => id !== expectedIds[idx])
      ) {
        errors.push(
          `Crew ${cr.crew_id} flight_ids [${cr.flight_ids.join(', ')}] do not match ordered rotation for ${cr.tail_id} [${expectedIds.join(', ')}]`
        );
      }

      const firstFl = flightById.get(cr.flight_ids[0]);
      const lastFl = flightById.get(cr.flight_ids[cr.flight_ids.length - 1]);

      if (firstFl && cr.base !== firstFl.origin) {
        errors.push(
          `Crew ${cr.crew_id} base (${cr.base}) does not match first flight ${firstFl.flight_id} origin (${firstFl.origin})`
        );
      }

      if (!isValidHHMM(cr.duty_start)) {
        errors.push(`Crew ${cr.crew_id} has invalid duty_start "${cr.duty_start}"`);
      } else if (firstFl && lastFl && isValidHHMM(firstFl.dep) && isValidHHMM(lastFl.arr)) {
        const dutyStartMin = parseHHMMToMinutes(cr.duty_start);
        if (dutyStartMin < earliestActivityMin) earliestActivityMin = dutyStartMin;
        const firstDepMin = parseHHMMToMinutes(firstFl.dep);
        const lastArrMin = parseHHMMToMinutes(lastFl.arr);

        if (dutyStartMin > firstDepMin) {
          errors.push(
            `Crew ${cr.crew_id} duty_start (${cr.duty_start}) is after first departure (${firstFl.dep})`
          );
        }
        const scheduledDuty = lastArrMin - dutyStartMin;
        const margin = cr.max_duty_mins - scheduledDuty;
        if (scheduledDuty > cr.max_duty_mins) {
          errors.push(
            `Crew ${cr.crew_id} exceeds max_duty_mins on baseline schedule (${scheduledDuty}m > ${cr.max_duty_mins}m)`
          );
        } else if (margin <= 30) {
          warnings.push(
            `Crew ${cr.crew_id} (${cr.tail_id}) has only ${margin}m baseline duty margin (${scheduledDuty}/${cr.max_duty_mins}m) — high risk of violation under small delays.`
          );
        }
        if (margin < tightestMargin) {
          tightestMargin = margin;
          tightestCrewId = cr.crew_id;
        }
      }
    }

    for (const tailId of flightsByTail.keys()) {
      if (!assignedTails.has(tailId)) {
        errors.push(`Active aircraft ${tailId} has no assigned crew record`);
      }
    }

    checks.push(
      makeCheck(
        'CHK-CREWS',
        'crews',
        'Crew Roster Assignment, Base Alignment & Duty Margins',
        errors,
        warnings,
        `All ${crews.length} crews match active aircraft rotations; tightest duty margin is ${tightestMargin}m (${tightestCrewId})`
      )
    );
  }

  // 7. Spare aircraft validation
  {
    const errors: string[] = [];
    const seenSpareIds = new Set<string>();

    for (const sp of spares) {
      if (seenSpareIds.has(sp.tail_id)) {
        errors.push(`Duplicate spare tail_id: ${sp.tail_id}`);
      } else {
        seenSpareIds.add(sp.tail_id);
      }
      if (flightsByTail.has(sp.tail_id)) {
        errors.push(`Spare aircraft ${sp.tail_id} collides with an active scheduled tail_id`);
      }
      if (!airportIds.has(sp.base)) {
        errors.push(`Spare aircraft ${sp.tail_id} has unknown base airport "${sp.base}"`);
      }
      if (!isValidHHMM(sp.available_from)) {
        errors.push(`Spare aircraft ${sp.tail_id} has invalid available_from "${sp.available_from}"`);
      }
      if (typeof sp.seats !== 'number' || sp.seats <= 0) {
        errors.push(`Spare aircraft ${sp.tail_id} has invalid seats count (${String(sp.seats)})`);
      }
    }

    checks.push(
      makeCheck(
        'CHK-SPARES',
        'spares',
        'Spare Aircraft Positioning, Availability & Capacity',
        errors,
        [],
        `${spares.length} spare aircraft validated (${spares.map((s) => `${s.tail_id} @ ${s.base} from ${s.available_from}`).join(', ')})`
      )
    );
  }

  const passed = checks.filter((c) => c.severity === 'pass').length;
  const warningsCount = checks.filter((c) => c.severity === 'warning').length;
  const errorsCount = checks.filter((c) => c.severity === 'error').length;

  const totalScheduledPaxTrips = flights.reduce((sum, fl) => sum + fl.pax, 0);
  const totalConnectingPax = connections.reduce((sum, c) => sum + c.passengers, 0);

  const safeEarliest = Number.isFinite(earliestActivityMin) ? earliestActivityMin : 0;

  return {
    isValid: errorsCount === 0,
    checkedAtIso: new Date().toISOString(),
    counts: {
      airports: airports.length,
      flights: flights.length,
      activeAircraft: flightsByTail.size,
      spareAircraft: spares.length,
      connections: connections.length,
      crews: crews.length,
      totalScheduledPaxTrips,
      totalConnectingPax,
    },
    operatingWindow: {
      earliestActivityMin: safeEarliest,
      earliestActivityStr: formatMinutesToClock(safeEarliest),
      latestArrivalMin,
      latestArrivalStr: formatMinutesToClock(latestArrivalMin),
    },
    summary: {
      passed,
      warnings: warningsCount,
      errors: errorsCount,
    },
    checks,
  };
}
