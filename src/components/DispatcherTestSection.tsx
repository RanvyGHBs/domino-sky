import { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Info,
  Play,
  ShieldAlert,
  Sparkles,
  Users,
  XCircle,
} from 'lucide-react';
import type {
  CrewViolationPolicy,
  DispatcherPreference,
  DispatcherRecommendResponse,
  NormalizedFlightNetwork,
  RecoveryActionType,
} from '../types/index.ts';
import {
  DISPATCHER_PREFERENCE_META,
  VALID_DISPATCHER_PREFERENCES,
} from '../types/dispatcher.ts';
import { requestDispatcherRecommendation } from '../services/dispatcherClient.ts';
import { formatDurationMinutes, formatMinutesToClock, isValidHHMM } from '../engine/time.ts';

interface DispatcherTestSectionProps {
  network: NormalizedFlightNetwork;
}

const DURATION_PRESETS = [60, 120, 150, 180];

const ACTION_TYPE_LABELS: Record<RecoveryActionType, string> = {
  deploy_spare_aircraft: 'Deploy Spare Aircraft',
  cancel_flight_chain: 'Cancel Flight Chain',
  hold_connection_flight: 'Controlled Departure Hold',
  swap_aircraft_rotations: 'Swap Aircraft Rotations',
};

function formatDelta(val: number, suffix = ''): { text: string; tone: string } {
  if (val === 0) return { text: `0${suffix}`, tone: 'text-slate-400' };
  if (val < 0) return { text: `${val}${suffix}`, tone: 'text-emerald-400 font-semibold' };
  return { text: `+${val}${suffix}`, tone: 'text-amber-400 font-semibold' };
}

export function DispatcherTestSection({ network }: DispatcherTestSectionProps) {
  const [airportId, setAirportId] = useState<string>('BOM');
  const [startTimeStr, setStartTimeStr] = useState<string>('08:00');
  const [durationMinutes, setDurationMinutes] = useState<number>(120);
  const [preference, setPreference] = useState<DispatcherPreference>('balanced');
  const [enforceCapacity, setEnforceCapacity] = useState<boolean>(true);
  const [crewPolicy, setCrewPolicy] = useState<CrewViolationPolicy>('flag_violation');

  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [response, setResponse] = useState<DispatcherRecommendResponse | null>(null);

  const handleRunDispatcher = async () => {
    setErrorMsg(null);
    if (!isValidHHMM(startTimeStr.trim())) {
      setErrorMsg('Enter a valid 24-hour closure start time in HH:MM format (e.g., 08:00).');
      return;
    }
    if (!Number.isFinite(durationMinutes) || durationMinutes < 1 || durationMinutes > 720) {
      setErrorMsg('Closure duration must be between 1 and 720 minutes.');
      return;
    }

    setIsRunning(true);
    try {
      const data = await requestDispatcherRecommendation({
        airportId,
        startTime: startTimeStr.trim(),
        durationMinutes,
        preference,
        config: {
          enforceReopeningCapacityMetering: enforceCapacity,
          crewViolationPolicy: crewPolicy,
        },
      });
      setResponse(data);
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Failed to run AI Dispatcher recommendation.'
      );
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <section className="space-y-6">
      <div className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-100">
          AI Dispatcher Test Console
        </h1>
        <p className="max-w-3xl text-sm text-slate-400">
          Tests Module 09 end-to-end: the backend executes the deterministic simulation and recovery
          engines first, passes verified results to Gemini for preference-aware reasoning, validates
          every output ID and metric, and falls back to the deterministic ranking automatically if
          Gemini is unavailable.
        </p>
      </div>

      {/* Controls */}
      <div className="rounded-lg border border-slate-800 bg-[#0F172A] p-5 space-y-4">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
          <label className="space-y-1.5 text-xs">
            <span className="block font-medium text-slate-300">Closed Airport</span>
            <select
              value={airportId}
              onChange={(e) => setAirportId(e.target.value)}
              className="w-full rounded-md border border-slate-700 bg-[#090F1A] px-3 py-2 text-xs text-slate-100 focus:border-teal-500 focus:outline-none"
            >
              {network.airports.map((ap) => (
                <option key={ap.id} value={ap.id}>
                  {ap.id} — {ap.city} ({ap.capacityPerHour}/hr)
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1.5 text-xs">
            <span className="block font-medium text-slate-300">Closure Start (IST HH:MM)</span>
            <input
              type="text"
              value={startTimeStr}
              onChange={(e) => setStartTimeStr(e.target.value)}
              placeholder="08:00"
              className="w-full rounded-md border border-slate-700 bg-[#090F1A] px-3 py-2 font-mono text-xs text-slate-100 focus:border-teal-500 focus:outline-none"
            />
          </label>

          <div className="space-y-1.5 text-xs">
            <label htmlFor="dispatcher-duration-input" className="block font-medium text-slate-300">
              Duration (minutes)
            </label>
            <div className="flex items-center gap-2">
              <input
                id="dispatcher-duration-input"
                type="number"
                min={15}
                max={720}
                step={15}
                value={durationMinutes}
                onChange={(e) => setDurationMinutes(Number(e.target.value))}
                className="w-20 rounded-md border border-slate-700 bg-[#090F1A] px-2.5 py-2 font-mono text-xs text-slate-100 tabular-nums focus:border-teal-500 focus:outline-none"
              />
              <div className="flex items-center gap-1">
                {DURATION_PRESETS.map((mins) => (
                  <button
                    key={mins}
                    type="button"
                    onClick={() => setDurationMinutes(mins)}
                    className={`rounded px-2 py-1.5 font-mono text-xs transition-colors ${
                      durationMinutes === mins
                        ? 'bg-slate-700 text-teal-300'
                        : 'bg-slate-900 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {mins}m
                  </button>
                ))}
              </div>
            </div>
          </div>

          <label className="space-y-1.5 text-xs">
            <span className="block font-medium text-slate-300">Dispatcher Preference</span>
            <select
              value={preference}
              onChange={(e) => setPreference(e.target.value as DispatcherPreference)}
              className="w-full rounded-md border border-slate-700 bg-[#090F1A] px-3 py-2 text-xs text-slate-100 focus:border-teal-500 focus:outline-none"
            >
              {VALID_DISPATCHER_PREFERENCES.map((pref) => (
                <option key={pref} value={pref}>
                  {DISPATCHER_PREFERENCE_META[pref].label}
                </option>
              ))}
            </select>
          </label>

          <div className="flex items-end">
            <button
              type="button"
              onClick={handleRunDispatcher}
              disabled={isRunning}
              className="inline-flex w-full items-center justify-center gap-2 whitespace-nowrap rounded-md bg-teal-500 px-4 py-2 text-xs font-semibold text-slate-950 transition-colors hover:bg-teal-400 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-300"
            >
              <Play className="h-3.5 w-3.5" />
              {isRunning ? 'Running Dispatcher...' : 'Run AI Dispatcher'}
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-800/80 pt-3 text-xs">
          <div className="flex flex-wrap items-center gap-5">
            <label className="inline-flex items-center gap-2 text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={enforceCapacity}
                onChange={(e) => setEnforceCapacity(e.target.checked)}
                className="rounded border-slate-600 bg-slate-900 text-teal-500 focus:ring-teal-500"
              />
              Enforce reopening runway capacity metering
            </label>

            <label className="inline-flex items-center gap-2 text-slate-300">
              <span>Crew duty policy:</span>
              <select
                value={crewPolicy}
                onChange={(e) => setCrewPolicy(e.target.value as CrewViolationPolicy)}
                className="rounded border border-slate-700 bg-[#090F1A] px-2 py-1 text-xs text-slate-200 focus:border-teal-500 focus:outline-none"
              >
                <option value="flag_violation">Flag violations only (Default)</option>
                <option value="cancel_violating_legs">Strict: cancel violating legs</option>
              </select>
            </label>
          </div>

          <span className="text-slate-400">
            Objective: <span className="text-slate-200">{DISPATCHER_PREFERENCE_META[preference].description}</span>
          </span>
        </div>

        {errorMsg && (
          <div
            role="alert"
            className="flex items-center gap-2 rounded-md border border-rose-500/40 bg-rose-950/30 px-3 py-2 text-xs text-rose-200"
          >
            <AlertTriangle className="h-4 w-4 shrink-0 text-rose-400" />
            <span>{errorMsg}</span>
          </div>
        )}
      </div>

      {/* Empty Initial State */}
      {!response && !isRunning && (
        <div className="rounded-lg border border-dashed border-slate-800 bg-[#0F172A]/50 p-8 text-center space-y-2">
          <p className="text-sm font-medium text-slate-200">
            Configure a disruption scenario and click <span className="text-teal-300">Run AI Dispatcher</span>
          </p>
          <p className="text-xs text-slate-400">
            Try BOM 08:00 (120m) for multi-hub delay propagation and spare/hold trade-offs, or DEL
            12:00 (150m) with &ldquo;Protect Crew Compliance&rdquo; to evaluate crew duty violation recovery.
          </p>
        </div>
      )}

      {/* Loading State */}
      {isRunning && (
        <div className="space-y-4" aria-busy="true" aria-label="Running AI Dispatcher">
          <div className="h-20 animate-pulse rounded-lg border border-slate-800 bg-[#0F172A]" />
          <div className="grid gap-4 md:grid-cols-2">
            <div className="h-64 animate-pulse rounded-lg border border-slate-800 bg-[#0F172A]" />
            <div className="h-64 animate-pulse rounded-lg border border-slate-800 bg-[#0F172A]" />
          </div>
        </div>
      )}

      {/* Results */}
      {response && !isRunning && (
        <div className="space-y-6">
          {/* Source & Governance Banner */}
          <div
            className={`rounded-lg border p-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between ${
              response.source === 'gemini'
                ? 'border-teal-500/40 bg-teal-950/20'
                : 'border-amber-500/40 bg-amber-950/20'
            }`}
          >
            <div className="flex items-start gap-3">
              {response.source === 'gemini' ? (
                <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-teal-400" />
              ) : (
                <Cpu className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
              )}
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-100">
                  <span>
                    {response.source === 'gemini'
                      ? `Gemini AI Dispatcher Active (${response.modelUsed})`
                      : `Deterministic Fallback Active (${response.aiStatus.toUpperCase()})`}
                  </span>
                  <span className="font-mono text-xs font-normal text-slate-400">
                    · Preference: {DISPATCHER_PREFERENCE_META[response.preference].label}
                  </span>
                </div>
                <p className="text-xs text-slate-300">
                  {response.source === 'gemini'
                    ? 'Narrative selection and trade-off explanations were generated by Gemini and strictly validated. All numerical KPIs below are attached directly from the deterministic TypeScript engine.'
                    : response.warningMessage ||
                      'Gemini was unavailable; recommendations reflect the unmodified deterministic multi-criteria ranking.'}
                </p>
              </div>
            </div>

            <div className="shrink-0 text-right font-mono text-xs text-slate-400">
              <div>Feasible: {response.feasibleCandidates.length}</div>
              <div>Rejected: {response.rejectedCandidates.length}</div>
            </div>
          </div>

          {/* Situation Overview + Baseline Verified Metrics */}
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2 rounded-lg border border-slate-800 bg-[#0F172A] p-5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-slate-100">Situation Overview</h2>
                <span className="font-mono text-[11px] text-teal-300">
                  {response.source === 'gemini'
                    ? 'AI-Generated Synthesis (Verified Grounding)'
                    : 'Deterministic Engine Summary'}
                </span>
              </div>
              <p className="text-xs leading-relaxed text-slate-300">{response.situationOverview}</p>

              <div className="border-t border-slate-800/80 pt-3">
                <h3 className="text-xs font-semibold text-slate-200 mb-1">Dispatcher Summary</h3>
                <p className="text-xs leading-relaxed text-slate-300">
                  {response.dispatcherSummary}
                </p>
              </div>
            </div>

            {/* Verified Baseline KPIs */}
            <div className="rounded-lg border border-slate-800 bg-[#0F172A] p-5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-slate-100">Baseline Disruption</h2>
                <span className="font-mono text-[11px] text-emerald-400">Backend Verified</span>
              </div>
              {response.simulationSummary.closure && (
                <div className="font-mono text-xs text-slate-300">
                  {response.simulationSummary.closure.airportId} ·{' '}
                  {formatMinutesToClock(response.simulationSummary.closure.startMin)}–
                  {formatMinutesToClock(response.simulationSummary.closure.endMin)} IST (
                  {response.simulationSummary.closure.durationMinutes}m)
                </div>
              )}
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-xs">
                <div>
                  <dt className="text-slate-400">Delayed Flights</dt>
                  <dd className="font-mono text-sm font-semibold text-slate-100 tabular-nums">
                    {response.simulationSummary.kpis.delayedFlights} /{' '}
                    {response.simulationSummary.kpis.totalFlights}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-400">Total Delay</dt>
                  <dd className="font-mono text-sm font-semibold text-slate-100 tabular-nums">
                    {formatDurationMinutes(response.simulationSummary.kpis.totalDelayMinutes)} (
                    {response.simulationSummary.kpis.totalDelayMinutes}m)
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-400">Missed Connections</dt>
                  <dd className="font-mono text-sm font-semibold text-amber-300 tabular-nums">
                    {response.simulationSummary.kpis.missedConnectionsCount} (
                    {response.simulationSummary.kpis.missedConnectionPax} pax)
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-400">Stranded Pax Est.</dt>
                  <dd className="font-mono text-sm font-semibold text-rose-300 tabular-nums">
                    {response.simulationSummary.kpis.totalStrandedPaxEstimate}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-400">Crew Violations</dt>
                  <dd className="font-mono text-sm font-semibold text-slate-100 tabular-nums">
                    {response.simulationSummary.kpis.crewViolationsCount} (max +
                    {response.simulationSummary.kpis.maxCrewOverageMins}m)
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-400">Direct vs Propagated</dt>
                  <dd className="font-mono text-sm font-semibold text-slate-100 tabular-nums">
                    {response.simulationSummary.directImpactedFlightCount}d /{' '}
                    {response.simulationSummary.propagatedImpactedFlightCount}p
                  </dd>
                </div>
              </dl>
            </div>
          </div>

          {/* Recommended Recovery Actions */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-100">
                Recommended Recovery Actions ({response.recommendedActions.length})
              </h2>
              <span className="text-xs text-slate-400">
                Qualitative reasoning separated from backend-verified KPI deltas
              </span>
            </div>

            {response.recommendedActions.length === 0 ? (
              <div className="rounded-lg border border-slate-800 bg-[#0F172A] p-5 text-xs text-slate-300">
                No feasible recovery actions exist for this scenario. Follow operational monitoring
                and reassessment guidance above.
              </div>
            ) : (
              <div className="space-y-4">
                {response.recommendedActions.map((rec) => {
                  const kpi = rec.verifiedKpiComparison;
                  const delayDelta = formatDelta(kpi.deltas.totalDelayMinutesDelta, 'm');
                  const strandedDelta = formatDelta(kpi.deltas.totalStrandedPaxDelta, ' pax');
                  const missedConnDelta = formatDelta(kpi.deltas.missedConnectionsDelta);
                  const cancelDelta = formatDelta(kpi.deltas.cancelledFlightsDelta);
                  const crewDelta = formatDelta(kpi.deltas.crewViolationsDelta);

                  return (
                    <article
                      key={rec.actionId}
                      className="rounded-lg border border-slate-800 bg-[#0F172A] overflow-hidden"
                    >
                      {/* Header */}
                      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 bg-slate-900/60 px-5 py-3.5">
                        <div className="space-y-0.5">
                          <div className="flex flex-wrap items-center gap-2.5">
                            <span className="font-mono text-xs font-bold text-teal-300">
                              #{rec.rank}
                            </span>
                            <h3 className="text-sm font-semibold text-slate-100">{rec.title}</h3>
                            <span className="font-mono text-[11px] text-slate-400">
                              {ACTION_TYPE_LABELS[rec.type]}
                            </span>
                          </div>
                          <div className="font-mono text-[11px] text-slate-400">
                            actionId: <span className="text-slate-200">{rec.actionId}</span> ·
                            Deterministic Rank #{rec.deterministicRank} (Score{' '}
                            {rec.deterministicScore})
                          </div>
                        </div>

                        {rec.usesAssumedStandbyCrew && (
                          <div className="inline-flex items-center gap-1.5 rounded border border-amber-500/40 bg-amber-950/30 px-2.5 py-1 text-[11px] text-amber-200">
                            <Info className="h-3.5 w-3.5 text-amber-400" />
                            Uses Assumed Standby Crew
                          </div>
                        )}
                      </div>

                      <div className="grid gap-5 p-5 lg:grid-cols-12">
                        {/* Left: AI Reasoning & Operational Impact */}
                        <div className="lg:col-span-7 space-y-4">
                          <div className="space-y-1">
                            <div className="text-[11px] font-mono uppercase tracking-wider text-teal-300">
                              {response.source === 'gemini'
                                ? 'AI Selection Rationale'
                                : 'Deterministic Fallback Rationale'}
                            </div>
                            <p className="text-xs leading-relaxed text-slate-200">{rec.reason}</p>
                          </div>

                          <div className="grid gap-3 sm:grid-cols-2">
                            <div className="rounded-md border border-slate-800 bg-[#090F1A] p-3 space-y-1.5">
                              <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-400">
                                <CheckCircle2 className="h-3.5 w-3.5" />
                                Benefits
                              </div>
                              <ul className="space-y-1 text-xs text-slate-300 list-disc pl-4">
                                {rec.benefits.map((b, i) => (
                                  <li key={i}>{b}</li>
                                ))}
                              </ul>
                            </div>

                            <div className="rounded-md border border-slate-800 bg-[#090F1A] p-3 space-y-1.5">
                              <div className="flex items-center gap-1.5 text-xs font-medium text-amber-400">
                                <AlertTriangle className="h-3.5 w-3.5" />
                                Trade-offs &amp; Risks
                              </div>
                              <ul className="space-y-1 text-xs text-slate-300 list-disc pl-4">
                                {rec.tradeoffs.map((t, i) => (
                                  <li key={i}>{t}</li>
                                ))}
                              </ul>
                            </div>
                          </div>

                          <div className="grid gap-3 sm:grid-cols-3 text-xs">
                            <div className="space-y-1">
                              <div className="flex items-center gap-1 font-medium text-slate-200">
                                <Users className="h-3.5 w-3.5 text-slate-400" />
                                Passenger Impact
                              </div>
                              <p className="text-slate-400 leading-relaxed">
                                {rec.operationalImpact.passengerImpact}
                              </p>
                            </div>
                            <div className="space-y-1">
                              <div className="flex items-center gap-1 font-medium text-slate-200">
                                <ShieldAlert className="h-3.5 w-3.5 text-slate-400" />
                                Crew Implications
                              </div>
                              <p className="text-slate-400 leading-relaxed">
                                {rec.operationalImpact.crewImpact}
                              </p>
                            </div>
                            <div className="space-y-1">
                              <div className="font-medium text-slate-200">Aircraft Rotation</div>
                              <p className="text-slate-400 leading-relaxed">
                                {rec.operationalImpact.aircraftImpact}
                              </p>
                            </div>
                          </div>

                          <div className="text-xs text-slate-400">
                            <span className="font-medium text-slate-300">Flights Affected: </span>
                            <span className="font-mono text-slate-300">
                              {rec.operationalImpact.flightsAffected.length > 0
                                ? rec.operationalImpact.flightsAffected.join(', ')
                                : 'None'}
                            </span>
                          </div>
                        </div>

                        {/* Right: Backend-Verified Before / After KPI Comparison */}
                        <div className="lg:col-span-5 rounded-md border border-slate-800 bg-[#090F1A] p-4 space-y-3">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-semibold text-slate-100">
                              Before / After KPIs
                            </span>
                            <span className="font-mono text-[11px] text-emerald-400">
                              Backend Verified
                            </span>
                          </div>

                          <table className="w-full text-xs tabular-nums">
                            <thead>
                              <tr className="border-b border-slate-800 text-left text-slate-400">
                                <th className="py-1.5 font-medium">Metric</th>
                                <th className="py-1.5 text-right font-medium">Before</th>
                                <th className="py-1.5 text-right font-medium">After</th>
                                <th className="py-1.5 text-right font-medium">Delta</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800/70 font-mono">
                              <tr>
                                <td className="py-1.5 font-sans text-slate-300">Total Delay</td>
                                <td className="py-1.5 text-right text-slate-400">
                                  {kpi.before.totalDelayMinutes}m
                                </td>
                                <td className="py-1.5 text-right text-slate-100">
                                  {kpi.after.totalDelayMinutes}m
                                </td>
                                <td className={`py-1.5 text-right ${delayDelta.tone}`}>
                                  {delayDelta.text}
                                </td>
                              </tr>
                              <tr>
                                <td className="py-1.5 font-sans text-slate-300">Delayed Flights</td>
                                <td className="py-1.5 text-right text-slate-400">
                                  {kpi.before.delayedFlights}
                                </td>
                                <td className="py-1.5 text-right text-slate-100">
                                  {kpi.after.delayedFlights}
                                </td>
                                <td
                                  className={`py-1.5 text-right ${formatDelta(kpi.deltas.delayedFlightsDelta).tone}`}
                                >
                                  {formatDelta(kpi.deltas.delayedFlightsDelta).text}
                                </td>
                              </tr>
                              <tr>
                                <td className="py-1.5 font-sans text-slate-300">Cancelled Flights</td>
                                <td className="py-1.5 text-right text-slate-400">
                                  {kpi.before.cancelledFlights}
                                </td>
                                <td className="py-1.5 text-right text-slate-100">
                                  {kpi.after.cancelledFlights}
                                </td>
                                <td className={`py-1.5 text-right ${cancelDelta.tone}`}>
                                  {cancelDelta.text}
                                </td>
                              </tr>
                              <tr>
                                <td className="py-1.5 font-sans text-slate-300">Missed Conns</td>
                                <td className="py-1.5 text-right text-slate-400">
                                  {kpi.before.missedConnectionsCount}
                                </td>
                                <td className="py-1.5 text-right text-slate-100">
                                  {kpi.after.missedConnectionsCount}
                                </td>
                                <td className={`py-1.5 text-right ${missedConnDelta.tone}`}>
                                  {missedConnDelta.text}
                                </td>
                              </tr>
                              <tr>
                                <td className="py-1.5 font-sans text-slate-300">Stranded Pax</td>
                                <td className="py-1.5 text-right text-slate-400">
                                  {kpi.before.totalStrandedPaxEstimate}
                                </td>
                                <td className="py-1.5 text-right text-slate-100">
                                  {kpi.after.totalStrandedPaxEstimate}
                                </td>
                                <td className={`py-1.5 text-right ${strandedDelta.tone}`}>
                                  {strandedDelta.text}
                                </td>
                              </tr>
                              <tr>
                                <td className="py-1.5 font-sans text-slate-300">Crew Violations</td>
                                <td className="py-1.5 text-right text-slate-400">
                                  {kpi.before.crewViolationsCount}
                                </td>
                                <td className="py-1.5 text-right text-slate-100">
                                  {kpi.after.crewViolationsCount}
                                </td>
                                <td className={`py-1.5 text-right ${crewDelta.tone}`}>
                                  {crewDelta.text}
                                </td>
                              </tr>
                            </tbody>
                          </table>

                          <div className="border-t border-slate-800/80 pt-2 text-[11px] text-slate-400 space-y-1">
                            <div>
                              Recovered on-time:{' '}
                              <span className="font-mono text-emerald-300">
                                {kpi.recoveredFlightIds.length > 0
                                  ? kpi.recoveredFlightIds.join(', ')
                                  : 'None'}
                              </span>
                            </div>
                            {kpi.savedConnectionIds.length > 0 && (
                              <div>
                                Saved connections:{' '}
                                <span className="font-mono text-emerald-300">
                                  {kpi.savedConnectionIds.join(', ')}
                                </span>
                              </div>
                            )}
                            {kpi.resolvedCrewViolationIds.length > 0 && (
                              <div>
                                Resolved crew violations:{' '}
                                <span className="font-mono text-emerald-300">
                                  {kpi.resolvedCrewViolationIds.join(', ')}
                                </span>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>

          {/* Alternatives & Rejected Candidates */}
          <div className="grid gap-4 lg:grid-cols-2">
            {/* Alternative Actions */}
            <div className="rounded-lg border border-slate-800 bg-[#0F172A] p-5 space-y-3">
              <h2 className="text-sm font-semibold text-slate-100">
                Feasible Alternatives Considered ({response.alternativeActions.length})
              </h2>
              {response.alternativeActions.length === 0 ? (
                <p className="text-xs text-slate-400">No additional feasible alternatives.</p>
              ) : (
                <div className="space-y-3">
                  {response.alternativeActions.map((alt) => (
                    <div
                      key={alt.actionId}
                      className="rounded-md border border-slate-800 bg-[#090F1A] p-3 space-y-1 text-xs"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono font-semibold text-slate-200">
                          {alt.actionId}
                        </span>
                        <span className="font-mono text-[11px] text-slate-400">
                          Rank #{alt.deterministicRank} · Delay {alt.verifiedDeltas.totalDelayMinutesDelta}m · Pax{' '}
                          {alt.verifiedDeltas.totalStrandedPaxDelta}
                        </span>
                      </div>
                      <p className="text-slate-300">{alt.reasonLessSuitable}</p>
                      <p className="text-slate-400">Trade-off: {alt.keyTradeoff}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Rejected Candidates */}
            <div className="rounded-lg border border-slate-800 bg-[#0F172A] p-5 space-y-3">
              <h2 className="text-sm font-semibold text-slate-100">
                Rejected / Infeasible Actions ({response.rejectedActionExplanations.length} shown of{' '}
                {response.rejectedCandidates.length})
              </h2>
              {response.rejectedActionExplanations.length === 0 ? (
                <p className="text-xs text-slate-400">
                  No candidate actions were rejected by physical or crew feasibility rules in this
                  scenario.
                </p>
              ) : (
                <div className="space-y-2.5 max-h-72 overflow-y-auto pr-1">
                  {response.rejectedActionExplanations.map((rej) => (
                    <div
                      key={rej.actionId}
                      className="rounded-md border border-rose-900/40 bg-rose-950/15 p-3 space-y-1 text-xs"
                    >
                      <div className="flex items-center gap-1.5 font-mono font-semibold text-rose-200">
                        <XCircle className="h-3.5 w-3.5 shrink-0 text-rose-400" />
                        <span>{rej.actionId}</span>
                      </div>
                      <p className="text-slate-300">{rej.reason}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Active Assumptions */}
          <div className="rounded-lg border border-slate-800 bg-[#0F172A] p-5 space-y-2.5">
            <h2 className="text-sm font-semibold text-slate-100">
              Active Modelling Assumptions &amp; Governance Disclosures
            </h2>
            <ul className="space-y-1.5 text-xs text-slate-300 list-disc pl-5">
              {response.assumptions.map((assumption, idx) => (
                <li key={idx}>{assumption}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
