/**
 * Domino Sky — Module 09: Strict AI Response Validator
 *
 * Enforces that Gemini output never introduces:
 * - Malformed or empty JSON
 * - Unknown or infeasible/rejected actionIds
 * - More than 3 recommendations (or > available feasible candidates)
 * - Fabricated flight IDs outside the official dataset
 * - Unsupported operational KPI / numerical claims
 */

import type { NormalizedFlightNetwork } from '../../types/dataset.ts';
import type {
  DispatcherValidationIssue,
  DispatcherValidationResult,
  RawGeminiAlternativeAction,
  RawGeminiDispatcherOutput,
  RawGeminiRecommendedAction,
  RawGeminiRejectedExplanation,
} from '../../types/dispatcher.ts';
import type {
  RankedRecoveryOption,
  RecoveryAction,
  SimulationResult,
} from '../../types/simulation.ts';

export interface DispatcherValidationContext {
  network: NormalizedFlightNetwork;
  baseline: SimulationResult;
  rankedOptions: RankedRecoveryOption[];
  rejectedCandidates: RecoveryAction[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function toCleanStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim());
}

/**
 * Collects every verified number present in the deterministic scenario,
 * baseline, feasible comparisons, and official dataset operational constants.
 */
export function collectVerifiedScenarioNumbers(context: DispatcherValidationContext): Set<number> {
  const { network, baseline, rankedOptions } = context;
  const nums = new Set<number>();

  const addNum = (n: number | null | undefined) => {
    if (typeof n !== 'number' || !Number.isFinite(n)) return;
    nums.add(n);
    nums.add(Math.abs(n));
    nums.add(Math.round(n));
    nums.add(Math.abs(Math.round(n)));
    // Also add hour / minute split for durations >= 60m (e.g. 897m = 14h 57m)
    const absInt = Math.abs(Math.round(n));
    if (absInt >= 60) {
      nums.add(Math.floor(absInt / 60));
      nums.add(absInt % 60);
    }
  };

  // Official dataset & policy constants
  for (const c of [
    0,
    1,
    2,
    3,
    4,
    5,
    network.airports.length,
    network.flights.length,
    network.activeAircraft.length,
    network.spareAircraft.length,
    network.connections.length,
    network.crews.length,
    baseline.config.minTurnaroundMinutes,
    baseline.config.assumedStandbyCrew.preDepartureBriefingMins,
    baseline.config.assumedStandbyCrew.maxDutyMins,
    15, // standard delayed-flight passenger threshold
    180, // A320 / spare seat capacity
  ]) {
    addNum(c);
  }

  for (const ap of network.airports) {
    addNum(ap.capacityPerHour);
  }
  for (const ac of [...network.activeAircraft, ...network.spareAircraft]) {
    addNum(ac.seats);
  }

  if (baseline.closure) {
    addNum(baseline.closure.durationMinutes);
    addNum(baseline.closure.startMin);
    addNum(baseline.closure.endMin);
    addNum(Math.floor(baseline.closure.startMin / 60));
    addNum(baseline.closure.startMin % 60);
    addNum(Math.floor(baseline.closure.endMin / 60));
    addNum(baseline.closure.endMin % 60);
    // Hours representation like 2h or 2.5h
    addNum(Number((baseline.closure.durationMinutes / 60).toFixed(1)));
  }

  const addKpis = (k: SimulationResult['kpis']) => {
    for (const val of Object.values(k)) {
      addNum(val);
    }
  };
  addKpis(baseline.kpis);
  addNum(baseline.passengerImpact.delayedFlightPax);
  addNum(baseline.passengerImpact.brokenByCancellationCount);
  addNum(baseline.passengerImpact.preservedConnectionsCount);

  let directCount = 0;
  let propCount = 0;
  let bothCount = 0;
  for (const f of baseline.flights) {
    addNum(f.departureDelayMin);
    addNum(f.arrivalDelayMin);
    addNum(f.closureGroundHoldMinutes);
    addNum(f.airborneHoldMinutes);
    addNum(f.reopeningSlotDelayMinutes);
    addNum(f.turnaroundSlackAbsorbedMin);
    addNum(f.pax);
    addNum(f.dominoDepth);
    if (f.impactCategory === 'direct') directCount++;
    else if (f.impactCategory === 'propagated') propCount++;
    else if (f.impactCategory === 'direct_and_propagated') bothCount++;
  }
  addNum(directCount);
  addNum(propCount);
  addNum(bothCount);
  addNum(directCount + bothCount);
  addNum(propCount + bothCount);

  for (const c of baseline.connections) {
    addNum(c.passengers);
    addNum(c.minConnectMinutes);
    addNum(c.scheduledConnectMinutes);
    addNum(c.actualConnectMinutes);
    addNum(c.shortfallMinutes);
  }

  for (const cr of baseline.crews) {
    addNum(cr.actualDutyMins);
    addNum(cr.scheduledDutyMins);
    addNum(cr.maxDutyMins);
    addNum(cr.overageMins);
    addNum(cr.violatingFlightIds.length);
  }

  for (const rot of baseline.rotations) {
    addNum(rot.totalDelayMin);
    addNum(rot.delayedLegCount);
    addNum(rot.cancelledLegCount);
  }

  for (const opt of rankedOptions) {
    addNum(opt.rank);
    addNum(opt.ranking.totalScore);
    addKpis(opt.comparison.recovered.kpis);
    for (const v of Object.values(opt.comparison.deltas)) {
      addNum(v);
    }
    addNum(opt.comparison.recoveredFlightIds.length);
    addNum(opt.comparison.delayReducedFlightIds.length);
    addNum(opt.comparison.delayIncreasedFlightIds.length);
    addNum(opt.comparison.cancelledForRecoveryFlightIds.length);
    addNum(opt.comparison.improvedFlightIds.length);
    addNum(opt.comparison.worsenedFlightIds.length);
    addNum(opt.comparison.savedConnectionIds.length);
    addNum(opt.comparison.lostConnectionIds.length);
    addNum(opt.comparison.resolvedCrewViolationIds.length);
    addNum(opt.comparison.newlyCreatedCrewViolationIds.length);
    addNum(
      opt.comparison.flightDiffs.filter((d) => d.outcome !== 'unaffected').length
    );
    if (typeof opt.action.parameters.holdMinutes === 'number') {
      addNum(opt.action.parameters.holdMinutes);
    }
    for (const d of opt.comparison.flightDiffs) {
      addNum(d.baselineArrivalDelayMin);
      addNum(d.recoveredArrivalDelayMin);
      addNum(d.arrivalDelayDeltaMin);
    }
  }

  return nums;
}

/**
 * Scans prose fields for explicit operational KPI claims (delay minutes, passenger counts,
 * flight counts, connection counts, crew violation counts) whose numeric value does not exist
 * anywhere in the verified deterministic scenario data.
 */
function findUnsupportedNumericalClaims(
  texts: string[],
  verifiedNumbers: ReadonlySet<number>
): string[] {
  const patterns: Array<{ label: string; regex: RegExp }> = [
    {
      label: 'delay/duration minutes',
      regex:
        /(?:saves?|reduces?|cuts?|adds?|increases?|imposes?|eliminates?|by|of|total|delay|overage|shortfall|hold)\s+[+-]?(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\b/gi,
    },
    {
      label: 'minutes metric',
      regex:
        /\b[+-]?(\d+(?:\.\d+)?)\s*(?:minutes?|mins?)\s+(?:of\s+)?(?:delay|saved|reduction|overage|hold|shortfall|duty|closure)\b/gi,
    },
    {
      label: 'passenger count',
      regex:
        /\b[+-]?(\d+)\s+(?:stranded|affected|connecting|cancelled|disrupted|protected|saved|misconnecting)?\s*(?:passengers?|pax)\b/gi,
    },
    {
      label: 'flight count',
      regex:
        /\b[+-]?(\d+)\s+(?:delayed|cancelled|recovered|affected|disrupted|on-time|operated|downstream)\s+flights?\b/gi,
    },
    {
      label: 'connection count',
      regex:
        /\b[+-]?(\d+)\s+(?:missed|saved|lost|broken|preserved|affected)\s+connections?\b/gi,
    },
    {
      label: 'crew violation count',
      regex:
        /\b[+-]?(\d+)\s+(?:crew\s+)?(?:duty\s+)?(?:violations?|breaches?)\b/gi,
    },
  ];

  const unsupported: string[] = [];
  const seen = new Set<string>();

  for (const text of texts) {
    for (const { label, regex } of patterns) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        const rawVal = Number(match[1]);
        if (!Number.isFinite(rawVal)) continue;
        if (!verifiedNumbers.has(rawVal) && !verifiedNumbers.has(Math.round(rawVal))) {
          const phrase = match[0].trim();
          const key = `${label}:${rawVal}`;
          if (!seen.has(key)) {
            seen.add(key);
            unsupported.push(`Unsupported ${label} claim "${phrase}" (value ${rawVal} not found in deterministic results).`);
          }
        }
      }
    }
  }

  return unsupported;
}

/**
 * Validates raw Gemini JSON text or parsed object strictly against the verified
 * deterministic backend scenario and candidate pool.
 */
export function validateGeminiDispatcherOutput(
  rawInput: string | unknown,
  context: DispatcherValidationContext
): DispatcherValidationResult {
  const issues: DispatcherValidationIssue[] = [];

  let parsed: unknown = rawInput;
  if (typeof rawInput === 'string') {
    const trimmed = rawInput.trim();
    if (!trimmed) {
      return {
        valid: false,
        issues: [{ code: 'EMPTY_RESPONSE', message: 'Gemini returned an empty response.' }],
      };
    }
    // Strip markdown json fences if model unexpectedly wrapped output
    const cleaned = trimmed
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      return {
        valid: false,
        issues: [
          {
            code: 'MALFORMED_JSON',
            message: `Gemini response is not valid JSON: ${err instanceof Error ? err.message : 'parse error'}.`,
          },
        ],
      };
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      valid: false,
      issues: [{ code: 'INVALID_SCHEMA', message: 'Gemini response root must be a JSON object.' }],
    };
  }

  const obj = parsed as Record<string, unknown>;

  if (!isNonEmptyString(obj.situationOverview)) {
    issues.push({
      code: 'INVALID_SCHEMA',
      message: 'Missing non-empty situationOverview.',
    });
  }
  if (!isNonEmptyString(obj.dispatcherSummary)) {
    issues.push({
      code: 'INVALID_SCHEMA',
      message: 'Missing non-empty dispatcherSummary.',
    });
  }
  if (!Array.isArray(obj.recommendedActions)) {
    issues.push({
      code: 'INVALID_SCHEMA',
      message: 'recommendedActions must be an array.',
    });
  }

  if (issues.length > 0) {
    return { valid: false, issues };
  }

  const feasibleById = new Map(context.rankedOptions.map((opt) => [opt.action.actionId, opt]));
  const rejectedById = new Map(context.rejectedCandidates.map((rej) => [rej.actionId, rej]));
  const validFlightIds = new Set(context.network.flights.map((f) => f.flightId));

  const maxAllowedRecs = Math.min(3, context.rankedOptions.length);
  const rawRecs = obj.recommendedActions as unknown[];

  if (rawRecs.length > maxAllowedRecs) {
    issues.push({
      code: 'EXCESS_RECOMMENDATIONS',
      message: `Gemini returned ${rawRecs.length} recommendations, exceeding maximum allowed (${maxAllowedRecs}).`,
    });
  }

  if (context.rankedOptions.length > 0 && rawRecs.length === 0) {
    issues.push({
      code: 'INVALID_SCHEMA',
      message: 'Gemini returned 0 recommendations despite feasible recovery candidates being available.',
    });
  }

  const seenRecIds = new Set<string>();
  const sanitizedRecs: RawGeminiRecommendedAction[] = [];

  for (const entry of rawRecs) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      issues.push({
        code: 'INVALID_SCHEMA',
        message: 'Each recommendedActions entry must be an object.',
      });
      continue;
    }
    const rec = entry as Record<string, unknown>;
    const actionId = typeof rec.actionId === 'string' ? rec.actionId.trim() : '';

    if (!actionId) {
      issues.push({
        code: 'UNKNOWN_ACTION_ID',
        message: 'Recommendation entry is missing an actionId.',
      });
      continue;
    }
    if (rejectedById.has(actionId)) {
      issues.push({
        code: 'INFEASIBLE_ACTION_ID',
        message: `Gemini recommended infeasible/rejected actionId "${actionId}".`,
      });
      continue;
    }
    if (!feasibleById.has(actionId)) {
      issues.push({
        code: 'UNKNOWN_ACTION_ID',
        message: `Gemini recommended unknown actionId "${actionId}" outside verified feasible candidates.`,
      });
      continue;
    }
    if (seenRecIds.has(actionId)) {
      issues.push({
        code: 'DUPLICATE_ACTION_ID',
        message: `Duplicate recommended actionId "${actionId}".`,
      });
      continue;
    }
    seenRecIds.add(actionId);

    const impactObj =
      rec.operationalImpact && typeof rec.operationalImpact === 'object'
        ? (rec.operationalImpact as Record<string, unknown>)
        : null;

    if (
      !isNonEmptyString(rec.title) ||
      !isNonEmptyString(rec.reason) ||
      !impactObj ||
      !isNonEmptyString(impactObj.passengerImpact) ||
      !isNonEmptyString(impactObj.crewImpact) ||
      !isNonEmptyString(impactObj.aircraftImpact)
    ) {
      issues.push({
        code: 'INVALID_SCHEMA',
        message: `Recommendation "${actionId}" is missing required explanation fields.`,
      });
      continue;
    }

    const flightsAffected = toCleanStringArray(impactObj.flightsAffected);
    for (const fid of flightsAffected) {
      if (!validFlightIds.has(fid)) {
        issues.push({
          code: 'UNSUPPORTED_FLIGHT_ID',
          message: `Recommendation "${actionId}" references unsupported flight ID "${fid}".`,
        });
      }
    }

    const opt = feasibleById.get(actionId)!;
    const deterministicAffectedFlights = opt.comparison.flightDiffs
      .filter((d) => d.outcome !== 'unaffected')
      .map((d) => d.flightId);

    sanitizedRecs.push({
      actionId,
      title: rec.title.trim(),
      reason: rec.reason.trim(),
      benefits: toCleanStringArray(rec.benefits),
      tradeoffs: toCleanStringArray(rec.tradeoffs),
      operationalImpact: {
        flightsAffected:
          flightsAffected.length > 0 ? flightsAffected : deterministicAffectedFlights,
        passengerImpact: impactObj.passengerImpact.trim(),
        crewImpact: impactObj.crewImpact.trim(),
        aircraftImpact: impactObj.aircraftImpact.trim(),
      },
    });
  }

  // Validate alternativeActions (keep only verified feasible non-duplicate alternatives; flag invalid IDs)
  const sanitizedAlts: RawGeminiAlternativeAction[] = [];
  const seenAltIds = new Set<string>();
  const rawAlts = Array.isArray(obj.alternativeActions) ? obj.alternativeActions : [];
  for (const entry of rawAlts) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const alt = entry as Record<string, unknown>;
    const actionId = typeof alt.actionId === 'string' ? alt.actionId.trim() : '';
    if (!actionId) continue;

    if (rejectedById.has(actionId)) {
      issues.push({
        code: 'INFEASIBLE_ACTION_ID',
        message: `alternativeActions referenced infeasible actionId "${actionId}".`,
      });
      continue;
    }
    if (!feasibleById.has(actionId)) {
      issues.push({
        code: 'UNKNOWN_ACTION_ID',
        message: `alternativeActions referenced unknown actionId "${actionId}".`,
      });
      continue;
    }
    if (seenAltIds.has(actionId)) continue;
    seenAltIds.add(actionId);

    sanitizedAlts.push({
      actionId,
      reasonLessSuitable: isNonEmptyString(alt.reasonLessSuitable)
        ? alt.reasonLessSuitable.trim()
        : 'Ranked lower for the selected operational objective.',
      keyTradeoff: isNonEmptyString(alt.keyTradeoff)
        ? alt.keyTradeoff.trim()
        : feasibleById.get(actionId)!.comparison.operationalTradeoffs[0] ??
          'Lower overall recovery impact than primary recommendation.',
    });
  }

  // Validate rejectedActionExplanations (must reference actual backend rejectedCandidates)
  const sanitizedRej: RawGeminiRejectedExplanation[] = [];
  const seenRejIds = new Set<string>();
  const rawRejs = Array.isArray(obj.rejectedActionExplanations)
    ? obj.rejectedActionExplanations
    : [];
  for (const entry of rawRejs) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const rej = entry as Record<string, unknown>;
    const actionId = typeof rej.actionId === 'string' ? rej.actionId.trim() : '';
    if (!actionId || seenRejIds.has(actionId)) continue;
    if (!rejectedById.has(actionId)) {
      issues.push({
        code: 'UNKNOWN_ACTION_ID',
        message: `rejectedActionExplanations referenced non-rejected/unknown actionId "${actionId}".`,
      });
      continue;
    }
    seenRejIds.add(actionId);
    sanitizedRej.push({
      actionId,
      reason: isNonEmptyString(rej.reason)
        ? rej.reason.trim()
        : rejectedById.get(actionId)!.feasibilityReason,
    });
  }

  // Check unsupported numerical claims across prose fields
  const verifiedNumbers = collectVerifiedScenarioNumbers(context);
  const allProse: string[] = [
    (obj.situationOverview as string).trim(),
    (obj.dispatcherSummary as string).trim(),
    ...sanitizedRecs.flatMap((r) => [
      r.title,
      r.reason,
      ...r.benefits,
      ...r.tradeoffs,
      r.operationalImpact.passengerImpact,
      r.operationalImpact.crewImpact,
      r.operationalImpact.aircraftImpact,
    ]),
    ...sanitizedAlts.flatMap((a) => [a.reasonLessSuitable, a.keyTradeoff]),
  ];

  const unsupportedClaims = findUnsupportedNumericalClaims(allProse, verifiedNumbers);
  for (const claimMsg of unsupportedClaims) {
    issues.push({
      code: 'UNSUPPORTED_NUMERICAL_CLAIM',
      message: claimMsg,
    });
  }

  if (issues.length > 0) {
    return { valid: false, issues };
  }

  return {
    valid: true,
    issues: [],
    sanitized: {
      situationOverview: (obj.situationOverview as string).trim(),
      recommendedActions: sanitizedRecs,
      alternativeActions: sanitizedAlts,
      rejectedActionExplanations: sanitizedRej,
      dispatcherSummary: (obj.dispatcherSummary as string).trim(),
      assumptions: toCleanStringArray(obj.assumptions),
    },
  };
}
