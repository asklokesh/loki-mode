import { StatusResponse } from '../types/api';

interface HeaderProps {
  status: StatusResponse | null;
  wsConnected: boolean;
}

export function Header({ status, wsConnected }: HeaderProps) {
  return (
    <header className="sticky top-0 z-50 glass border-b border-white/20">
      <div className="max-w-[1920px] mx-auto px-6 h-14 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-charcoal tracking-tight">
            Loki Mode
          </h1>
          {status?.version && (
            <span className="text-xs font-mono font-medium px-2 py-0.5 rounded-full bg-primary/10 text-primary">
              v{status.version}
            </span>
          )}
        </div>

        <div className="flex items-center gap-4">
          {/* Connection indicator */}
          <div className="flex items-center gap-2 text-sm">
            <div
              className={`w-2 h-2 rounded-full ${
                wsConnected ? 'bg-success' : 'bg-danger'
              }`}
            />
            <span className="text-slate text-xs font-medium">
              {wsConnected ? 'Connected' : 'Disconnected'}
            </span>
          </div>

          {/* Running status */}
          {status && (
            <div className="flex items-center gap-2">
              <div
                className={`w-2 h-2 rounded-full ${
                  status.paused
                    ? 'bg-warning'
                    : status.running
                    ? 'bg-success phase-active'
                    : 'bg-slate/30'
                }`}
              />
              <span className="text-sm font-medium text-charcoal">
                {status.paused
                  ? 'Paused'
                  : status.running
                  ? 'Running'
                  : 'Idle'}
              </span>
            </div>
          )}

          {/* Provider badge */}
          {status?.provider && (
            <span className="text-xs font-mono font-semibold px-2.5 py-1 rounded-full bg-accent-product/10 text-accent-product">
              {status.provider}
            </span>
          )}
        </div>
      </div>
    </header>
  );
}
