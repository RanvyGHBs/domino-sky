import type { DispatcherStatusResponse } from '../types/index.ts';

interface ArchitectureSectionProps {
  dispatcherStatus: DispatcherStatusResponse | null;
}

interface ModuleBlueprint {
  step: string;
  name: string;
  authority: 'Deterministic Engine' | 'Server-Side AI Advisory';
  status: 'Implemented & Verified' | 'Interface Defined (Next Phase)';
  responsibility: string;
}

const ARCHITECTURE_MODULES: ModuleBlueprint[] = [
  {
    step: '01',
    name: 'Dataset Loading & Validation',
    authority: 'Deterministic Engine',
    status: 'Implemented & Verified',
    responsibility:
      'Loads flight_network.json, validates all 7 integrity categories, converts HH:MM to absolute minutes, and builds O(1) indexes.',
  },
  {
    step: '02',
    name: 'Airport Closure Events',
    authority: 'Deterministic Engine',
    status: 'Implemented & Verified',
    responsibility:
      'Creates validated closure windows [startMin, endMin) with explicit departure ground-hold, inbound GDP/airborne-hold, and reopening slot policies.',
  },
  {
    step: '03',
    name: 'Flight Scheduling & Delay Propagation',
    authority: 'Deterministic Engine',
    status: 'Implemented & Verified',
    responsibility:
      'Propagates delays chronologically across closures and aircraft rotations, compressing scheduled turnaround buffer down to 30m and recording 6-point causal traces.',
  },
  {
    step: '04',
    name: 'Aircraft Rotation Tracking',
    authority: 'Deterministic Engine',
    status: 'Implemented & Verified',
    responsibility:
      'Enforces physical aircraft position continuity across cancellations and verifies rotation turnaround & spare positioning invariants.',
  },
  {
    step: '05',
    name: 'Passenger Connection Analysis',
    authority: 'Deterministic Engine',
    status: 'Implemented & Verified',
    responsibility:
      'Evaluates all 21 connections against MCT while separating cancelled-flight pax from missed-connection pax to prevent double counting.',
  },
  {
    step: '06',
    name: 'Crew Duty-Time Analysis',
    authority: 'Deterministic Engine',
    status: 'Implemented & Verified',
    responsibility:
      'Computes actual duty duration from duty_start to actual arrival of each crew’s final operated flight against the 600-minute ceiling (flag_violation default).',
  },
  {
    step: '07',
    name: 'Recovery Action Simulation',
    authority: 'Deterministic Engine',
    status: 'Implemented & Verified',
    responsibility:
      'Generates physically legal recovery candidates (spare deployment, chain cancellation, tail swap, controlled hold), re-simulates each deterministically, and ranks with transparent multi-criteria scores.',
  },
  {
    step: '08',
    name: 'Before-and-After Comparison',
    authority: 'Deterministic Engine',
    status: 'Implemented & Verified',
    responsibility:
      'Produces exact KPI deltas, 5-category flight diffs, improved/worsened/unchanged metrics, resolved crew violations, saved connections, and deterministic trade-offs.',
  },
  {
    step: '09',
    name: 'AI Dispatcher Integration (Server-Side Gemini)',
    authority: 'Server-Side AI Advisory',
    status: 'Interface Defined (Next Phase)',
    responsibility:
      'Receives structured deterministic summaries and pre-validated recovery candidates; returns an actionId and qualitative trade-off analysis without computing numbers.',
  },
];

export function ArchitectureSection({ dispatcherStatus }: ArchitectureSectionProps) {
  return (
    <section className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-100">
          System Architecture &amp; Authority Boundaries
        </h1>
        <p className="max-w-3xl text-sm leading-relaxed text-slate-400">
          Domino Sky separates deterministic operational math from React presentation and server-side
          Gemini reasoning. All numerical outputs originate strictly in TypeScript engine modules.
        </p>
      </div>

      {/* Data Flow & Governance Summary */}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-slate-800 bg-[#0F172A] p-5 space-y-2">
          <div className="text-xs font-medium text-teal-300">Deterministic Authority Pipeline</div>
          <p className="font-mono text-xs leading-6 text-slate-300">
            Official JSON → Validation &amp; Absolute Minutes → Closure Policy → Delay Propagation →
            Rotation / Connection / Crew Analyzers → Recovery Candidates → Before/After Delta
          </p>
          <p className="text-xs text-slate-400">
            Every proposed recovery action (whether selected manually or recommended by Gemini) is
            validated by actionId and re-simulated locally before any numbers are displayed.
          </p>
        </div>

        <div className="rounded-lg border border-slate-800 bg-[#0F172A] p-5 space-y-2">
          <div className="text-xs font-medium text-amber-300">Server-Side AI Dispatcher Readiness</div>
          <p className="text-sm font-medium text-slate-100">
            {dispatcherStatus
              ? dispatcherStatus.available
                ? `Gemini server route configured (${dispatcherStatus.model})`
                : 'Offline deterministic-only fallback active'
              : 'Checking server dispatcher endpoint...'}
          </p>
          <p className="text-xs leading-relaxed text-slate-400">
            {dispatcherStatus?.message ??
              'Verifying Express /api/dispatcher/status route availability.'}
          </p>
        </div>
      </div>

      {/* Module Table */}
      <div className="overflow-hidden rounded-lg border border-slate-800 bg-[#0F172A]">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-900/60 text-slate-400">
                <th className="px-4 py-3 font-medium">Module</th>
                <th className="px-4 py-3 font-medium">Authority</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Responsibility</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {ARCHITECTURE_MODULES.map((mod) => {
                const isDone = mod.status === 'Implemented & Verified';
                return (
                  <tr key={mod.step} className="hover:bg-slate-800/35">
                    <td className="px-4 py-3 font-medium text-slate-100 whitespace-nowrap">
                      <span className="mr-2 font-mono text-slate-500">{mod.step}.</span>
                      {mod.name}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-slate-300">{mod.authority}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className={isDone ? 'font-medium text-emerald-400' : 'text-slate-400'}>
                        {mod.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 leading-relaxed text-slate-400">
                      {mod.responsibility}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
