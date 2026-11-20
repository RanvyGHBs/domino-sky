import { RefreshCw } from 'lucide-react';

export type FoundationTab =
  | 'dataset'
  | 'validation'
  | 'rules'
  | 'architecture'
  | 'simulation'
  | 'dispatcher';

interface TopBarProps {
  activeTab: FoundationTab;
  onSelectTab: (tab: FoundationTab) => void;
  onReload: () => void;
  isLoading: boolean;
}

const NAV_ITEMS: Array<{ id: FoundationTab; label: string }> = [
  { id: 'dataset', label: 'Dataset' },
  { id: 'validation', label: 'Validation' },
  { id: 'rules', label: 'Rules' },
  { id: 'architecture', label: 'Architecture' },
  { id: 'simulation', label: 'Simulation Test' },
  { id: 'dispatcher', label: 'AI Dispatcher' },
];

export function TopBar({ activeTab, onSelectTab, onReload, isLoading }: TopBarProps) {
  return (
    <header className="sticky top-0 z-20 border-b border-slate-800/90 bg-[#090F1A]/95 backdrop-blur-sm">
      <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-8 px-6 py-4">
        <a
          href="#dataset"
          onClick={(e) => {
            e.preventDefault();
            onSelectTab('dataset');
          }}
          className="whitespace-nowrap shrink-0 text-lg font-semibold tracking-tight text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400 rounded"
        >
          Domino Sky
        </a>

        <nav
          aria-label="Foundation sections"
          className="flex items-center gap-6 overflow-x-auto"
        >
          {NAV_ITEMS.map((item) => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectTab(item.id)}
                className={`whitespace-nowrap shrink-0 border-b-2 py-1 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400 ${
                  isActive
                    ? 'border-teal-400 text-teal-300'
                    : 'border-transparent text-slate-400 hover:text-slate-100'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </nav>

        <div className="shrink-0">
          <button
            type="button"
            onClick={onReload}
            disabled={isLoading}
            className="inline-flex items-center gap-2 whitespace-nowrap shrink-0 rounded-md bg-teal-500 px-4 py-2 text-xs font-semibold text-slate-950 transition-colors duration-150 hover:bg-teal-400 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-300"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            {isLoading ? 'Validating' : 'Re-validate Dataset'}
          </button>
        </div>
      </div>
    </header>
  );
}
