/**
 * Domino Sky — Official Dataset Models
 *
 * Raw interfaces mirror /public/assets/aistudio/flight_network_78529dd1.json verbatim.
 * Normalized interfaces convert all HH:MM strings into absolute minutes from 00:00 IST
 * so calculations extending past midnight (e.g. 24:35 / +1d) remain exact and unambiguous.
 */

export type AirportTier = 'mega_hub' | 'regional_hub' | 'spoke';

export interface RawDatasetMeta {
  dataset: string;
  operating_day: string;
  min_turnaround_minutes: number;
  seats_per_aircraft: number;
  notes: string[];
}

export interface RawAirport {
  id: string;
  name: string;
  city: string;
  lat: number;
  lng: number;
  tier: AirportTier;
  capacity_per_hour: number;
}

export interface RawFlight {
  flight_id: string;
  tail_id: string;
  leg_order: number;
  origin: string;
  destination: string;
  dep: string; // HH:MM (24-hour local IST)
  arr: string; // HH:MM (24-hour local IST)
  block_minutes: number;
  pax: number;
  turnaround_before_min: number | null;
}

export interface RawConnection {
  connection_id: string;
  airport: string;
  from_flight: string;
  to_flight: string;
  passengers: number;
  min_connect_minutes: number;
}

export interface RawCrew {
  crew_id: string;
  tail_id: string;
  base: string;
  duty_start: string; // HH:MM
  max_duty_mins: number;
  flight_ids: string[];
}

export interface RawSpareAircraft {
  tail_id: string;
  base: string;
  available_from: string; // HH:MM
  seats: number;
}

export interface RawFlightNetworkDataset {
  meta: RawDatasetMeta;
  airports: RawAirport[];
  flights: RawFlight[];
  connections: RawConnection[];
  crews: RawCrew[];
  spare_aircraft: RawSpareAircraft[];
}

// ---------------------------------------------------------------------------
// Normalized Domain Models (Absolute Minutes Internal Representation)
// ---------------------------------------------------------------------------

export interface Airport {
  id: string;
  name: string;
  city: string;
  lat: number;
  lng: number;
  tier: AirportTier;
  capacityPerHour: number;
}

export interface ScheduledFlight {
  flightId: string;
  tailId: string;
  legOrder: number;
  origin: string;
  destination: string;
  scheduledDepStr: string;
  scheduledArrStr: string;
  /** Absolute minutes from 00:00 IST on operating day */
  scheduledDepMin: number;
  /** Absolute minutes from 00:00 IST on operating day */
  scheduledArrMin: number;
  blockMinutes: number;
  pax: number;
  turnaroundBeforeMin: number | null;
}

export interface AircraftRecord {
  tailId: string;
  seats: number;
  isSpare: boolean;
  /** Base airport (origin of leg 1 for active aircraft, or spare base) */
  baseAirportId: string;
  /** Available time in absolute minutes (00:00 for active scheduled fleet, or spare available_from) */
  availableFromMin: number;
  availableFromStr: string;
  /** Ordered flight IDs scheduled for this aircraft (empty for spares) */
  scheduledFlightIds: string[];
}

export interface PassengerConnection {
  connectionId: string;
  airportId: string;
  fromFlightId: string;
  toFlightId: string;
  passengers: number;
  minConnectMinutes: number;
  /** Scheduled buffer in minutes: toFlight.scheduledDepMin - fromFlight.scheduledArrMin */
  scheduledConnectMinutes: number;
}

export interface CrewRecord {
  crewId: string;
  tailId: string;
  baseAirportId: string;
  dutyStartStr: string;
  /** Absolute minutes from 00:00 IST */
  dutyStartMin: number;
  maxDutyMins: number;
  flightIds: string[];
  /** Scheduled duty duration from dutyStartMin to last flight's scheduledArrMin */
  scheduledDutyMins: number;
  /** Remaining legal duty buffer before any disruption occurs */
  scheduledDutyMarginMins: number;
}

export interface NormalizedFlightNetwork {
  meta: {
    dataset: string;
    operatingDay: string;
    minTurnaroundMinutes: number;
    seatsPerAircraft: number;
    notes: string[];
  };
  airports: Airport[];
  flights: ScheduledFlight[];
  activeAircraft: AircraftRecord[];
  spareAircraft: AircraftRecord[];
  connections: PassengerConnection[];
  crews: CrewRecord[];
  /** Fast O(1) indexed lookups for the deterministic simulation engine */
  index: {
    airportsById: Record<string, Airport>;
    flightsById: Record<string, ScheduledFlight>;
    flightsByTailId: Record<string, ScheduledFlight[]>;
    crewsById: Record<string, CrewRecord>;
    crewByTailId: Record<string, CrewRecord>;
    connectionsByFromFlight: Record<string, PassengerConnection[]>;
    connectionsByToFlight: Record<string, PassengerConnection[]>;
    spareAircraftById: Record<string, AircraftRecord>;
  };
}

// ---------------------------------------------------------------------------
// Validation Report Models
// ---------------------------------------------------------------------------

export type ValidationSeverity = 'pass' | 'warning' | 'error';

export interface ValidationCheckResult {
  id: string;
  category: 'schema' | 'airports' | 'flights' | 'rotations' | 'connections' | 'crews' | 'spares';
  label: string;
  severity: ValidationSeverity;
  summary: string;
  details: string[];
}

export interface DatasetValidationReport {
  isValid: boolean;
  checkedAtIso: string;
  counts: {
    airports: number;
    flights: number;
    activeAircraft: number;
    spareAircraft: number;
    connections: number;
    crews: number;
    totalScheduledPaxTrips: number;
    totalConnectingPax: number;
  };
  operatingWindow: {
    earliestActivityMin: number;
    earliestActivityStr: string;
    latestArrivalMin: number;
    latestArrivalStr: string;
  };
  summary: {
    passed: number;
    warnings: number;
    errors: number;
  };
  checks: ValidationCheckResult[];
}
