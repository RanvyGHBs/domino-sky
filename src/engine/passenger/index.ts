/**
 * Module 5: Passenger Connection & Stranded Impact Analyzer
 *
 * Evaluates all 21 official passenger connections against actual arrival/departure
 * times while strictly separating cancelled-flight pax from missed-connection pax
 * so connecting passengers on cancelled flights are never double-counted.
 */

import type {
  ConnectionOutcomeStatus,
  NormalizedFlightNetwork,
  PassengerConnection,
  PassengerImpactSummary,
  SimulatedConnectionState,
  SimulatedFlightState,
} from '../../types/index.ts';

export interface PassengerAnalysisOutput {
  connections: SimulatedConnectionState[];
  summary: PassengerImpactSummary;
}

export interface PassengerConnectionAnalyzer {
  analyzePassengerImpact(
    network: NormalizedFlightNetwork,
    simulatedFlights: SimulatedFlightState[]
  ): PassengerAnalysisOutput;
}

/**
 * Pure single-connection MCT evaluator.
 * - If either flight is cancelled, marks connection broken by cancellation (overlap tracked separately).
 * - If both flights operate, connection is made iff actualDep(to) - actualArr(from) >= minConnectMinutes.
 */
export function evaluateSingleConnection(
  connection: PassengerConnection,
  fromActualArrMin: number | null,
  toActualDepMin: number | null
): SimulatedConnectionState {
  if (fromActualArrMin === null && toActualDepMin === null) {
    return {
      connectionId: connection.connectionId,
      airportId: connection.airportId,
      fromFlightId: connection.fromFlightId,
      toFlightId: connection.toFlightId,
      passengers: connection.passengers,
      minConnectMinutes: connection.minConnectMinutes,
      scheduledConnectMinutes: connection.scheduledConnectMinutes,
      actualConnectMinutes: null,
      status: 'broken_due_to_both_cancelled',
      shortfallMinutes: 0,
      explanation: `Both ${connection.fromFlightId} and ${connection.toFlightId} were cancelled (tracked as cancelled-flight overlap; not double-counted).`,
    };
  }

  if (fromActualArrMin === null) {
    return {
      connectionId: connection.connectionId,
      airportId: connection.airportId,
      fromFlightId: connection.fromFlightId,
      toFlightId: connection.toFlightId,
      passengers: connection.passengers,
      minConnectMinutes: connection.minConnectMinutes,
      scheduledConnectMinutes: connection.scheduledConnectMinutes,
      actualConnectMinutes: null,
      status: 'broken_due_to_from_cancellation',
      shortfallMinutes: 0,
      explanation: `Feeder flight ${connection.fromFlightId} was cancelled (tracked as cancelled-flight overlap; not double-counted).`,
    };
  }

  if (toActualDepMin === null) {
    return {
      connectionId: connection.connectionId,
      airportId: connection.airportId,
      fromFlightId: connection.fromFlightId,
      toFlightId: connection.toFlightId,
      passengers: connection.passengers,
      minConnectMinutes: connection.minConnectMinutes,
      scheduledConnectMinutes: connection.scheduledConnectMinutes,
      actualConnectMinutes: null,
      status: 'broken_due_to_to_cancellation',
      shortfallMinutes: 0,
      explanation: `Onward flight ${connection.toFlightId} was cancelled (tracked as cancelled-flight overlap; not double-counted).`,
    };
  }

  const actualConnectMinutes = toActualDepMin - fromActualArrMin;
  const made = actualConnectMinutes >= connection.minConnectMinutes;
  const shortfallMinutes = made ? 0 : connection.minConnectMinutes - actualConnectMinutes;
  const status: ConnectionOutcomeStatus = made ? 'made' : 'missed_due_to_delay';

  return {
    connectionId: connection.connectionId,
    airportId: connection.airportId,
    fromFlightId: connection.fromFlightId,
    toFlightId: connection.toFlightId,
    passengers: connection.passengers,
    minConnectMinutes: connection.minConnectMinutes,
    scheduledConnectMinutes: connection.scheduledConnectMinutes,
    actualConnectMinutes,
    status,
    shortfallMinutes,
    explanation: made
      ? `Connection made with ${actualConnectMinutes}m transfer window (MCT ${connection.minConnectMinutes}m).`
      : `Connection missed by ${shortfallMinutes}m: actual transfer ${actualConnectMinutes}m < MCT ${connection.minConnectMinutes}m.`,
  };
}

/**
 * Evaluates all 21 official passenger connections and aggregates passenger impacts
 * while keeping cancelled-flight passengers strictly separate from missed-connection
 * passengers to prevent double counting.
 */
export function analyzePassengerImpact(
  network: NormalizedFlightNetwork,
  simulatedFlights: SimulatedFlightState[]
): PassengerAnalysisOutput {
  const flightMap = new Map<string, SimulatedFlightState>();
  for (const sf of simulatedFlights) {
    flightMap.set(sf.flightId, sf);
  }

  const connections: SimulatedConnectionState[] = network.connections.map((conn) => {
    const fromFl = flightMap.get(conn.fromFlightId);
    const toFl = flightMap.get(conn.toFlightId);
    const fromArr = fromFl && fromFl.status !== 'cancelled' ? fromFl.actualArrMin : null;
    const toDep = toFl && toFl.status !== 'cancelled' ? toFl.actualDepMin : null;
    return evaluateSingleConnection(conn, fromArr, toDep);
  });

  let cancelledFlightPax = 0;
  let delayedFlightPax = 0;

  for (const sf of simulatedFlights) {
    if (sf.status === 'cancelled') {
      cancelledFlightPax += sf.pax;
    } else if (sf.arrivalDelayMin >= 15) {
      delayedFlightPax += sf.pax;
    }
  }

  let missedConnectionPax = 0;
  let cancelledConnectionOverlapPax = 0;
  let missedConnectionsCount = 0;
  let brokenByCancellationCount = 0;
  let preservedConnectionsCount = 0;

  for (const c of connections) {
    if (c.status === 'made') {
      preservedConnectionsCount += 1;
    } else if (c.status === 'missed_due_to_delay') {
      missedConnectionsCount += 1;
      missedConnectionPax += c.passengers;
    } else {
      brokenByCancellationCount += 1;
      cancelledConnectionOverlapPax += c.passengers;
    }
  }

  const totalStrandedPaxEstimate = cancelledFlightPax + missedConnectionPax;

  const summary: PassengerImpactSummary = {
    cancelledFlightPax,
    missedConnectionPax,
    cancelledConnectionOverlapPax,
    totalStrandedPaxEstimate,
    delayedFlightPax,
    missedConnectionsCount,
    brokenByCancellationCount,
    preservedConnectionsCount,
    countingNote:
      'Total stranded passenger-trips = cancelledFlightPax + missedConnectionPax (connections broken by flight cancellations are reported separately as overlap and excluded to prevent double counting; dataset lacks individual multi-hop PNR IDs).',
  };

  return { connections, summary };
}
