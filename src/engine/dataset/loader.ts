/**
 * Domino Sky — Official Dataset Loader & Normalizer
 *
 * Single source of truth: /public/assets/aistudio/flight_network_78529dd1.json
 * Normalizes HH:MM strings to absolute minutes and constructs O(1) index maps
 * used by the deterministic simulation engine.
 */

import type {
  AircraftRecord,
  Airport,
  CrewRecord,
  DatasetValidationReport,
  NormalizedFlightNetwork,
  PassengerConnection,
  RawFlightNetworkDataset,
  ScheduledFlight,
} from '../../types/dataset.ts';
import { parseHHMMToMinutes } from '../time.ts';
import { validateRawFlightNetwork } from './validator.ts';

export const OFFICIAL_DATASET_PUBLIC_URL = '/assets/aistudio/flight_network_78529dd1.json';

export interface LoadedDatasetBundle {
  raw: RawFlightNetworkDataset;
  network: NormalizedFlightNetwork;
  validation: DatasetValidationReport;
}

/**
 * Validates and normalizes a raw JSON dataset object into absolute-minute domain structures.
 * Throws if fatal schema or referential errors prevent safe normalization.
 */
export function normalizeFlightNetwork(raw: RawFlightNetworkDataset): LoadedDatasetBundle {
  const validation = validateRawFlightNetwork(raw);
  if (!validation.isValid) {
    const firstErrors = validation.checks
      .filter((c) => c.severity === 'error')
      .flatMap((c) => c.details)
      .slice(0, 5)
      .join('; ');
    throw new Error(`Official dataset validation failed: ${firstErrors}`);
  }

  const airports: Airport[] = raw.airports.map((a) => ({
    id: a.id,
    name: a.name,
    city: a.city,
    lat: a.lat,
    lng: a.lng,
    tier: a.tier,
    capacityPerHour: a.capacity_per_hour,
  }));

  const airportsById: Record<string, Airport> = {};
  for (const ap of airports) {
    airportsById[ap.id] = ap;
  }

  const flights: ScheduledFlight[] = raw.flights.map((f) => ({
    flightId: f.flight_id,
    tailId: f.tail_id,
    legOrder: f.leg_order,
    origin: f.origin,
    destination: f.destination,
    scheduledDepStr: f.dep,
    scheduledArrStr: f.arr,
    scheduledDepMin: parseHHMMToMinutes(f.dep),
    scheduledArrMin: parseHHMMToMinutes(f.arr),
    blockMinutes: f.block_minutes,
    pax: f.pax,
    turnaroundBeforeMin: f.turnaround_before_min,
  }));

  const flightsById: Record<string, ScheduledFlight> = {};
  const flightsByTailId: Record<string, ScheduledFlight[]> = {};

  for (const fl of flights) {
    flightsById[fl.flightId] = fl;
    if (!flightsByTailId[fl.tailId]) {
      flightsByTailId[fl.tailId] = [];
    }
    flightsByTailId[fl.tailId].push(fl);
  }

  for (const tailId of Object.keys(flightsByTailId)) {
    flightsByTailId[tailId].sort((a, b) => a.legOrder - b.legOrder);
  }

  const activeAircraft: AircraftRecord[] = Object.keys(flightsByTailId)
    .sort()
    .map((tailId) => {
      const legs = flightsByTailId[tailId];
      return {
        tailId,
        seats: raw.meta.seats_per_aircraft,
        isSpare: false,
        baseAirportId: legs[0].origin,
        availableFromMin: 0,
        availableFromStr: '00:00',
        scheduledFlightIds: legs.map((l) => l.flightId),
      };
    });

  const spareAircraft: AircraftRecord[] = raw.spare_aircraft.map((sp) => ({
    tailId: sp.tail_id,
    seats: sp.seats,
    isSpare: true,
    baseAirportId: sp.base,
    availableFromMin: parseHHMMToMinutes(sp.available_from),
    availableFromStr: sp.available_from,
    scheduledFlightIds: [],
  }));

  const spareAircraftById: Record<string, AircraftRecord> = {};
  for (const sp of spareAircraft) {
    spareAircraftById[sp.tailId] = sp;
  }

  const connections: PassengerConnection[] = raw.connections.map((c) => {
    const fromFl = flightsById[c.from_flight];
    const toFl = flightsById[c.to_flight];
    return {
      connectionId: c.connection_id,
      airportId: c.airport,
      fromFlightId: c.from_flight,
      toFlightId: c.to_flight,
      passengers: c.passengers,
      minConnectMinutes: c.min_connect_minutes,
      scheduledConnectMinutes: toFl.scheduledDepMin - fromFl.scheduledArrMin,
    };
  });

  const connectionsByFromFlight: Record<string, PassengerConnection[]> = {};
  const connectionsByToFlight: Record<string, PassengerConnection[]> = {};
  for (const conn of connections) {
    if (!connectionsByFromFlight[conn.fromFlightId]) {
      connectionsByFromFlight[conn.fromFlightId] = [];
    }
    connectionsByFromFlight[conn.fromFlightId].push(conn);

    if (!connectionsByToFlight[conn.toFlightId]) {
      connectionsByToFlight[conn.toFlightId] = [];
    }
    connectionsByToFlight[conn.toFlightId].push(conn);
  }

  const crews: CrewRecord[] = raw.crews.map((cr) => {
    const dutyStartMin = parseHHMMToMinutes(cr.duty_start);
    const lastFlight = flightsById[cr.flight_ids[cr.flight_ids.length - 1]];
    const scheduledDutyMins = lastFlight.scheduledArrMin - dutyStartMin;
    return {
      crewId: cr.crew_id,
      tailId: cr.tail_id,
      baseAirportId: cr.base,
      dutyStartStr: cr.duty_start,
      dutyStartMin,
      maxDutyMins: cr.max_duty_mins,
      flightIds: [...cr.flight_ids],
      scheduledDutyMins,
      scheduledDutyMarginMins: cr.max_duty_mins - scheduledDutyMins,
    };
  });

  const crewsById: Record<string, CrewRecord> = {};
  const crewByTailId: Record<string, CrewRecord> = {};
  for (const cr of crews) {
    crewsById[cr.crewId] = cr;
    crewByTailId[cr.tailId] = cr;
  }

  const network: NormalizedFlightNetwork = {
    meta: {
      dataset: raw.meta.dataset,
      operatingDay: raw.meta.operating_day,
      minTurnaroundMinutes: raw.meta.min_turnaround_minutes,
      seatsPerAircraft: raw.meta.seats_per_aircraft,
      notes: [...raw.meta.notes],
    },
    airports,
    flights,
    activeAircraft,
    spareAircraft,
    connections,
    crews,
    index: {
      airportsById,
      flightsById,
      flightsByTailId,
      crewsById,
      crewByTailId,
      connectionsByFromFlight,
      connectionsByToFlight,
      spareAircraftById,
    },
  };

  return { raw, network, validation };
}

/**
 * Browser-safe loader fetching the official JSON asset directly from public/.
 */
export async function fetchOfficialFlightNetwork(
  url: string = OFFICIAL_DATASET_PUBLIC_URL
): Promise<LoadedDatasetBundle> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Failed to fetch official flight network dataset (${response.status} ${response.statusText})`);
  }
  const raw = (await response.json()) as RawFlightNetworkDataset;
  return normalizeFlightNetwork(raw);
}
