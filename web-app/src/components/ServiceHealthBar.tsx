import { useState } from 'react';
import { RefreshCw, AlertCircle, CheckCircle, Loader, Wrench } from 'lucide-react';
import { api } from '../api/client';

interface ServiceInfo {
  name: string;
  status: string;
  ports?: number[];
  exit_code?: number;
  restarts?: number;
  fix_status?: string;
  is_primary?: boolean;
}

interface ServiceHealthBarProps {
  sessionId: string;
  services: ServiceInfo[];
  activePort: number;
  onPortChange: (port: number, serviceName: string) => void;
}

export function ServiceHealthBar({ sessionId, services, activePort, onPortChange }: ServiceHealthBarProps) {
  const [restarting, setRestarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleRestart = async (serviceName: string) => {
    setRestarting(serviceName);
    setError(null);
    try {
      await api.restartService(sessionId, serviceName);
    } catch {
      setError(`Failed to restart ${serviceName}`);
      setTimeout(() => setError(null), 5000);
    } finally {
      setTimeout(() => setRestarting(null), 3000);
    }
  };

  const getStatusColor = (svc: ServiceInfo) => {
    if (svc.fix_status === 'fixing') return 'text-yellow-400';
    if (svc.status === 'running') return 'text-green-400';
    if (svc.status === 'exited' || svc.status === 'dead') return 'text-red-400';
    if (svc.status === 'restarting') return 'text-yellow-400';
    return 'text-gray-400';
  };

  const getStatusIcon = (svc: ServiceInfo) => {
    if (svc.fix_status === 'fixing') return <Wrench size={10} className="animate-spin" />;
    if (svc.status === 'running') return <CheckCircle size={10} />;
    if (svc.status === 'exited' || svc.status === 'dead') return <AlertCircle size={10} />;
    if (svc.status === 'restarting') return <Loader size={10} className="animate-spin" />;
    return null;
  };

  if (services.length === 0) {
    return (
      <div className="flex items-center gap-1 px-2 py-1 bg-card border-b border-border">
        <span className="text-[10px] text-muted font-semibold uppercase mr-1">Services:</span>
        <span className="text-[10px] text-muted/50">Waiting for services to start...</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 px-2 py-1 bg-card border-b border-border overflow-x-auto">
      <span className="text-[10px] text-muted font-semibold uppercase mr-1 flex-shrink-0">Services:</span>
      {error && <span className="text-[10px] text-red-400 ml-2">{error}</span>}
      {services.map(svc => {
        const hasPort = svc.ports && svc.ports.length > 0;
        const isActive = hasPort && svc.ports![0] === activePort;

        return (
          <button
            key={svc.name}
            onClick={() => hasPort ? onPortChange(svc.ports![0], svc.name) : undefined}
            className={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono transition-colors flex-shrink-0 ${
              isActive ? 'bg-primary/10 text-primary border border-primary/30' :
              hasPort ? 'hover:bg-hover text-muted cursor-pointer' : 'text-muted/50 cursor-default'
            }`}
            title={`${svc.name}: ${svc.status}${hasPort ? ` (port ${svc.ports![0]})` : ''}${svc.fix_status ? ` [${svc.fix_status}]` : ''}`}
          >
            <span className={getStatusColor(svc)}>{getStatusIcon(svc)}</span>
            <span>{svc.name}</span>
            {hasPort && <span className="text-muted/50">:{svc.ports![0]}</span>}
            {svc.status === 'exited' && (
              <button
                onClick={(e) => { e.stopPropagation(); handleRestart(svc.name); }}
                className="ml-1 hover:text-primary"
                title={`Restart ${svc.name}`}
              >
                <RefreshCw size={10} className={restarting === svc.name ? 'animate-spin' : ''} />
              </button>
            )}
          </button>
        );
      })}
    </div>
  );
}
