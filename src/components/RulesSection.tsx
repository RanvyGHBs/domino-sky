import { useState } from 'react';
import { OFFICIAL_AND_ASSUMED_RULES, type RuleSourceType } from '../engine/assumptions.ts';

type FilterMode = 'all' | RuleSourceType;

export function RulesSection() {
  const [filter, setFilter] = useState<FilterMode>('all');

  const filteredRules =
    filter === 'all'
      ? OFFICIAL_AND_ASSUMED_RULES
      : OFFICIAL_AND_ASSUMED_RULES.filter((r) => r.source === filter);

  const officialCount = OFFICIAL_AND_ASSUMED_RULES.filter(
    (r) => r.source === 'official_dataset_rule'
  ).length;
  const assumedCount = OFFICIAL_AND_ASSUMED_RULES.filter(
    (r) => r.source === 'documented_assumption'
  ).length;

  return (
    <section className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100">
            Operational Rules &amp; Documented Assumptions
          </h1>
          <p className="max-w-3xl text-sm text-slate-400">
            Official constraints from <span className="font-mono text-slate-300">flight_network.json</span>{' '}
            are kept strictly distinct from documented engineering policies where the dataset leaves
            disruption behavior unspecified.
          </p>
        </div>

        <div className="flex items-center gap-1 rounded-md bg-slate-900 p-1 self-start">
          {[
            { id: 'all' as const, label: `All (${OFFICIAL_AND_ASSUMED_RULES.length})` },
            { id: 'official_dataset_rule' as const, label: `Official (${officialCount})` },
            { id: 'documented_assumption' as const, label: `Assumptions (${assumedCount})` },
          ].map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => setFilter(opt.id)}
              className={`whitespace-nowrap shrink-0 rounded px-3 py-1.5 text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400 ${
                filter === opt.id
                  ? 'bg-slate-800 text-teal-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="divide-y divide-slate-800 overflow-hidden rounded-lg border border-slate-800 bg-[#0F172A]">
        {filteredRules.map((rule) => {
          const isOfficial = rule.source === 'official_dataset_rule';
          return (
            <article key={rule.id} className="space-y-2.5 p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                  <span className="font-mono text-slate-500">{rule.id}</span>
                  <span aria-hidden="true">·</span>
                  <span>{rule.domain}</span>
                  <span aria-hidden="true">·</span>
                  <span className={isOfficial ? 'font-medium text-teal-300' : 'font-medium text-amber-300'}>
                    {isOfficial ? 'Official Dataset Rule' : 'Documented Modelling Assumption'}
                  </span>
                  {rule.isConfigurable && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="text-slate-300">Configurable</span>
                    </>
                  )}
                </div>
                {(rule.datasetReference || rule.configKey) && (
                  <span className="font-mono text-xs text-slate-500">
                    {rule.configKey ? `config: ${rule.configKey}` : rule.datasetReference}
                  </span>
                )}
              </div>

              <h2 className="text-base font-semibold text-slate-100">{rule.title}</h2>
              <p className="text-sm leading-relaxed text-slate-300">{rule.ruleStatement}</p>
              <p className="text-xs leading-relaxed text-slate-400">
                <span className="font-medium text-slate-300">Rationale:</span> {rule.rationale}
              </p>
            </article>
          );
        })}
      </div>
    </section>
  );
}
