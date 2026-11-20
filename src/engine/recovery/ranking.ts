/**
 * Domino Sky — Transparent Multi-Criteria Deterministic Recovery Ranking
 *
 * Ranks verified RecoveryComparison options strictly by explicit operational criteria:
 *   1. Operational feasibility & physical aircraft continuity (hard prerequisite gate)
 *   2. Passenger impact reduction (weight: 0.35)
 *   3. Total delay reduction (weight: 0.25)
 *   4. Crew duty compliance (weight: 0.25)
 *   5. Avoiding unnecessary cancellations (weight: 0.15)
 *
 * Exposes every criterion's raw metric delta, normalized score, weight, weighted
 * contribution, and plain-language explanation so trade-offs are never hidden.
 */

import type {
  RankedRecoveryOption,
  RankingCriterionScore,
  RecoveryComparison,
  RecoveryRankingBreakdown,
} from '../../types/index.ts';

export const RANKING_WEIGHTS = {
  passengerImpact: 0.35,
  totalDelay: 0.25,
  crewDuty: 0.25,
  cancellationAvoidance: 0.15,
} as const;

function clampScore(value: number): number {
  return Math.max(-100, Math.min(100, Math.round(value * 100) / 100));
}

function roundTwo(value: number): number {
  return Math.round(value * 100) / 100;
}

export function scoreRecoveryComparison(
  comparison: RecoveryComparison
): RecoveryRankingBreakdown {
  const { baseline, recovered, deltas, appliedAction } = comparison;
  const allRotationsConsistent = recovered.rotations.every((r) => r.isPhysicallyConsistent);
  const feasibleAndConsistent = appliedAction.isFeasible && allRotationsConsistent;

  // Priority 1: Operational feasibility & aircraft continuity (prerequisite gate)
  const feasibilityCriterion: RankingCriterionScore = {
    id: 'feasibility_and_continuity',
    label: 'Operational Feasibility & Aircraft Continuity',
    priorityRank: 1,
    weight: 0, // Prerequisite gate — infeasible options receive -1000 penalty and cannot outrank feasible ones
    rawMetricSummary: feasibleAndConsistent
      ? 'Feasible · 100% physically continuous'
      : 'Infeasible / continuity failure',
    criterionScore: feasibleAndConsistent ? 100 : -100,
    weightedContribution: feasibleAndConsistent ? 0 : -1000,
    explanation: feasibleAndConsistent
      ? appliedAction.usesAssumedStandbyCrew
        ? 'All physical aircraft and capacity checks passed (standby crew relies on configurable modelling assumption).'
        : 'All physical aircraft continuity, turnaround, and crew constraints verified.'
      : appliedAction.feasibilityReason,
  };

  // Priority 2: Passenger impact reduction (weight 0.35)
  // Stranded delta < 0 means fewer stranded pax (improvement); > 0 means more stranded pax (penalty)
  const strandedDelta = deltas.totalStrandedPaxDelta;
  let paxScore: number;
  if (strandedDelta < 0) {
    const denom = Math.max(baseline.kpis.totalStrandedPaxEstimate, 50);
    paxScore = clampScore((-strandedDelta / denom) * 100);
  } else if (strandedDelta > 0) {
    // Penalize increasing total stranded pax strongly (especially from cancellations)
    paxScore = clampScore(-(strandedDelta / 150) * 100);
  } else {
    // No change in stranded pax; check if delayed pax decreased
    const delayedPaxDelta =
      recovered.passengerImpact.delayedFlightPax - baseline.passengerImpact.delayedFlightPax;
    paxScore = delayedPaxDelta < 0 ? clampScore(Math.min(25, (-delayedPaxDelta / 600) * 25)) : 0;
  }

  const passengerCriterion: RankingCriterionScore = {
    id: 'passenger_impact_reduction',
    label: 'Passenger Impact Reduction',
    priorityRank: 2,
    weight: RANKING_WEIGHTS.passengerImpact,
    rawMetricSummary: `${strandedDelta > 0 ? '+' : ''}${strandedDelta} stranded pax (${deltas.missedConnectionPaxDelta > 0 ? '+' : ''}${deltas.missedConnectionPaxDelta} missed conn, ${deltas.cancelledFlightPaxDelta > 0 ? '+' : ''}${deltas.cancelledFlightPaxDelta} cancelled pax)`,
    criterionScore: paxScore,
    weightedContribution: roundTwo(paxScore * RANKING_WEIGHTS.passengerImpact),
    explanation:
      strandedDelta < 0
        ? `Reduces total stranded passengers by ${Math.abs(strandedDelta)} without double-counting overlap.`
        : strandedDelta > 0
          ? `Increases total stranded passengers by +${strandedDelta}.`
          : 'Total stranded passenger count is unchanged.',
  };

  // Priority 3: Total delay reduction (weight 0.25)
  const delayDelta = deltas.totalDelayMinutesDelta;
  const delayDenom = Math.max(baseline.kpis.totalDelayMinutes, 60);
  const delayScore = clampScore((-delayDelta / delayDenom) * 100);

  const delayCriterion: RankingCriterionScore = {
    id: 'total_delay_reduction',
    label: 'Total Delay Reduction',
    priorityRank: 3,
    weight: RANKING_WEIGHTS.totalDelay,
    rawMetricSummary: `${delayDelta > 0 ? '+' : ''}${delayDelta}m total arrival delay (${deltas.delayedFlightsDelta > 0 ? '+' : ''}${deltas.delayedFlightsDelta} delayed flights)`,
    criterionScore: delayScore,
    weightedContribution: roundTwo(delayScore * RANKING_WEIGHTS.totalDelay),
    explanation:
      delayDelta < 0
        ? `Cuts network arrival delay by ${Math.abs(delayDelta)}m (${Math.round((Math.abs(delayDelta) / delayDenom) * 100)}% of baseline delay).`
        : delayDelta > 0
          ? `Adds +${delayDelta}m of total arrival delay across the network.`
          : 'No change in total network arrival delay.',
  };

  // Priority 4: Crew duty compliance (weight 0.25)
  const crewDelta = deltas.crewViolationsDelta;
  const overageDelta = deltas.maxCrewOverageMinsDelta;
  let crewScore = 0;
  if (crewDelta < 0) {
    const baseViolations = Math.max(baseline.kpis.crewViolationsCount, 1);
    crewScore = clampScore((-crewDelta / baseViolations) * 100);
  } else if (crewDelta > 0) {
    crewScore = clampScore(-crewDelta * 60);
  } else if (overageDelta !== 0) {
    crewScore = clampScore((-overageDelta / Math.max(baseline.kpis.maxCrewOverageMins, 60)) * 40);
  }

  const crewCriterion: RankingCriterionScore = {
    id: 'crew_duty_compliance',
    label: 'Crew Duty Compliance',
    priorityRank: 4,
    weight: RANKING_WEIGHTS.crewDuty,
    rawMetricSummary: `${crewDelta > 0 ? '+' : ''}${crewDelta} crew violations (${overageDelta > 0 ? '+' : ''}${overageDelta}m max overage)`,
    criterionScore: crewScore,
    weightedContribution: roundTwo(crewScore * RANKING_WEIGHTS.crewDuty),
    explanation:
      crewDelta < 0
        ? `Resolves ${Math.abs(crewDelta)} crew duty violation${Math.abs(crewDelta) === 1 ? '' : 's'} (${comparison.resolvedCrewViolationIds.join(', ')}).`
        : crewDelta > 0
          ? `Creates ${crewDelta} new crew duty violation${crewDelta === 1 ? '' : 's'} (${comparison.newlyCreatedCrewViolationIds.join(', ')}).`
          : overageDelta < 0
            ? `Reduces maximum crew duty overage by ${Math.abs(overageDelta)}m.`
            : 'Crew duty compliance unchanged.',
  };

  // Priority 5: Avoiding unnecessary cancellations (weight 0.15)
  const cancelDelta = deltas.cancelledFlightsDelta;
  let cancelScore = 0;
  if (cancelDelta === 0) {
    cancelScore = 100;
  } else if (cancelDelta > 0) {
    // Each added cancellation incurs a clear penalty; cancelling 1 flight scores -40, 2 flights -70, 3+ flights -100
    cancelScore = clampScore(-(cancelDelta * 35 + 5));
  } else {
    cancelScore = 100;
  }

  const cancellationCriterion: RankingCriterionScore = {
    id: 'cancellation_avoidance',
    label: 'Avoiding Unnecessary Cancellations',
    priorityRank: 5,
    weight: RANKING_WEIGHTS.cancellationAvoidance,
    rawMetricSummary:
      cancelDelta === 0
        ? '0 new cancellations'
        : `${cancelDelta > 0 ? '+' : ''}${cancelDelta} cancelled flight${Math.abs(cancelDelta) === 1 ? '' : 's'}`,
    criterionScore: cancelScore,
    weightedContribution: roundTwo(cancelScore * RANKING_WEIGHTS.cancellationAvoidance),
    explanation:
      cancelDelta === 0
        ? 'Preserves 100% of scheduled flights with zero cancellations.'
        : `Requires ${cancelDelta} flight cancellation${cancelDelta === 1 ? '' : 's'} (${comparison.cancelledForRecoveryFlightIds.join(', ')}).`,
  };

  const criteria: RankingCriterionScore[] = [
    feasibilityCriterion,
    passengerCriterion,
    delayCriterion,
    crewCriterion,
    cancellationCriterion,
  ];

  const totalScore = roundTwo(
    criteria.reduce((sum, c) => sum + c.weightedContribution, 0)
  );

  return {
    totalScore,
    criteria,
    tradeoffSummary: comparison.operationalTradeoffs,
  };
}

/**
 * Deterministically ranks evaluated RecoveryComparisons with explicit tie-breakers.
 */
export function rankRecoveryComparisons(
  comparisons: RecoveryComparison[]
): RankedRecoveryOption[] {
  const scored = comparisons.map((comparison) => ({
    action: comparison.appliedAction,
    comparison,
    ranking: scoreRecoveryComparison(comparison),
  }));

  scored.sort((a, b) => {
    // 1. Feasible always precedes infeasible
    const aFeasible = a.action.isFeasible ? 1 : 0;
    const bFeasible = b.action.isFeasible ? 1 : 0;
    if (aFeasible !== bFeasible) return bFeasible - aFeasible;

    // 2. Higher composite weighted score
    if (a.ranking.totalScore !== b.ranking.totalScore) {
      return b.ranking.totalScore - a.ranking.totalScore;
    }

    // 3. Lower total stranded passengers
    if (
      a.comparison.recovered.kpis.totalStrandedPaxEstimate !==
      b.comparison.recovered.kpis.totalStrandedPaxEstimate
    ) {
      return (
        a.comparison.recovered.kpis.totalStrandedPaxEstimate -
        b.comparison.recovered.kpis.totalStrandedPaxEstimate
      );
    }

    // 4. Fewer crew duty violations
    if (
      a.comparison.recovered.kpis.crewViolationsCount !==
      b.comparison.recovered.kpis.crewViolationsCount
    ) {
      return (
        a.comparison.recovered.kpis.crewViolationsCount -
        b.comparison.recovered.kpis.crewViolationsCount
      );
    }

    // 5. Fewer cancelled flights
    if (
      a.comparison.recovered.kpis.cancelledFlights !==
      b.comparison.recovered.kpis.cancelledFlights
    ) {
      return (
        a.comparison.recovered.kpis.cancelledFlights -
        b.comparison.recovered.kpis.cancelledFlights
      );
    }

    // 6. Lower total arrival delay
    if (
      a.comparison.recovered.kpis.totalDelayMinutes !==
      b.comparison.recovered.kpis.totalDelayMinutes
    ) {
      return (
        a.comparison.recovered.kpis.totalDelayMinutes -
        b.comparison.recovered.kpis.totalDelayMinutes
      );
    }

    // 7. Stable lexicographical actionId tie-breaker
    return a.action.actionId.localeCompare(b.action.actionId);
  });

  return scored.map((item, idx) => ({
    rank: idx + 1,
    action: item.action,
    comparison: item.comparison,
    ranking: item.ranking,
  }));
}
