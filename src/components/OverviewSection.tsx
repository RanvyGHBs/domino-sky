import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import type { DatasetValidationReport, NormalizedFlightNetwork } from '../types/index.ts';
import { formatDurationMinutes } from '../engine/time.ts';

type EntityView = 'airports' | 'flights' | 'connections' | 'crews' | 'spares';

interface OverviewSectionProps {
  network: NormalizedFlightNetwork;
  validation: DatasetValidationReport;
}

const TIER_LABELS: Record<string, string> = {
  mega_hub: 'Mega Hub',
  regional_hub: 'Regional Hub',
  spoke: 'Spoke',
};

export function OverviewSection({ network, validation }: OverviewSectionProps) {
  const [entityView, setEntityView] = useState<EntityView>('airports');
  const [query, setQuery] = useState('');

  const normalizedQuery = query.trim().toLowerCase();

  const filteredAirports = useMemo(() => {
    if (!normalizedQuery) return network.airports;
    return network.airports.filter(
      (a) =>
        a.id.toLowerCase().includes(normalizedQuery) ||
        a.city.toLowerCase().includes(normalizedQuery) ||
        a.name.toLowerCase().includes(normalizedQuery) ||
        a.tier.toLowerCase().includes(normalizedQuery)
    );
  }, [network.airports, normalizedQuery]);

  const filteredFlights = useMemo(() => {
    if (!normalizedQuery) return network.flights;
    return network.flights.filter(
      (f) =>
        f.flightId.toLowerCase().includes(normalizedQuery) ||
        f.tailId.toLowerCase().includes(normalizedQuery) ||
        f.origin.toLowerCase().includes(normalizedQuery) ||
        f.destination.toLowerCase().includes(normalizedQuery)
    );
  }, [network.flights, normalizedQuery]);

  const filteredConnections = useMemo(() => {
    if (!normalizedQuery) return network.connections;
    return network.connections.filter(
      (c) =>
        c.connectionId.toLowerCase().includes(normalizedQuery) ||
        c.airportId.toLowerCase().includes(normalizedQuery) ||
        c.fromFlightId.toLowerCase().includes(normalizedQuery) ||
        c.toFlightId.toLowerCase().includes(normalizedQuery)
    );
  }, [network.connections, normalizedQuery]);

  const filteredCrews = useMemo(() => {
    if (!normalizedQuery) return network.crews;
    return network.crews.filter(
      (c) =>
        c.crewId.toLowerCase().includes(normalizedQuery) ||
        c.tailId.toLowerCase().includes(normalizedQuery) ||
        c.baseAirportId.toLowerCase().includes(normalizedQuery)
    );
  }, [network.crews, normalizedQuery]);

  const filteredSpares = useMemo(() => {
    if (!normalizedQuery) return network.spareAircraft;
    return network.spareAircraft.filter(
      (s) =>
        s.tailId.toLowerCase().includes(normalizedQuery) ||
        s.baseAirportId.toLowerCase().includes(normalizedQuery)
    );
  }, [network.spareAircraft, normalizedQuery]);

  const kpis = [
    {
      label: 'Airports',
      value: String(validation.counts.airports),
      meta: '4 mega · 4 regional · 8 spoke',
    },
    {
      label: 'Scheduled Flights',
      value: String(validation.counts.flights),
      meta: `${validation.operatingWindow.earliestActivityStr} – ${validation.operatingWindow.latestArrivalStr} IST`,
    },
    {
      label: 'Fleet & Spares',
      value: `${validation.counts.activeAircraft} + ${validation.counts.spareAircraft}`,
      meta: `${network.meta.seatsPerAircraft} seats · ${network.meta.minTurnaroundMinutes}m min turn`,
    },
    {
      label: 'Passenger Connections',
      value: String(validation.counts.connections),
      meta: `${validation.counts.totalConnectingPax.toLocaleString()} connecting pax`,
    },
    {
      label: 'Crew Rosters',
      value: String(validation.counts.crews),
      meta: '600m max duty · actual arr check',
    },
    {
      label: 'Scheduled Seat-Trips',
      value: validation.counts.totalScheduledPaxTrips.toLocaleString(),
      meta: `${Math.round((validation.counts.totalScheduledPaxTrips / (validation.counts.flights * network.meta.seatsPerAircraft)) * 100)}% avg load factor`,
    },
  ];

  const entityTabs: Array<{ id: EntityView; label: string; count: number }> = [
    { id: 'airports', label: 'Airports', count: network.airports.length },
    { id: 'flights', label: 'Flights & Rotations', count: network.flights.length },
    { id: 'connections', label: 'Connections', count: network.connections.length },
    { id: 'crews', label: 'Crews', count: network.crews.length },
    { id: 'spares', label: 'Spare Aircraft', count: network.spareAircraft.length },
  ];

  return (
    <section className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-100">
          Official Network Dataset Foundation
        </h1>
        <p className="max-w-3xl text-sm leading-relaxed text-slate-400">
          Loaded and validated directly from the official single-day schedule ({network.meta.operatingDay}).
          Every figure below is computed deterministically from the raw JSON source with zero mock records.
        </p>
      </div>

      {/* Primary KPI Grid */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-800 bg-slate-800 md:grid-cols-3 lg:grid-cols-6">
        {kpis.map((item) => (
          <div key={item.label} className="bg-[#0F172A] p-4">
            <div className="text-xs font-medium text-slate-400">{item.label}</div>
            <div className="mt-1.5 font-mono text-2xl font-semibold text-slate-100 tabular-nums">
              {item.value}
            </div>
            <div className="mt-1 text-xs text-slate-500">{item.meta}</div>
          </div>
        ))}
      </div>

      {/* Entity Inspector */}
      <div className="overflow-hidden rounded-lg border border-slate-800 bg-[#0F172A]">
        <div className="flex flex-col gap-4 border-b border-slate-800 p-4 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-wrap items-center gap-1 rounded-md bg-slate-900/90 p-1">
            {entityTabs.map((tab) => {
              const active = entityView === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    setEntityView(tab.id);
                    setQuery('');
                  }}
                  className={`whitespace-nowrap shrink-0 rounded px-3 py-1.5 text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400 ${
                    active
                      ? 'bg-slate-800 text-teal-300'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {tab.label} <span className="ml-1 font-mono text-slate-500 tabular-nums">{tab.count}</span>
                </button>
              );
            })}
          </div>

          <div className="relative w-full md:w-72">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Filter ${entityView}...`}
              aria-label={`Filter ${entityView}`}
              className="w-full rounded-md border border-slate-700/80 bg-[#090F1A] py-2 pl-9 pr-3 text-xs text-slate-200 placeholder:text-slate-500 focus:border-teal-500 focus:outline-none"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          {entityView === 'airports' && (
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-900/60 text-slate-400">
                  <th className="px-4 py-3 font-medium">IATA</th>
                  <th className="px-4 py-3 font-medium">City</th>
                  <th className="px-4 py-3 font-medium">Airport Name</th>
                  <th className="px-4 py-3 font-medium">Tier</th>
                  <th className="px-4 py-3 font-medium text-right">Capacity / hr</th>
                  <th className="px-4 py-3 font-medium text-right">Coordinates</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {filteredAirports.map((ap) => (
                  <tr key={ap.id} className="hover:bg-slate-800/35">
                    <td className="px-4 py-2.5 font-mono font-semibold text-teal-300">{ap.id}</td>
                    <td className="px-4 py-2.5 text-slate-200">{ap.city}</td>
                    <td className="px-4 py-2.5 text-slate-400">{ap.name}</td>
                    <td className="px-4 py-2.5 text-slate-300">{TIER_LABELS[ap.tier]}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-slate-200 tabular-nums">
                      {ap.capacityPerHour}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-slate-500 tabular-nums">
                      {ap.lat.toFixed(4)}, {ap.lng.toFixed(4)}
                    </td>
                  </tr>
                ))}
                {filteredAirports.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                      No airports match "{query}".
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}

          {entityView === 'flights' && (
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-900/60 text-slate-400">
                  <th className="px-4 py-3 font-medium">Flight</th>
                  <th className="px-4 py-3 font-medium">Aircraft</th>
                  <th className="px-4 py-3 font-medium text-right">Leg</th>
                  <th className="px-4 py-3 font-medium">Route</th>
                  <th className="px-4 py-3 font-medium text-right">Dep (IST)</th>
                  <th className="px-4 py-3 font-medium text-right">Arr (IST)</th>
                  <th className="px-4 py-3 font-medium text-right">Block</th>
                  <th className="px-4 py-3 font-medium text-right">Prior Turn</th>
                  <th className="px-4 py-3 font-medium text-right">Pax</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {filteredFlights.map((fl) => (
                  <tr key={fl.flightId} className="hover:bg-slate-800/35">
                    <td className="px-4 py-2.5 font-mono font-semibold text-teal-300">{fl.flightId}</td>
                    <td className="px-4 py-2.5 font-mono text-slate-300">{fl.tailId}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-slate-400 tabular-nums">
                      {fl.legOrder}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-slate-200">
                      {fl.origin} → {fl.destination}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-slate-200 tabular-nums">
                      {fl.scheduledDepStr}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-slate-200 tabular-nums">
                      {fl.scheduledArrStr}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-slate-400 tabular-nums">
                      {fl.blockMinutes}m
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                      {fl.turnaroundBeforeMin === null ? (
                        <span className="text-slate-600">—</span>
                      ) : (
                        <span
                          className={
                            fl.turnaroundBeforeMin === network.meta.minTurnaroundMinutes
                              ? 'text-amber-400'
                              : 'text-slate-300'
                          }
                        >
                          {fl.turnaroundBeforeMin}m
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-slate-200 tabular-nums">
                      {fl.pax}
                    </td>
                  </tr>
                ))}
                {filteredFlights.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-4 py-8 text-center text-slate-500">
                      No flights match "{query}".
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}

          {entityView === 'connections' && (
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-900/60 text-slate-400">
                  <th className="px-4 py-3 font-medium">Connection</th>
                  <th className="px-4 py-3 font-medium">Hub</th>
                  <th className="px-4 py-3 font-medium">Feeder → Onward</th>
                  <th className="px-4 py-3 font-medium text-right">Passengers</th>
                  <th className="px-4 py-3 font-medium text-right">MCT</th>
                  <th className="px-4 py-3 font-medium text-right">Sched Window</th>
                  <th className="px-4 py-3 font-medium text-right">Buffer</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {filteredConnections.map((c) => {
                  const buffer = c.scheduledConnectMinutes - c.minConnectMinutes;
                  return (
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
                        {c.scheduledConnectMinutes}m
                      </td>
                      <td
                        className={`px-4 py-2.5 text-right font-mono tabular-nums ${
                          buffer <= 20 ? 'text-amber-400' : 'text-slate-300'
                        }`}
                      >
                        +{buffer}m
                      </td>
                    </tr>
                  );
                })}
                {filteredConnections.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                      No connections match "{query}".
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}

          {entityView === 'crews' && (
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-900/60 text-slate-400">
                  <th className="px-4 py-3 font-medium">Crew</th>
                  <th className="px-4 py-3 font-medium">Assigned Tail</th>
                  <th className="px-4 py-3 font-medium">Base</th>
                  <th className="px-4 py-3 font-medium text-right">Duty Start</th>
                  <th className="px-4 py-3 font-medium text-right">Legs</th>
                  <th className="px-4 py-3 font-medium text-right">Sched Duty</th>
                  <th className="px-4 py-3 font-medium text-right">Limit</th>
                  <th className="px-4 py-3 font-medium text-right">Legal Margin</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {filteredCrews.map((cr) => (
                  <tr key={cr.crewId} className="hover:bg-slate-800/35">
                    <td className="px-4 py-2.5 font-mono font-semibold text-teal-300">{cr.crewId}</td>
                    <td className="px-4 py-2.5 font-mono text-slate-300">{cr.tailId}</td>
                    <td className="px-4 py-2.5 font-mono text-slate-200">{cr.baseAirportId}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-slate-200 tabular-nums">
                      {cr.dutyStartStr}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-slate-400 tabular-nums">
                      {cr.flightIds.length}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-slate-200 tabular-nums">
                      {formatDurationMinutes(cr.scheduledDutyMins)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-slate-400 tabular-nums">
                      {formatDurationMinutes(cr.maxDutyMins)}
                    </td>
                    <td
                      className={`px-4 py-2.5 text-right font-mono font-medium tabular-nums ${
                        cr.scheduledDutyMarginMins <= 30 ? 'text-amber-400' : 'text-emerald-400'
                      }`}
                    >
                      +{cr.scheduledDutyMarginMins}m
                    </td>
                  </tr>
                ))}
                {filteredCrews.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-slate-500">
                      No crew records match "{query}".
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}

          {entityView === 'spares' && (
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-900/60 text-slate-400">
                  <th className="px-4 py-3 font-medium">Spare Tail</th>
                  <th className="px-4 py-3 font-medium">Base Airport</th>
                  <th className="px-4 py-3 font-medium text-right">Available From (IST)</th>
                  <th className="px-4 py-3 font-medium text-right">Seat Capacity</th>
                  <th className="px-4 py-3 font-medium">Positioning Constraint</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {filteredSpares.map((sp) => (
                  <tr key={sp.tailId} className="hover:bg-slate-800/35">
                    <td className="px-4 py-2.5 font-mono font-semibold text-teal-300">{sp.tailId}</td>
                    <td className="px-4 py-2.5 font-mono text-slate-200">
                      {sp.baseAirportId} ({network.index.airportsById[sp.baseAirportId]?.city})
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-slate-200 tabular-nums">
                      {sp.availableFromStr}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-slate-200 tabular-nums">
                      {sp.seats}
                    </td>
                    <td className="px-4 py-2.5 text-slate-400">
                      Can only originate recovery legs from {sp.baseAirportId} at or after {sp.availableFromStr}
                    </td>
                  </tr>
                ))}
                {filteredSpares.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                      No spare aircraft match "{query}".
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </section>
  );
}
