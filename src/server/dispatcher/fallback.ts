/**
 * Domino Sky — Module 09: Deterministic Hydration & Fallback Builder
 *
 * 1) Hydrates validated Gemini qualitative selections with exact backend KPIs
 *    so Gemini NEVER supplies or alters operational numbers.
 * 2) Builds clearly labelled deterministic fallback recommendations using the
 *    unmodified deterministic multi-criteria ranking whenever Gemini is unavailable,
 *    times out, hits rate limits, or fails strict validation.
 */

import type {
  AiDispatcherStatus,
  DispatcherAlternativeAction,
  DispatcherCandidateBrief,
  DispatcherDeterministicRankingBrief,
  DispatcherPreference,
  DispatcherRecommendedAction,
  DispatcherRecommendResponse,
  DispatcherRejectedExplanation,
  DispatcherSimulationSummary,
  DispatcherValidationIssue,
  RawGeminiDispatcherOutput,
  VerifiedRecommendationKpiBundle,
} from '../../types/dispatcher.ts';
import type {
  RankedRecoveryOption,
  RecoveryAction,
  SimulationResult,
} from '../../types/simulation.ts';
import { formatMinutesToClock } from '../../engine/time.ts';

export function buildVerifiedKpiBundle(
  opt: RankedRecoveryOption
): VerifiedRecommendationKpiBundle {
  const c = opt.comparison;
  return {
    before: c.baseline.kpis,
    after: c.recovered.kpis,
    deltas: c.deltas,
    recoveredFlightIds: c.recoveredFlightIds,
    delayReducedFlightIds: c.delayReducedFlightIds,
    delayIncreasedFlightIds: c.delayIncreasedFlightIds,
    cancelledForRecoveryFlightIds: c.cancelledForRecoveryFlightIds,
    savedConnectionIds: c.savedConnectionIds,
    lostConnectionIds: c.lostConnectionIds,
    resolvedCrewViolationIds: c.resolvedCrewViolationIds,
    newlyCreatedCrewViolationIds: c.newlyCreatedCrewViolationIds,
    operationalTradeoffs: c.operationalTradeoffs,
  };
}

export function buildCandidateBrief(action: RecoveryAction): DispatcherCandidateBrief {
  return {
    actionId: action.actionId,
    type: action.type,
    label: action.label,
    description: action.description,
    generationReason: action.generationReason,
    usesAssumedStandbyCrew: action.usesAssumedStandbyCrew,
    isFeasible: action.isFeasible,
    feasibilityReason: action.feasibilityReason,
    feasibilityChecks: action.feasibilityChecks,
  };
}

export function buildDeterministicRankingBrief(
  opt: RankedRecoveryOption
): DispatcherDeterministicRankingBrief {
  return {
    rank: opt.rank,
    actionId: opt.action.actionId,
    type: opt.action.type,
    label: opt.action.label,
    totalScore: opt.ranking.totalScore,
    usesAssumedStandbyCrew: opt.action.usesAssumedStandbyCrew,
    deltas: opt.comparison.deltas,
    criteria: opt.ranking.criteria,
  };
}

export function collectAuthoritativeAssumptions(
  baseline: SimulationResult,
  selectedOptions: RankedRecoveryOption[],
  aiAssumptions: string[] = []
): string[] {
  const merged = new Set<string>();
  for (const a of baseline.activeAssumptions) {
    merged.add(a);
  }
  const usesStandby = selectedOptions.some((o) => o.action.usesAssumedStandbyCrew);
  if (usesStandby) {
    merged.add(
      `Standby crew assumption active: spare aircraft deployments assume a standby crew reporting ${baseline.config.assumedStandbyCrew.preDepartureBriefingMins} minutes pre-departure (max ${baseline.config.assumedStandbyCrew.maxDutyMins}m duty). Official flight_network.json contains no reserve crew records.`
    );
  }
  merged.add(
    'Simulation-based decision support only: all operational metrics are computed by the deterministic TypeScript engine.'
  );
  for (const a of aiAssumptions) {
    if (a.trim().length > 0) merged.add(a.trim());
  }
  return Array.from(merged);
}

/**
 * Hydrates a validated Gemini output with authoritative deterministic KPIs,
 * action metadata, alternatives, and rejection reasons.
 */
export function hydrateVerifiedGeminiResponse(params: {
  sanitized: RawGeminiDispatcherOutput;
  modelUsed: string;
  preference: DispatcherPreference;
  simulationSummary: DispatcherSimulationSummary;
  baseline: SimulationResult;
  rankedOptions: RankedRecoveryOption[];
  rejectedCandidates: RecoveryAction[];
}): DispatcherRecommendResponse {
  const {
    sanitized,
    modelUsed,
    preference,
    simulationSummary,
    baseline,
    rankedOptions,
    rejectedCandidates,
  } = params;

  const optionById = new Map(rankedOptions.map((o) => [o.action.actionId, o]));
  const rejectedById = new Map(rejectedCandidates.map((r) => [r.actionId, r]));

  const selectedOpts: RankedRecoveryOption[] = [];
  const recommendedActions: DispatcherRecommendedAction[] = sanitized.recommendedActions.map(
    (rec, idx) => {
      const opt = optionById.get(rec.actionId)!;
      selectedOpts.push(opt);

      const tradeoffs = [...rec.tradeoffs];
      if (
        opt.action.usesAssumedStandbyCrew &&
        !tradeoffs.some((t) => t.toLowerCase().includes('standby'))
      ) {
        tradeoffs.push(
          `Relies on configured standby crew assumption (${baseline.config.assumedStandbyCrew.preDepartureBriefingMins}m pre-departure report; not an official dataset record).`
        );
      }

      return {
        rank: idx + 1,
        actionId: opt.action.actionId,
        type: opt.action.type,
        label: opt.action.label,
        title: rec.title,
        reason: rec.reason,
        benefits: rec.benefits,
        tradeoffs,
        operationalImpact: rec.operationalImpact,
        usesAssumedStandbyCrew: opt.action.usesAssumedStandbyCrew,
        deterministicRank: opt.rank,
        deterministicScore: opt.ranking.totalScore,
        verifiedKpiComparison: buildVerifiedKpiBundle(opt),
      };
    }
  );

  // Hydrate alternatives (if Gemini omitted alternatives when extra feasible options exist, supplement deterministically)
  const alternativeActions: DispatcherAlternativeAction[] = sanitized.alternativeActions.map(
    (alt) => {
      const opt = optionById.get(alt.actionId)!;
      return {
        actionId: opt.action.actionId,
        type: opt.action.type,
        label: opt.action.label,
        reasonLessSuitable: alt.reasonLessSuitable,
        keyTradeoff: alt.keyTradeoff,
        deterministicRank: opt.rank,
        deterministicScore: opt.ranking.totalScore,
        usesAssumedStandbyCrew: opt.action.usesAssumedStandbyCrew,
        verifiedDeltas: opt.comparison.deltas,
      };
    }
  );

  if (alternativeActions.length === 0 && rankedOptions.length > 1) {
    const primaryId = recommendedActions[0]?.actionId;
    const altOpt = rankedOptions.find((o) => o.action.actionId !== primaryId);
    if (altOpt) {
      alternativeActions.push({
        actionId: altOpt.action.actionId,
        type: altOpt.action.type,
        label: altOpt.action.label,
        reasonLessSuitable: `Deterministic rank #${altOpt.rank} (score ${altOpt.ranking.totalScore}); lower overall balance compared to primary selection.`,
        keyTradeoff:
          altOpt.comparison.operationalTradeoffs[0] ??
          `Delay delta ${altOpt.comparison.deltas.totalDelayMinutesDelta}m, stranded pax delta ${altOpt.comparison.deltas.totalStrandedPaxDelta}.`,
        deterministicRank: altOpt.rank,
        deterministicScore: altOpt.ranking.totalScore,
        usesAssumedStandbyCrew: altOpt.action.usesAssumedStandbyCrew,
        verifiedDeltas: altOpt.comparison.deltas,
      });
    }
  }

  // Hydrate rejected action explanations strictly from backend rejectedCandidates
  const rejectedActionExplanations: DispatcherRejectedExplanation[] =
    sanitized.rejectedActionExplanations.map((rej) => {
      const backendRej = rejectedById.get(rej.actionId)!;
      return {
        actionId: backendRej.actionId,
        type: backendRej.type,
        label: backendRej.label,
        reason: rej.reason,
        backendFeasibilityReason: backendRej.feasibilityReason,
      };
    });

  if (rejectedActionExplanations.length === 0 && rejectedCandidates.length > 0) {
    for (const rej of rejectedCandidates.slice(0, 5)) {
      rejectedActionExplanations.push({
        actionId: rej.actionId,
        type: rej.type,
        label: rej.label,
        reason: rej.feasibilityReason,
        backendFeasibilityReason: rej.feasibilityReason,
      });
    }
  }

  return {
    aiStatus: 'success',
    source: 'gemini',
    modelUsed,
    preference,
    generatedAtIso: new Date().toISOString(),
    simulationSummary,
    feasibleCandidates: rankedOptions.map((o) => buildCandidateBrief(o.action)),
    rejectedCandidates: rejectedCandidates.map(buildCandidateBrief),
    deterministicRankings: rankedOptions.map(buildDeterministicRankingBrief),
    situationOverview: sanitized.situationOverview,
    recommendedActions,
    alternativeActions,
    rejectedActionExplanations,
    dispatcherSummary: sanitized.dispatcherSummary,
    assumptions: collectAuthoritativeAssumptions(baseline, selectedOpts, sanitized.assumptions),
  };
}

/**
 * Deterministic fallback builder: uses the unmodified deterministic multi-criteria
 * ranking so Domino Sky remains fully functional whenever Gemini is unavailable,
 * times out, hits rate limits, or fails strict response validation.
 */
export function buildDeterministicFallbackResponse(params: {
  aiStatus: Exclude<AiDispatcherStatus, 'success'>;
  modelUsed: string;
  preference: DispatcherPreference;
  fallbackReason: string;
  warningMessage: string;
  validationIssues?: DispatcherValidationIssue[];
  simulationSummary: DispatcherSimulationSummary;
  baseline: SimulationResult;
  rankedOptions: RankedRecoveryOption[];
  rejectedCandidates: RecoveryAction[];
}): DispatcherRecommendResponse {
  const {
    aiStatus,
    modelUsed,
    preference,
    fallbackReason,
    warningMessage,
    validationIssues,
    simulationSummary,
    baseline,
    rankedOptions,
    rejectedCandidates,
  } = params;

  const k = baseline.kpis;
  const closure = baseline.closure;
  const closureDesc = closure
    ? `${closure.airportId} (${simulationSummary.airportCity ?? closure.airportId}) closed ${formatMinutesToClock(closure.startMin)}–${formatMinutesToClock(closure.endMin)} IST (${closure.durationMinutes} minutes)`
    : 'No active airport closure';

  const primaryCauseShape =
    simulationSummary.propagatedImpactedFlightCount > simulationSummary.directImpactedFlightCount
      ? 'primarily propagated downstream across aircraft rotations'
      : 'primarily driven by direct closure hits with downstream rotation carryover';

  const situationOverview =
    k.delayedFlights === 0 && k.cancelledFlights === 0 && k.crewViolationsCount === 0
      ? `${closureDesc}. Deterministic simulation confirms 0 delayed flights, 0 cancelled flights, 0 missed passenger connections, and 0 crew duty violations across all ${k.totalFlights} scheduled flights.`
      : `${closureDesc}. Deterministic simulation recorded ${k.delayedFlights} delayed flights (${k.totalDelayMinutes} minutes total delay, max ${k.maxDelayMinutes} minutes) across ${k.affectedAircraftCount} aircraft (${simulationSummary.directImpactedFlightCount} direct, ${simulationSummary.propagatedImpactedFlightCount} propagated, ${simulationSummary.bothImpactedFlightCount} both — ${primaryCauseShape}). Passenger impact: ${k.missedConnectionsCount} missed connections (${k.missedConnectionPax} pax) and ${k.totalStrandedPaxEstimate} total stranded pax estimate. Crew compliance: ${k.crewViolationsCount} duty-time violations (max overage ${k.maxCrewOverageMins} minutes).`;

  const topThree = rankedOptions.slice(0, 3);
  const recommendedActions: DispatcherRecommendedAction[] = topThree.map((opt, idx) => {
    const d = opt.comparison.deltas;
    const affectedFlights = opt.comparison.flightDiffs
      .filter((f) => f.outcome !== 'unaffected')
      .map((f) => f.flightId);

    const benefits: string[] = [];
    if (d.totalStrandedPaxDelta < 0) {
      benefits.push(
        `Reduces total stranded passenger estimate by ${Math.abs(d.totalStrandedPaxDelta)} pax (${opt.comparison.savedConnectionIds.length} connection(s) saved).`
      );
    }
    if (d.totalDelayMinutesDelta < 0) {
      benefits.push(
        `Reduces total network delay by ${Math.abs(d.totalDelayMinutesDelta)} minutes (${opt.comparison.recoveredFlightIds.length} flight(s) fully recovered on time).`
      );
    }
    if (d.crewViolationsDelta < 0) {
      benefits.push(
        `Resolves ${Math.abs(d.crewViolationsDelta)} crew duty violation(s) (${opt.comparison.resolvedCrewViolationIds.join(', ')}).`
      );
    }
    if (d.cancelledFlightsDelta === 0) {
      benefits.push('Preserves full flight schedule with 0 recovery cancellations.');
    }
    if (benefits.length === 0) {
      benefits.push(`Deterministic composite recovery score ${opt.ranking.totalScore}.`);
    }

    const tradeoffs = [...opt.comparison.operationalTradeoffs];
    if (opt.action.usesAssumedStandbyCrew) {
      tradeoffs.push(
        `Uses assumed standby crew (${baseline.config.assumedStandbyCrew.preDepartureBriefingMins}m pre-departure report; modelling assumption, not verified dataset data).`
      );
    }
    if (tradeoffs.length === 0) {
      tradeoffs.push('No adverse secondary KPI trade-offs observed in deterministic re-simulation.');
    }

    return {
      rank: idx + 1,
      actionId: opt.action.actionId,
      type: opt.action.type,
      label: opt.action.label,
      title: opt.action.label,
      reason: `Selected via deterministic fallback ranking (#${opt.rank}, score ${opt.ranking.totalScore}). ${opt.action.generationReason}`,
      benefits,
      tradeoffs,
      operationalImpact: {
        flightsAffected: affectedFlights,
        passengerImpact: `Stranded pax delta ${d.totalStrandedPaxDelta >= 0 ? '+' : ''}${d.totalStrandedPaxDelta} (${opt.comparison.baseline.kpis.totalStrandedPaxEstimate} -> ${opt.comparison.recovered.kpis.totalStrandedPaxEstimate}); missed connections delta ${d.missedConnectionsDelta >= 0 ? '+' : ''}${d.missedConnectionsDelta}.`,
        crewImpact: opt.action.usesAssumedStandbyCrew
          ? `Crew violations delta ${d.crewViolationsDelta >= 0 ? '+' : ''}${d.crewViolationsDelta} (relying on configured standby crew assumption for spare deployment).`
          : `Crew violations delta ${d.crewViolationsDelta >= 0 ? '+' : ''}${d.crewViolationsDelta}; max crew overage ${opt.comparison.recovered.kpis.maxCrewOverageMins}m.`,
        aircraftImpact: `${opt.action.description} Physical aircraft continuity verified across all rotations.`,
      },
      usesAssumedStandbyCrew: opt.action.usesAssumedStandbyCrew,
      deterministicRank: opt.rank,
      deterministicScore: opt.ranking.totalScore,
      verifiedKpiComparison: buildVerifiedKpiBundle(opt),
    };
  });

  const alternativePool =
    rankedOptions.length > 3 ? rankedOptions.slice(3, 5) : rankedOptions.slice(1, 3);
  const alternativeActions: DispatcherAlternativeAction[] = alternativePool.map((opt) => ({
    actionId: opt.action.actionId,
    type: opt.action.type,
    label: opt.action.label,
    reasonLessSuitable: `Deterministic rank #${opt.rank} (score ${opt.ranking.totalScore}) scored lower than #1 (${rankedOptions[0].action.actionId}, score ${rankedOptions[0].ranking.totalScore}).`,
    keyTradeoff:
      opt.comparison.operationalTradeoffs[0] ??
      `Delay delta ${opt.comparison.deltas.totalDelayMinutesDelta}m; stranded pax delta ${opt.comparison.deltas.totalStrandedPaxDelta}.`,
    deterministicRank: opt.rank,
    deterministicScore: opt.ranking.totalScore,
    usesAssumedStandbyCrew: opt.action.usesAssumedStandbyCrew,
    verifiedDeltas: opt.comparison.deltas,
  }));

  const rejectedActionExplanations: DispatcherRejectedExplanation[] = rejectedCandidates
    .slice(0, 6)
    .map((rej) => ({
      actionId: rej.actionId,
      type: rej.type,
      label: rej.label,
      reason: rej.feasibilityReason,
      backendFeasibilityReason: rej.feasibilityReason,
    }));

  const dispatcherSummary =
    recommendedActions.length === 0
      ? `Deterministic fallback: no feasible recovery candidates were generated for this scenario (${k.delayedFlights} delayed flights, ${k.crewViolationsCount} crew violations). Recommend operational monitoring and reassessment rather than forcing an infeasible action.`
      : `Deterministic fallback ranking recommends ${recommendedActions[0].actionId} (${recommendedActions[0].label}, score ${recommendedActions[0].deterministicScore}) as primary action: total delay delta ${recommendedActions[0].verifiedKpiComparison.deltas.totalDelayMinutesDelta}m, stranded passenger delta ${recommendedActions[0].verifiedKpiComparison.deltas.totalStrandedPaxDelta}, crew violations delta ${recommendedActions[0].verifiedKpiComparison.deltas.crewViolationsDelta}. Note: Gemini preference-aware synthesis was unavailable (${fallbackReason}); results reflect the unmodified deterministic multi-criteria ranking.`;

  return {
    aiStatus,
    source: 'deterministic_fallback',
    modelUsed,
    preference,
    generatedAtIso: new Date().toISOString(),
    fallbackReason,
    warningMessage,
    validationIssues: validationIssues && validationIssues.length > 0 ? validationIssues : undefined,
    simulationSummary,
    feasibleCandidates: rankedOptions.map((o) => buildCandidateBrief(o.action)),
    rejectedCandidates: rejectedCandidates.map(buildCandidateBrief),
    deterministicRankings: rankedOptions.map(buildDeterministicRankingBrief),
    situationOverview,
    recommendedActions,
    alternativeActions,
    rejectedActionExplanations,
    dispatcherSummary,
    assumptions: collectAuthoritativeAssumptions(baseline, topThree),
  };
}
