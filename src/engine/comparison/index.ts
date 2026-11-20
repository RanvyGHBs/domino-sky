/**
 * Module 8: Before-and-After Network Comparison
 *
 * Computes deterministic KPI deltas, categorized metric changes (improved / worsened /
 * unchanged), 5-category per-flight recovery diffs, connection & crew violation changes,
 * and plain-language deterministic operational trade-offs.
 */

import type {
  FlightRecoveryDiff,
  FlightRecoveryOutcome,
  MetricDeltaRecord,
  NetworkKpiSnapshot,
  RecoveryAction,
  RecoveryComparison,
  SimulationResult,
} from '../../types/index.ts';

export interface NetworkComparisonEngine {
  compareScenarios(
    baseline: SimulationResult,
    recovered: SimulationResult,
    appliedAction: RecoveryAction
  ): RecoveryComparison;
}

interface MetricSpec {
  metric: keyof NetworkKpiSnapshot;
  label: string;
  unit: string;
  /** True if a smaller value is operationally better */
  lowerIsBetter: boolean;
}

const COMPARED_METRIC_SPECS: MetricSpec[] = [
  { metric: 'delayedFlights', label: 'Delayed Flights', unit: 'flights', lowerIsBetter: true },
  { metric: 'cancelledFlights', label: 'Cancelled Flights', unit: 'flights', lowerIsBetter: true },
  { metric: 'totalDelayMinutes', label: 'Total Arrival Delay', unit: 'min', lowerIsBetter: true },
  { metric: 'averageDelayMinutes', label: 'Average Delay (Delayed Flights)', unit: 'min', lowerIsBetter: true },
  { metric: 'maxDelayMinutes', label: 'Maximum Flight Delay', unit: 'min', lowerIsBetter: true },
  { metric: 'missedConnectionsCount', label: 'Missed Connections', unit: 'connections', lowerIsBetter: true },
  { metric: 'missedConnectionPax', label: 'Missed Connection Passengers', unit: 'pax', lowerIsBetter: true },
  { metric: 'cancelledFlightPax', label: 'Cancelled Flight Passengers', unit: 'pax', lowerIsBetter: true },
  { metric: 'totalStrandedPaxEstimate', label: 'Total Stranded Passengers (No Double-Count)', unit: 'pax', lowerIsBetter: true },
  { metric: 'crewViolationsCount', label: 'Crew Duty Violations', unit: 'crews', lowerIsBetter: true },
  { metric: 'maxCrewOverageMins', label: 'Max Crew Duty Overage', unit: 'min', lowerIsBetter: true },
];

function roundOneDecimal(val: number): number {
  return Math.round(val * 10) / 10;
}

export function compareScenarios(
  baseline: SimulationResult,
  recovered: SimulationResult,
  appliedAction: RecoveryAction
): RecoveryComparison {
  const bKpi = baseline.kpis;
  const rKpi = recovered.kpis;

  const deltas: RecoveryComparison['deltas'] = {
    delayedFlightsDelta: rKpi.delayedFlights - bKpi.delayedFlights,
    cancelledFlightsDelta: rKpi.cancelledFlights - bKpi.cancelledFlights,
    totalDelayMinutesDelta: rKpi.totalDelayMinutes - bKpi.totalDelayMinutes,
    averageDelayMinutesDelta: roundOneDecimal(rKpi.averageDelayMinutes - bKpi.averageDelayMinutes),
    maxDelayMinutesDelta: rKpi.maxDelayMinutes - bKpi.maxDelayMinutes,
    missedConnectionsDelta: rKpi.missedConnectionsCount - bKpi.missedConnectionsCount,
    missedConnectionPaxDelta: rKpi.missedConnectionPax - bKpi.missedConnectionPax,
    cancelledFlightPaxDelta: rKpi.cancelledFlightPax - bKpi.cancelledFlightPax,
    cancelledConnectionOverlapPaxDelta:
      rKpi.cancelledConnectionOverlapPax - bKpi.cancelledConnectionOverlapPax,
    totalStrandedPaxDelta: rKpi.totalStrandedPaxEstimate - bKpi.totalStrandedPaxEstimate,
    crewViolationsDelta: rKpi.crewViolationsCount - bKpi.crewViolationsCount,
    maxCrewOverageMinsDelta: rKpi.maxCrewOverageMins - bKpi.maxCrewOverageMins,
  };

  // Categorize every tracked KPI into improved / worsened / unchanged
  const improvedMetrics: MetricDeltaRecord[] = [];
  const worsenedMetrics: MetricDeltaRecord[] = [];
  const unchangedMetrics: MetricDeltaRecord[] = [];

  for (const spec of COMPARED_METRIC_SPECS) {
    const before = bKpi[spec.metric];
    const after = rKpi[spec.metric];
    const delta = roundOneDecimal(after - before);
    let direction: MetricDeltaRecord['direction'] = 'unchanged';
    if (delta !== 0) {
      const improved = spec.lowerIsBetter ? delta < 0 : delta > 0;
      direction = improved ? 'improved' : 'worsened';
    }
    const record: MetricDeltaRecord = {
      metric: spec.metric,
      label: spec.label,
      unit: spec.unit,
      before,
      after,
      delta,
      direction,
    };
    if (direction === 'improved') improvedMetrics.push(record);
    else if (direction === 'worsened') worsenedMetrics.push(record);
    else unchangedMetrics.push(record);
  }

  // Classify every flight into one of the 5 explicit recovery outcome buckets
  const baselineFlightById = new Map(baseline.flights.map((f) => [f.flightId, f]));
  const flightDiffs: FlightRecoveryDiff[] = [];
  const recoveredFlightIds: string[] = [];
  const delayReducedFlightIds: string[] = [];
  const delayIncreasedFlightIds: string[] = [];
  const cancelledForRecoveryFlightIds: string[] = [];
  const unaffectedFlightIds: string[] = [];

  for (const rf of recovered.flights) {
    const bf = baselineFlightById.get(rf.flightId);
    if (!bf) continue;

    let outcome: FlightRecoveryOutcome = 'unaffected';
    const arrivalDelayDeltaMin = rf.arrivalDelayMin - bf.arrivalDelayMin;

    if (bf.status !== 'cancelled' && rf.status === 'cancelled') {
      outcome = 'cancelled_for_recovery';
      cancelledForRecoveryFlightIds.push(rf.flightId);
    } else if (bf.status === 'delayed' && rf.status === 'on_time') {
      outcome = 'recovered';
      recoveredFlightIds.push(rf.flightId);
    } else if (bf.status === 'cancelled' && rf.status !== 'cancelled') {
      outcome = rf.status === 'on_time' ? 'recovered' : 'delay_reduced';
      if (outcome === 'recovered') recoveredFlightIds.push(rf.flightId);
      else delayReducedFlightIds.push(rf.flightId);
    } else if (rf.arrivalDelayMin < bf.arrivalDelayMin) {
      outcome = 'delay_reduced';
      delayReducedFlightIds.push(rf.flightId);
    } else if (rf.arrivalDelayMin > bf.arrivalDelayMin) {
      outcome = 'delay_increased';
      delayIncreasedFlightIds.push(rf.flightId);
    } else {
      outcome = 'unaffected';
      unaffectedFlightIds.push(rf.flightId);
    }

    flightDiffs.push({
      flightId: rf.flightId,
      tailBefore: bf.assignedTailId,
      tailAfter: rf.assignedTailId,
      route: `${rf.origin}→${rf.destination}`,
      baselineStatus: bf.status,
      recoveredStatus: rf.status,
      baselineArrivalDelayMin: bf.arrivalDelayMin,
      recoveredArrivalDelayMin: rf.arrivalDelayMin,
      arrivalDelayDeltaMin,
      outcome,
    });
  }

  // Crew violation changes
  const baselineViolatingCrews = new Set(
    baseline.crews.filter((c) => c.isViolation).map((c) => c.crewId)
  );
  const recoveredViolatingCrews = new Set(
    recovered.crews.filter((c) => c.isViolation).map((c) => c.crewId)
  );

  const resolvedCrewViolationIds = [...baselineViolatingCrews].filter(
    (id) => !recoveredViolatingCrews.has(id)
  );
  const newlyCreatedCrewViolationIds = [...recoveredViolatingCrews].filter(
    (id) => !baselineViolatingCrews.has(id)
  );

  // Connection changes
  const baselineConnById = new Map(baseline.connections.map((c) => [c.connectionId, c]));
  const savedConnectionIds: string[] = [];
  const lostConnectionIds: string[] = [];

  for (const rc of recovered.connections) {
    const bc = baselineConnById.get(rc.connectionId);
    if (!bc) continue;
    if (bc.status !== 'made' && rc.status === 'made') {
      savedConnectionIds.push(rc.connectionId);
    } else if (bc.status === 'made' && rc.status !== 'made') {
      lostConnectionIds.push(rc.connectionId);
    }
  }

  // Build deterministic, factual operational trade-off summary
  const operationalTradeoffs: string[] = [];

  if (recoveredFlightIds.length > 0 || delayReducedFlightIds.length > 0) {
    operationalTradeoffs.push(
      `Recovered ${recoveredFlightIds.length} flight${recoveredFlightIds.length === 1 ? '' : 's'} to on-time and reduced delay on ${delayReducedFlightIds.length} additional flight${delayReducedFlightIds.length === 1 ? '' : 's'} (net delay change: ${deltas.totalDelayMinutesDelta > 0 ? '+' : ''}${deltas.totalDelayMinutesDelta}m).`
    );
  } else if (deltas.totalDelayMinutesDelta > 0) {
    operationalTradeoffs.push(
      `Added +${deltas.totalDelayMinutesDelta}m of total arrival delay across ${delayIncreasedFlightIds.length} flight${delayIncreasedFlightIds.length === 1 ? '' : 's'}.`
    );
  }

  if (savedConnectionIds.length > 0) {
    const savedPax = recovered.connections
      .filter((c) => savedConnectionIds.includes(c.connectionId))
      .reduce((sum, c) => sum + c.passengers, 0);
    operationalTradeoffs.push(
      `Protected ${savedConnectionIds.length} passenger connection${savedConnectionIds.length === 1 ? '' : 's'} (${savedConnectionIds.join(', ')}, ${savedPax} passengers).`
    );
  }

  if (lostConnectionIds.length > 0) {
    const lostPax = recovered.connections
      .filter((c) => lostConnectionIds.includes(c.connectionId))
      .reduce((sum, c) => sum + c.passengers, 0);
    operationalTradeoffs.push(
      `Disrupted ${lostConnectionIds.length} previously intact connection${lostConnectionIds.length === 1 ? '' : 's'} (${lostConnectionIds.join(', ')}, ${lostPax} passengers).`
    );
  }

  if (cancelledForRecoveryFlightIds.length > 0) {
    operationalTradeoffs.push(
      `Requires cancelling ${cancelledForRecoveryFlightIds.length} flight${cancelledForRecoveryFlightIds.length === 1 ? '' : 's'} (${cancelledForRecoveryFlightIds.join(', ')}, +${deltas.cancelledFlightPaxDelta} cancelled-flight pax; ${rKpi.cancelledConnectionOverlapPax} connecting overlap pax excluded from double-counting).`
    );
  }

  if (resolvedCrewViolationIds.length > 0) {
    operationalTradeoffs.push(
      `Resolved ${resolvedCrewViolationIds.length} crew duty violation${resolvedCrewViolationIds.length === 1 ? '' : 's'} (${resolvedCrewViolationIds.join(', ')}).`
    );
  }

  if (newlyCreatedCrewViolationIds.length > 0) {
    operationalTradeoffs.push(
      `Introduces ${newlyCreatedCrewViolationIds.length} new crew duty violation${newlyCreatedCrewViolationIds.length === 1 ? '' : 's'} (${newlyCreatedCrewViolationIds.join(', ')}).`
    );
  }

  if (appliedAction.usesAssumedStandbyCrew) {
    operationalTradeoffs.push(
      `Assumption notice: Relies on configurable ${recovered.config.assumedStandbyCrew.preDepartureBriefingMins}m standby-crew modelling assumption (official dataset contains no reserve crew records).`
    );
  }

  return {
    baseline,
    recovered,
    appliedAction: { ...appliedAction, isEngineVerified: true },
    feasibilityStatus: {
      isFeasible: appliedAction.isFeasible,
      reason: appliedAction.feasibilityReason,
      checks: appliedAction.feasibilityChecks,
      usesAssumedStandbyCrew: appliedAction.usesAssumedStandbyCrew,
    },
    deltas,
    improvedMetrics,
    worsenedMetrics,
    unchangedMetrics,
    operationalTradeoffs,
    flightDiffs,
    recoveredFlightIds,
    delayReducedFlightIds,
    delayIncreasedFlightIds,
    cancelledForRecoveryFlightIds,
    unaffectedFlightIds,
    improvedFlightIds: [...recoveredFlightIds, ...delayReducedFlightIds],
    worsenedFlightIds: [...delayIncreasedFlightIds, ...cancelledForRecoveryFlightIds],
    resolvedCrewViolationIds,
    newlyCreatedCrewViolationIds,
    savedConnectionIds,
    lostConnectionIds,
  };
}

export const defaultNetworkComparisonEngine: NetworkComparisonEngine = {
  compareScenarios,
};
