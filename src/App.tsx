import { useCallback, useEffect, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { fetchOfficialFlightNetwork, type LoadedDatasetBundle } from './engine/dataset/loader.ts';
import { fetchDispatcherStatus } from './services/dispatcherClient.ts';
import type { DispatcherStatusResponse } from './types/index.ts';
import { TopBar, type FoundationTab } from './components/TopBar.tsx';
import { OverviewSection } from './components/OverviewSection.tsx';
import { ValidationSection } from './components/ValidationSection.tsx';
import { RulesSection } from './components/RulesSection.tsx';
import { ArchitectureSection } from './components/ArchitectureSection.tsx';
import { SimulationTestSection } from './components/SimulationTestSection.tsx';
import { DispatcherTestSection } from './components/DispatcherTestSection.tsx';

export default function App() {
  const [activeTab, setActiveTab] = useState<FoundationTab>('dataset');
  const [bundle, setBundle] = useState<LoadedDatasetBundle | null>(null);
  const [dispatcherStatus, setDispatcherStatus] = useState<DispatcherStatusResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const loadFoundation = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const [datasetBundle, status] = await Promise.all([
        fetchOfficialFlightNetwork(),
        fetchDispatcherStatus(),
      ]);
      setBundle(datasetBundle);
      setDispatcherStatus(status);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to load official flight network dataset.';
      setErrorMessage(msg);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadFoundation();
  }, [loadFoundation]);

  return (
    <div className="min-h-screen bg-[#090F1A] text-slate-100">
      <TopBar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        onReload={loadFoundation}
        isLoading={isLoading}
      />

      <main className="mx-auto max-w-[1440px] px-6 py-8">
        {isLoading && !bundle && (
          <div className="space-y-6" aria-busy="true" aria-label="Loading official dataset">
            <div className="h-7 w-80 animate-pulse rounded bg-slate-800/80" />
            <div className="grid grid-cols-2 gap-4 md:grid-cols-6">
              {Array.from({ length: 6 }).map((_, idx) => (
                <div key={idx} className="h-24 animate-pulse rounded-lg border border-slate-800 bg-[#0F172A]" />
              ))}
            </div>
            <div className="h-96 animate-pulse rounded-lg border border-slate-800 bg-[#0F172A]" />
          </div>
        )}

        {errorMessage && (
          <div
            role="alert"
            className="flex flex-col items-start justify-between gap-4 rounded-lg border border-rose-500/40 bg-rose-950/30 p-5 sm:flex-row sm:items-center"
          >
            <div className="flex items-start gap-3">
              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-rose-400" />
              <div className="space-y-1">
                <h2 className="text-sm font-semibold text-rose-200">
                  Dataset Loading or Validation Error
                </h2>
                <p className="text-xs text-rose-300/90">{errorMessage}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={loadFoundation}
              className="whitespace-nowrap shrink-0 rounded-md bg-rose-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-rose-400"
            >
              Retry Validation
            </button>
          </div>
        )}

        {bundle && !errorMessage && (
          <>
            {activeTab === 'dataset' && (
              <OverviewSection network={bundle.network} validation={bundle.validation} />
            )}
            {activeTab === 'validation' && (
              <ValidationSection validation={bundle.validation} />
            )}
            {activeTab === 'rules' && <RulesSection />}
            {activeTab === 'architecture' && (
              <ArchitectureSection dispatcherStatus={dispatcherStatus} />
            )}
            {activeTab === 'simulation' && (
              <SimulationTestSection network={bundle.network} />
            )}
            {activeTab === 'dispatcher' && (
              <DispatcherTestSection network={bundle.network} />
            )}
          </>
        )}
      </main>
    </div>
  );
}
