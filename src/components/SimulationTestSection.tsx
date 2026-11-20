import { useMemo, useState } from 'react';
import { Play, RotateCcw } from 'lucide-react';
import type {
  CrewViolationPolicy,
  NormalizedFlightNetwork,
  SimulatedFlightState,
  SimulationResult,
} from '../types/index.ts';
import { createAirportClosureEvent } from '../engine/closure/index.ts';
import { simulateDisruption, traceCausalChain } from '../engine/propagation/index.ts';
import {
  formatDurationMinutes,
  formatMinutesToClock,
  isValidHHMM,
  parseHHMMToMinutes,
} from '../engine/time.ts';

interface SimulationTestSectionProps {
  network: NormalizedFlightNetwork;
}

type ResultTab = 'flights' | 'connections' | 'crews';
type FlightFilter = 'all' | 'delayed' | 'cancelled' | 'crew_violation';

const DURATION_PRESETS = [60, 120, 180, 240];

export function SimulationTestSection({ network }: SimulationTestSectionProps) {
  const [airportId, setAirportId] = useState<string>('BOM');
  const [startTimeStr, setStartTimeStr] = useState<string>('08:00');
  const [durationMinutes, setDurationMinutes] = useState<number>(120);
  const [enforceCapacity, setEnforceCapacity] = useState<boolean>(true);
  const [crewPolicy, setCrewPolicy] = useState<CrewViolationPolicy>('flag_violation');

  const [inputError, setInputError] = useState<string | null>(null);
  const [result, setResult] = useState<SimulationResult>(() => {
    const initialClosure = createAirportClosureEvent(network, 'BOM', parseHHMMToMinutes('08:00'), 120);
    return simulateDisruption(network, initialClosure, {
      enforceReopeningCapacityMetering: true,
      crewViolationPolicy: 'flag_violation',
    });
  });

  const [resultTab, setResultTab] = useState<ResultTab>('flights');
  const [flightFilter, setFlightFilter] = useState<FlightFilter>('delayed');
  const [selectedFlightId, setSelectedFlightId] = useState<string | null>(null);

  const handleRunSimulation = () => {
    setInputError(null);
    if (!isValidHHMM(startTimeStr.trim())) {
      setInputError('Enter a valid 24-hour start time in HH:MM format (e.g., 08:00).');
      return;
    }
    if (!Number.isFinite(durationMinutes) || durationMinutes < 15 || durationMinutes > 720) {
      setInputError('Closure duration must be between 15 and 720 minutes.');
      return;
    }

    const startMin = parseHHMMToMinutes(startTimeStr.trim());
    const closure = createAirportClosureEvent(network, airportId, startMin, durationMinutes);
    const simResult = simulateDisruption(network, closure, {
      enforceReopeningCapacityMetering: enforceCapacity,
      crewViolationPolicy: crewPolicy,
    });
    setResult(simResult);
    setSelectedFlightId(null);
  };

  const handleRunBaseline = () => {
    setInputError(null);
    const baseline = simulateDisruption(network, null, {
      enforceReopeningCapacityMetering: enforceCapacity,
      crewViolationPolicy: crewPolicy,
    });
    setResult(baseline);
    setFlightFilter('all');
    setSelectedFlightId(null);
  };

  const filteredFlights = useMemo(() => {
    if (flightFilter === 'all') return result.flights;
    if (flightFilter === 'delayed') return result.flights.filter((f) => f.status === 'delayed');
    if (flightFilter === 'cancelled') return result.flights.filter((f) => f.status === 'cancelled');
    return result.flights.filter((f) => f.hasCrewViolation);
  }, [result.flights, flightFilter]);

  const selectedFlight: SimulatedFlightState | null = useMemo(() => {
    if (!selectedFlightId) return null;
    return result.flights.find((f) => f.flightId === selectedFlightId) ?? null;
  }, [result.flights, selectedFlightId]);

  const selectedChain = useMemo(() => {
    if (!selectedFlight) return [];
    return traceCausalChain(result.flights, selectedFlight.flightId);
  }, [result.flights, selectedFlight]);

  const k = result.kpis;

  return (
    <section className="space-y-6">
      <div className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-100">
          Deterministic Engine Verification Harness
        </h1>
        <p className="max-w-3xl text-sm text-slate-400">
          Test the chronological propagation engine directly against the official 16-airport, 70-flight
          network. Every time, delay, connection status, and crew overage below is computed locally
          by pure TypeScript rules.
        </p>
      </div>

      {/* Scenario Input Bar */}
      <div className="rounded-lg border border-slate-800 bg-[#0F172A] p-5 space-y-4">
        <div className="grid gap-4 md:grid-cols-4">
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
            <label htmlFor="closure-duration-input" className="block font-medium text-slate-300">
              Closure Duration (minutes)
            </label>
            <div className="flex items-center gap-2">
              <input
                id="closure-duration-input"
                type="number"
                min={15}
                max={720}
                step={15}
                value={durationMinutes}
                onChange={(e) => setDurationMinutes(Number(e.target.value))}
                className="w-24 rounded-md border border-slate-700 bg-[#090F1A] px-3 py-2 font-mono text-xs text-slate-100 tabular-nums focus:border-teal-500 focus:outline-none"
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
                    {mins / 60}h
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex items-end gap-2">
            <button
              type="button"
              onClick={handleRunSimulation}
              className="inline-flex flex-1 items-center justify-center gap-2 whitespace-nowrap rounded-md bg-teal-500 px-4 py-2 text-xs font-semibold text-slate-950 transition-colors hover:bg-teal-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-300"
            >
              <Play className="h-3.5 w-3.5" />
              Run Simulation
            </button>
            <button
              type="button"
              onClick={handleRunBaseline}
              title="Simulate no-closure baseline"
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-300 transition-colors hover:bg-slate-800 hover:text-slate-100"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              No Closure
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
                className="h-3.5 w-3.5 accent-teal-500"
              />
              <span>Enforce reopening runway capacity metering</span>
            </label>

            <div className="flex items-center gap-2">
              <span className="text-slate-400">Crew Duty Policy:</span>
              <div className="inline-flex rounded-md bg-slate-900 p-0.5">
                <button
                  type="button"
                  onClick={() => setCrewPolicy('flag_violation')}
                  className={`rounded px-2.5 py-1 text-xs transition-colors ${
                    crewPolicy === 'flag_violation'
                      ? 'bg-slate-800 text-teal-300'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Flag Only (Default)
                </button>
                <button
                  type="button"
                  onClick={() => setCrewPolicy('cancel_violating_legs')}
                  className={`rounded px-2.5 py-1 text-xs transition-colors ${
                    crewPolicy === 'cancel_violating_legs'
                      ? 'bg-slate-800 text-amber-300'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Strict Cancel (Opt-in)
                </button>
              </div>
            </div>
          </div>

          <div className="font-mono text-slate-400">
            Active scenario:{' '}
            <span className="text-slate-200">
              {result.closure
                ? `${result.closure.airportId} closed ${formatMinutesToClock(result.closure.startMin)}–${formatMinutesToClock(result.closure.endMin)} (${result.closure.durationMinutes}m)`
                : 'No-closure baseline (nominal schedule)'}
            </span>
          </div>
        </div>

        {inputError && (
          <div role="alert" className="text-xs font-medium text-rose-400">
            {inputError}
          </div>
        )}
      </div>

      {/* Deterministic Summary Metrics */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-800 bg-slate-800 md:grid-cols-4 lg:grid-cols-6">
        <div className="bg-[#0F172A] p-4">
          <div className="text-xs text-slate-400">Flights Operated</div>
          <div className="mt-1 font-mono text-xl font-semibold text-slate-100 tabular-nums">
            {k.operatedFlights} / {k.totalFlights}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            {k.onTimeFlights} on time · {k.cancelledFlights} cancelled
          </div>
        </div>

        <div className="bg-[#0F172A] p-4">
          <div className="text-xs text-slate-400">Delayed Flights</div>
          <div
            className={`mt-1 font-mono text-xl font-semibold tabular-nums ${
              k.delayedFlights > 0 ? 'text-amber-300' : 'text-emerald-400'
            }`}
          >
            {k.delayedFlights}
          </div>
          <div className="mt-1 text-xs text-slate-500">
            {k.affectedAircraftCount} / {network.activeAircraft.length} aircraft affected
          </div>
        </div>

        <div className="bg-[#0F172A] p-4">
          <div className="text-xs text-slate-400">Total / Avg Delay</div>
          <div className="mt-1 font-mono text-xl font-semibold text-slate-100 tabular-nums">
            {formatDurationMinutes(k.totalDelayMinutes)}
          </div>
          <div className="mt-1 font-mono text-xs text-slate-500 tabular-nums">
            avg {k.averageDelayMinutes}m · max {k.maxDelayMinutes}m
          </div>
        </div>

        <div className="bg-[#0F172A] p-4">
          <div className="text-xs text-slate-400">Missed Connections</div>
          <div
            className={`mt-1 font-mono text-xl font-semibold tabular-nums ${
              k.missedConnectionsCount > 0 ? 'text-amber-300' : 'text-emerald-400'
            }`}
          >
            {k.missedConnectionsCount} / {result.connections.length}
          </div>
          <div className="mt-1 font-mono text-xs text-slate-500 tabular-nums">
            {k.missedConnectionPax} connecting pax
          </div>
        </div>

        <div className="bg-[#0F172A] p-4">
          <div className="text-xs text-slate-400">Cancelled Flight Pax</div>
          <div
            className={`mt-1 font-mono text-xl font-semibold tabular-nums ${
              k.cancelledFlightPax > 0 ? 'text-rose-400' : 'text-slate-100'
            }`}
          >
            {k.cancelledFlightPax}
          </div>
          <div className="mt-1 font-mono text-xs text-slate-500 tabular-nums">
            overlap excl: {k.cancelledConnectionOverlapPax}
          </div>
        </div>

        <div className="bg-[#0F172A] p-4">
          <div className="text-xs text-slate-400">Crew Duty Violations</div>
          <div
            className={`mt-1 font-mono text-xl font-semibold tabular-nums ${
              k.crewViolationsCount > 0 ? 'text-rose-400' : 'text-emerald-400'
            }`}
          >
            {k.crewViolationsCount}
          </div>
          <div className="mt-1 font-mono text-xs text-slate-500 tabular-nums">
            max overage +{k.maxCrewOverageMins}m
          </div>
        </div>
      </div>

      {/* Results Inspector */}
      <div className="overflow-hidden rounded-lg border border-slate-800 bg-[#0F172A]">
        <div className="flex flex-col gap-3 border-b border-slate-800 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-1 rounded-md bg-slate-900 p-1">
            {[
              { id: 'flights' as const, label: `Flights & Causes (${result.flights.length})` },
              { id: 'connections' as const, label: `Passenger Connections (${result.connections.length})` },
              { id: 'crews' as const, label: `Crew Duty (${result.crews.length})` },
            ].map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setResultTab(t.id)}
                className={`whitespace-nowrap rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                  resultTab === t.id
                    ? 'bg-slate-800 text-teal-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {resultTab === 'flights' && (
            <div className="flex flex-wrap items-center gap-1 rounded-md bg-slate-900 p-1">
              {[
                { id: 'delayed' as const, label: `Delayed (${k.delayedFlights})` },
                { id: 'cancelled' as const, label: `Cancelled (${k.cancelledFlights})` },
                {
                  id: 'crew_violation' as const,
                  label: `Crew Breach (${result.flights.filter((f) => f.hasCrewViolation).length})`,
                },
                { id: 'all' as const, label: `All (${k.totalFlights})` },
              ].map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setFlightFilter(f.id)}
                  className={`whitespace-nowrap rounded px-2.5 py-1 text-xs transition-colors ${
                    flightFilter === f.id
                      ? 'bg-slate-800 text-slate-100'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Selected Flight Causal Trace Drawer */}
        {resultTab === 'flights' && selectedFlight && (
          <div className="border-b border-slate-800 bg-slate-900/70 p-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-100">
                <span className="font-mono text-teal-300">{selectedFlight.flightId}</span>
                <span>
                  {selectedFlight.origin} → {selectedFlight.destination}
                </span>
                <span className="text-xs font-normal text-slate-400">
                  · {selectedFlight.assignedTailId} · Leg {selectedFlight.legOrder} · Depth{' '}
                  {selectedFlight.dominoDepth} · Position {selectedFlight.aircraftPositionBefore} →{' '}
                  {selectedFlight.aircraftPositionAfter}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setSelectedFlightId(null)}
                className="text-xs text-slate-400 hover:text-slate-200"
              >
                Close trace
              </button>
            </div>

            <p className="text-xs leading-relaxed text-slate-200">
              {selectedFlight.causalExplanation.summary}
            </p>

            <div className="grid gap-3 pt-1 text-xs sm:grid-cols-3 lg:grid-cols-6">
              <div>
                <div className="text-slate-500">Impact Type</div>
                <div className="font-mono text-slate-200">{selectedFlight.impactCategory}</div>
              </div>
              <div>
                <div className="text-slate-500">Upstream Delay In</div>
                <div className="font-mono text-slate-200 tabular-nums">
                  +{selectedFlight.causalExplanation.incomingUpstreamDelayMin}m
                </div>
              </div>
              <div>
                <div className="text-slate-500">Slack Absorbed</div>
                <div className="font-mono text-emerald-400 tabular-nums">
                  -{selectedFlight.causalExplanation.turnaroundSlackAbsorbedMin}m /{' '}
                  {selectedFlight.causalExplanation.turnaroundSlackAvailableMin}m
                </div>
              </div>
              <div>
                <div className="text-slate-500">Closure Ground Hold</div>
                <div className="font-mono text-amber-300 tabular-nums">
                  +{selectedFlight.closureGroundHoldMinutes}m
                </div>
              </div>
              <div>
                <div className="text-slate-500">Airborne Hold</div>
                <div className="font-mono text-amber-300 tabular-nums">
                  +{selectedFlight.airborneHoldMinutes}m
                </div>
              </div>
              <div>
                <div className="text-slate-500">Reopening Slot Queue</div>
                <div className="font-mono text-amber-300 tabular-nums">
                  +{selectedFlight.reopeningSlotDelayMinutes}m
                </div>
              </div>
            </div>

            {selectedChain.length > 1 && (
              <div className="border-t border-slate-800 pt-2.5 text-xs text-slate-400">
                <span className="font-medium text-slate-300">Rotation domino chain: </span>
                <span className="font-mono">
                  {selectedChain
                    .map(
                      (c) =>
                        `${c.flightId} (${c.origin}→${c.destination}, ${
                          c.status === 'cancelled' ? 'CXL' : `+${c.arrivalDelayMin}m`
                        })`
                    )
                    .join('  →  ')}
                </span>
              </div>
            )}
          </div>
        )}

        <div className="overflow-x-auto">
          {resultTab === 'flights' && (
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-900/60 text-slate-400">
                  <th className="px-4 py-3 font-medium">Flight</th>
                  <th className="px-4 py-3 font-medium">Tail</th>
                  <th className="px-4 py-3 font-medium">Route</th>
                  <th className="px-4 py-3 font-medium text-right">Sched</th>
                  <th className="px-4 py-3 font-medium text-right">Actual</th>
                  <th className="px-4 py-3 font-medium text-right">Dep / Arr Delay</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium text-right">Depth</th>
                  <th className="px-4 py-3 font-medium">Primary Cause (click row for trace)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {filteredFlights.map((fl) => {
                  const isSelected = fl.flightId === selectedFlightId;
                  return (
                    <tr
                      key={fl.flightId}
                      onClick={() =>
                        setSelectedFlightId(isSelected ? null : fl.flightId)
                      }
                      className={`cursor-pointer transition-colors ${
                        isSelected ? 'bg-slate-800/80' : 'hover:bg-slate-800/35'
                      }`}
                    >
                      <td className="px-4 py-2.5 font-mono font-semibold text-teal-300">
                        {fl.flightId}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-slate-300">{fl.assignedTailId}</td>
                      <td className="px-4 py-2.5 font-mono text-slate-200 whitespace-nowrap">
                        {fl.origin} → {fl.destination}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-slate-400 tabular-nums whitespace-nowrap">
                        {formatMinutesToClock(fl.scheduledDepMin)}–
                        {formatMinutesToClock(fl.scheduledArrMin)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-slate-200 tabular-nums whitespace-nowrap">
                        {fl.actualDepMin !== null && fl.actualArrMin !== null
                          ? `${formatMinutesToClock(fl.actualDepMin)}–${formatMinutesToClock(fl.actualArrMin)}`
                          : 'Cancelled'}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums whitespace-nowrap">
                        {fl.status === 'cancelled' ? (
                          <span className="text-rose-400">CXL</span>
                        ) : fl.arrivalDelayMin > 0 || fl.departureDelayMin > 0 ? (
                          <span className="text-amber-300">
                            +{fl.departureDelayMin}m / +{fl.arrivalDelayMin}m
                          </span>
                        ) : (
                          <span className="text-slate-500">0m</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        <span
                          className={
                            fl.status === 'cancelled'
                              ? 'font-medium text-rose-400'
                              : fl.status === 'delayed'
                                ? 'font-medium text-amber-300'
                                : 'text-emerald-400'
                          }
                        >
                          {fl.status === 'on_time'
                            ? 'On Time'
                            : fl.status === 'delayed'
                              ? 'Delayed'
                              : 'Cancelled'}
                        </span>
                        {fl.hasCrewViolation && (
                          <span className="ml-1.5 text-rose-400">· Crew Breach</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-slate-400 tabular-nums">
                        {fl.status === 'on_time' ? '—' : fl.dominoDepth}
                      </td>
                      <td className="px-4 py-2.5 text-slate-300">
                        {fl.causalExplanation.primaryTrigger}
                      </td>
                    </tr>
                  );
                })}
                {filteredFlights.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-4 py-8 text-center text-slate-500">
                      No flights match this status filter in the current simulation.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}

          {resultTab === 'connections' && (
            <div className="space-y-0">
              <div className="border-b border-slate-800/80 bg-slate-900/40 px-4 py-2.5 text-xs text-slate-400">
                {result.passengerImpact.countingNote}
              </div>
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-800 bg-slate-900/60 text-slate-400">
                    <th className="px-4 py-3 font-medium">Connection</th>
                    <th className="px-4 py-3 font-medium">Hub</th>
                    <th className="px-4 py-3 font-medium">Feeder → Onward</th>
                    <th className="px-4 py-3 font-medium text-right">Pax</th>
                    <th className="px-4 py-3 font-medium text-right">MCT</th>
                    <th className="px-4 py-3 font-medium text-right">Actual Transfer</th>
                    <th className="px-4 py-3 font-medium">Outcome</th>
                    <th className="px-4 py-3 font-medium">Explanation</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {result.connections.map((c) => (
                    <tr key={c.connectionId} className="hover:bg-slate-800/35">
                      <td className="px-4 py-2.5 font-mono font-semibold text-teal-300">
                        {c.connectionId}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-slate-200">{c.airportId}</td>
                      <td className="px-4 py-2.5 font-mono text-slate-300">
                        {c.fromFlightId} → {c.toFlightId}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-slate-200 tabular-nums">
                        {c.passengers}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-slate-400 tabular-nums">
                        {c.minConnectMinutes}m
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-slate-200 tabular-nums">
                        {c.actualConnectMinutes === null ? '—' : `${c.actualConnectMinutes}m`}
                      </td>
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        <span
                          className={
                            c.status === 'made'
                              ? 'text-emerald-400'
                              : c.status === 'missed_due_to_delay'
                                ? 'font-medium text-amber-300'
                                : 'font-medium text-rose-400'
                          }
                        >
                          {c.status === 'made'
                            ? 'Made'
                            : c.status === 'missed_due_to_delay'
                              ? `Missed (-${c.shortfallMinutes}m)`
                              : 'Cancelled Overlap'}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-slate-400">{c.explanation}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {resultTab === 'crews' && (
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-900/60 text-slate-400">
                  <th className="px-4 py-3 font-medium">Crew</th>
                  <th className="px-4 py-3 font-medium">Tail</th>
                  <th className="px-4 py-3 font-medium text-right">Duty Start</th>
                  <th className="px-4 py-3 font-medium text-right">Actual End</th>
                  <th className="px-4 py-3 font-medium text-right">Actual / Max Duty</th>
                  <th className="px-4 py-3 font-medium text-right">Overage</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Violating Flights</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {result.crews.map((cr) => (
                  <tr key={cr.crewId} className="hover:bg-slate-800/35">
                    <td className="px-4 py-2.5 font-mono font-semibold text-teal-300">
                      {cr.crewId}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-slate-300">{cr.tailId}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-slate-400 tabular-nums">
                      {formatMinutesToClock(cr.dutyStartMin)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-slate-200 tabular-nums">
                      {formatMinutesToClock(cr.actualEndMin)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-slate-200 tabular-nums">
                      {cr.actualDutyMins}m / {cr.maxDutyMins}m
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                      {cr.overageMins > 0 ? (
                        <span className="font-semibold text-rose-400">+{cr.overageMins}m</span>
                      ) : (
                        <span className="text-slate-500">0m</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <span
                        className={
                          cr.isViolation ? 'font-medium text-rose-400' : 'text-emerald-400'
                        }
                      >
                        {cr.isViolation ? 'Duty Violation' : 'Legal'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-slate-300">
                      {cr.violatingFlightIds.length > 0 ? cr.violatingFlightIds.join(', ') : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </section>
  );
}
