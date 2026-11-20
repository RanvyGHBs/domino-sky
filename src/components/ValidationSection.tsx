import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import type { DatasetValidationReport, ValidationSeverity } from '../types/index.ts';

interface ValidationSectionProps {
  validation: DatasetValidationReport;
}

const SEVERITY_META: Record<
  ValidationSeverity,
  { label: string; textClass: string; Icon: typeof CheckCircle2 }
> = {
  pass: {
    label: 'Passed',
    textClass: 'text-emerald-400',
    Icon: CheckCircle2,
  },
  warning: {
    label: 'Operational Watch',
    textClass: 'text-amber-400',
    Icon: AlertTriangle,
  },
  error: {
    label: 'Error',
    textClass: 'text-rose-400',
    Icon: XCircle,
  },
};

export function ValidationSection({ validation }: ValidationSectionProps) {
  return (
    <section className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100">
            Referential Integrity &amp; Schedule Validation
          </h1>
          <p className="max-w-3xl text-sm text-slate-400">
            Live verification executed client-side against the official JSON dataset across airports,
            aircraft rotations, turnarounds, passenger connections, crew duty windows, and spare fleet.
          </p>
        </div>

        <div className="flex items-center gap-4 text-xs text-slate-400 font-mono tabular-nums">
          <span className="text-emerald-400">{validation.summary.passed} passed</span>
          <span aria-hidden="true">·</span>
          <span className="text-amber-400">{validation.summary.warnings} watch</span>
          <span aria-hidden="true">·</span>
          <span className={validation.summary.errors > 0 ? 'text-rose-400' : 'text-slate-400'}>
            {validation.summary.errors} errors
          </span>
        </div>
      </div>

      <div className="divide-y divide-slate-800 overflow-hidden rounded-lg border border-slate-800 bg-[#0F172A]">
        {validation.checks.map((check) => {
          const meta = SEVERITY_META[check.severity];
          const Icon = meta.Icon;
          return (
            <div key={check.id} className="p-5">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1">
                  <div className="flex items-center gap-2.5 text-sm font-semibold text-slate-100">
                    <span className="font-mono text-xs font-normal text-slate-500">{check.id}</span>
                    <span>{check.label}</span>
                  </div>
                  <p className="text-xs text-slate-400">{check.summary}</p>
                </div>
                <div className={`inline-flex items-center gap-1.5 text-xs font-medium shrink-0 ${meta.textClass}`}>
                  <Icon className="h-4 w-4" />
                  <span>{meta.label}</span>
                </div>
              </div>

              {check.details.length > 0 && (
                <ul className="mt-3 space-y-1.5 border-t border-slate-800/80 pt-3 text-xs text-slate-300">
                  {check.details.map((detail, idx) => (
                    <li key={idx} className="font-mono leading-relaxed text-amber-200/90">
                      {detail}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
