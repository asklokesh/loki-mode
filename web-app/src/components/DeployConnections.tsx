import { useState, useEffect, useCallback } from 'react';
import {
  Loader2,
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Unplug,
  Terminal,
  RefreshCw,
} from 'lucide-react';
import { api } from '../api/client';
import { Button } from './ui/Button';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConnectionStatus {
  connected: boolean;
  user?: string;
  last_deployed?: string;
  // Sent whenever a stored token fails re-verification: the platform CLI ran
  // and rejected it (web-app/server.py:8164, 8231, 8288, 8303). The server has
  // always returned this; the type just never declared it, so every consumer
  // was structurally blind to it and rendered an EXPIRED token identically to
  // one that was never connected.
  error?: string;
}

export interface AllConnectionStatuses {
  vercel: ConnectionStatus;
  netlify: ConnectionStatus;
  github: ConnectionStatus;
}

type PlatformId = 'vercel' | 'netlify' | 'github';

interface PlatformDef {
  id: PlatformId;
  name: string;
  description: string;
  initial: string;
  color: string;
  bgColor: string;
  borderColor: string;
  tokenUrl: string;
  tokenUrlLabel: string;
  hasTokenAuth: boolean;
}

// ---------------------------------------------------------------------------
// Platform definitions
// ---------------------------------------------------------------------------

const PLATFORMS: PlatformDef[] = [
  {
    id: 'vercel',
    name: 'Vercel',
    description: 'Optimized for Next.js, React, and static sites with global CDN.',
    initial: 'V',
    color: 'text-ink',
    bgColor: 'bg-ink/10',
    borderColor: 'border-ink/20',
    tokenUrl: 'https://vercel.com/account/tokens',
    tokenUrlLabel: 'Get your token from vercel.com/account/tokens',
    hasTokenAuth: true,
  },
  {
    id: 'netlify',
    name: 'Netlify',
    description: 'Deploy with CI/CD, serverless functions, and form handling.',
    initial: 'N',
    color: 'text-teal-600',
    bgColor: 'bg-teal-500/10',
    borderColor: 'border-teal-500/20',
    tokenUrl: 'https://app.netlify.com/user/applications#personal-access-tokens',
    tokenUrlLabel: 'Get your token from app.netlify.com/user/applications',
    hasTokenAuth: true,
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Free hosting for static sites directly from a GitHub repository.',
    initial: 'G',
    color: 'text-purple-600',
    bgColor: 'bg-purple-500/10',
    borderColor: 'border-purple-500/20',
    tokenUrl: 'https://cli.github.com/',
    tokenUrlLabel: 'Install GitHub CLI',
    hasTokenAuth: false,
  },
];

// ---------------------------------------------------------------------------
// Token connect form
// ---------------------------------------------------------------------------

function TokenConnectForm({
  platform,
  onConnect,
}: {
  platform: PlatformDef;
  onConnect: (token: string) => Promise<void>;
}) {
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!token.trim()) return;
      setLoading(true);
      setError(null);
      try {
        await onConnect(token.trim());
        setToken('');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Connection failed');
      } finally {
        setLoading(false);
      }
    },
    [token, onConnect],
  );

  return (
    <form onSubmit={handleSubmit} className="mt-3 space-y-2.5">
      <div>
        <label htmlFor={`token-${platform.id}`} className="sr-only">
          {platform.name} Token
        </label>
        <input
          id={`token-${platform.id}`}
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={`${platform.name} access token`}
          disabled={loading}
          className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-card text-ink
            focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary
            placeholder:text-muted disabled:opacity-50"
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <a
          href={platform.tokenUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
        >
          {platform.tokenUrlLabel}
          <ExternalLink size={10} />
        </a>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          loading={loading}
          disabled={!token.trim() || loading}
        >
          Connect
        </Button>
      </div>
      {error && (
        <div className="flex items-center gap-1.5 text-xs text-red-500 mt-1">
          <AlertCircle size={12} />
          {error}
        </div>
      )}
    </form>
  );
}

// ---------------------------------------------------------------------------
// GitHub instructions (no token flow -- uses gh CLI)
// ---------------------------------------------------------------------------

function GitHubInstructions() {
  return (
    <div className="mt-3 space-y-2">
      <div className="flex items-start gap-2 bg-amber-500/5 border border-amber-500/15 rounded-lg px-3 py-2.5">
        <Terminal size={14} className="text-amber-600 flex-shrink-0 mt-0.5" />
        <div className="text-xs text-muted leading-relaxed">
          <p className="font-medium text-ink mb-1">Run in your terminal:</p>
          <code className="block bg-ink/5 rounded px-2 py-1 font-mono text-[11px] text-ink">
            gh auth login
          </code>
        </div>
      </div>
      <a
        href="https://cli.github.com/"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
      >
        Install GitHub CLI
        <ExternalLink size={10} />
      </a>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Individual connection card
// ---------------------------------------------------------------------------

function ConnectionCard({
  platform,
  status,
  onConnect,
  onDisconnect,
}: {
  platform: PlatformDef;
  status: ConnectionStatus;
  onConnect: (token: string) => Promise<void>;
  onDisconnect: () => void;
}) {
  const [showForm, setShowForm] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const handleDisconnect = useCallback(async () => {
    setDisconnecting(true);
    try {
      onDisconnect();
    } finally {
      setDisconnecting(false);
    }
  }, [onDisconnect]);

  const handleConnect = useCallback(
    async (token: string) => {
      await onConnect(token);
      setShowForm(false);
    },
    [onConnect],
  );

  return (
    <div
      className={`border rounded-lg p-4 transition-colors ${
        status.connected
          ? 'border-green-500/30 bg-green-500/5'
          : 'border-border hover:border-primary/30 hover:bg-hover'
      }`}
    >
      {/* Header row */}
      <div className="flex items-center gap-3">
        {/* Platform icon */}
        <div
          className={`w-10 h-10 rounded-lg flex items-center justify-center ${platform.bgColor}`}
        >
          <span className={`text-sm font-bold ${platform.color}`}>
            {platform.initial}
          </span>
        </div>

        {/* Name + description */}
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-semibold text-ink">{platform.name}</h4>
          <p className="text-[11px] text-muted leading-snug mt-0.5">
            {platform.description}
          </p>
        </div>

        {/* Status indicator */}
        <div className="flex-shrink-0">
          <span
            className={`inline-block w-2.5 h-2.5 rounded-full ${
              status.connected ? 'bg-green-500' : 'bg-gray-300'
            }`}
            title={status.connected ? 'Connected' : 'Not connected'}
          />
        </div>
      </div>

      {/* Connection info */}
      {status.connected ? (
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-1.5 text-xs text-green-600 font-medium">
            <CheckCircle2 size={14} />
            Connected as {status.user || 'unknown'}
          </div>
          {status.last_deployed && (
            <p className="text-[11px] text-muted">
              Last deployed: {new Date(status.last_deployed).toLocaleString()}
            </p>
          )}
          <Button
            variant="danger"
            size="sm"
            icon={Unplug}
            onClick={handleDisconnect}
            loading={disconnecting}
            className="w-full"
          >
            Disconnect
          </Button>
        </div>
      ) : (
        <>
          {/* Not connected actions */}
          {/* An expired token is NOT the same state as "never connected", and
              until now both rendered identically. The server distinguishes them
              with `error`; surfacing it here is what turns a dead tile into a
              recoverable one, without leaving the screen. */}
          {status.error && (
            <div className="mt-3 flex items-start gap-2 bg-red-500/5 border border-red-500/15 rounded-lg px-3 py-2">
              <AlertCircle size={14} className="text-red-500 flex-shrink-0 mt-0.5" />
              <span className="text-xs text-red-600">{status.error}</span>
            </div>
          )}
          {platform.hasTokenAuth ? (
            <>
              {!showForm && (
                <div className="mt-3">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setShowForm(true)}
                    className="w-full"
                  >
                    {status.error ? `Reconnect ${platform.name}` : `Connect ${platform.name}`}
                  </Button>
                </div>
              )}
              {showForm && (
                <TokenConnectForm platform={platform} onConnect={handleConnect} />
              )}
            </>
          ) : (
            <GitHubInstructions />
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main DeployConnections component
// ---------------------------------------------------------------------------

interface DeployConnectionsProps {
  compact?: boolean;
  onStatusChange?: (statuses: AllConnectionStatuses) => void;
}

export function DeployConnections({
  compact = false,
  onStatusChange,
}: DeployConnectionsProps) {
  const [statuses, setStatuses] = useState<AllConnectionStatuses>({
    vercel: { connected: false },
    netlify: { connected: false },
    github: { connected: false },
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch all connection statuses
  const fetchStatuses = useCallback(async () => {
    try {
      const data = await api.getDeployStatus();
      setStatuses(data);
      onStatusChange?.(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch connection status');
    } finally {
      setLoading(false);
    }
  }, [onStatusChange]);

  // Fetch on mount and auto-refresh every 30 seconds
  useEffect(() => {
    fetchStatuses();
    const interval = setInterval(fetchStatuses, 30_000);
    return () => clearInterval(interval);
  }, [fetchStatuses]);

  // Connect handlers
  const handleConnectVercel = useCallback(
    async (token: string) => {
      const result = await api.connectVercel(token);
      if (result.success) {
        setStatuses((prev) => ({
          ...prev,
          vercel: { connected: true, user: result.user },
        }));
        onStatusChange?.({
          ...statuses,
          vercel: { connected: true, user: result.user },
        });
      }
    },
    [statuses, onStatusChange],
  );

  const handleConnectNetlify = useCallback(
    async (token: string) => {
      const result = await api.connectNetlify(token);
      if (result.success) {
        setStatuses((prev) => ({
          ...prev,
          netlify: { connected: true, user: result.user },
        }));
        onStatusChange?.({
          ...statuses,
          netlify: { connected: true, user: result.user },
        });
      }
    },
    [statuses, onStatusChange],
  );

  // Disconnect handler
  const handleDisconnect = useCallback(
    async (platform: PlatformId) => {
      await api.disconnectPlatform(platform);
      setStatuses((prev) => ({
        ...prev,
        [platform]: { connected: false },
      }));
      const updated = { ...statuses, [platform]: { connected: false } };
      onStatusChange?.(updated);
    },
    [statuses, onStatusChange],
  );

  // Connect callback map
  const connectHandlers: Record<PlatformId, (token: string) => Promise<void>> = {
    vercel: handleConnectVercel,
    netlify: handleConnectNetlify,
    github: async () => {
      // GitHub uses CLI auth -- no token flow
    },
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 size={20} className="text-primary animate-spin" />
        <span className="text-sm text-muted ml-2">Loading connections...</span>
      </div>
    );
  }

  const connectedCount = [statuses.vercel, statuses.netlify, statuses.github].filter(
    (s) => s.connected,
  ).length;

  return (
    <div className={compact ? 'space-y-3' : 'space-y-4'}>
      {/* Header */}
      {!compact && (
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-ink">Platform Connections</h3>
            <p className="text-[11px] text-muted mt-0.5">
              {connectedCount} of {PLATFORMS.length} platforms connected
            </p>
          </div>
          <button
            onClick={fetchStatuses}
            className="p-1.5 text-muted hover:text-ink rounded transition-colors"
            title="Refresh connection status"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      )}

      {/* Status summary bar (compact header) */}
      {compact && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {PLATFORMS.map((p) => {
              const s = statuses[p.id];
              return (
                <div
                  key={p.id}
                  className="flex items-center gap-1.5"
                  title={`${p.name}: ${s.connected ? `Connected as ${s.user}` : 'Not connected'}`}
                >
                  <span
                    className={`w-2 h-2 rounded-full ${
                      s.connected ? 'bg-green-500' : 'bg-gray-300'
                    }`}
                  />
                  <span className="text-[11px] text-muted">{p.name}</span>
                </div>
              );
            })}
          </div>
          <button
            onClick={fetchStatuses}
            className="p-1 text-muted hover:text-ink rounded transition-colors"
            title="Refresh"
          >
            <RefreshCw size={12} />
          </button>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-2 bg-red-500/5 border border-red-500/15 rounded-lg px-3 py-2">
          <AlertCircle size={14} className="text-red-500 flex-shrink-0" />
          <span className="text-xs text-red-600">{error}</span>
        </div>
      )}

      {/* Platform cards */}
      <div className={compact ? 'space-y-2' : 'space-y-3'}>
        {PLATFORMS.map((platform) => (
          <ConnectionCard
            key={platform.id}
            platform={platform}
            status={statuses[platform.id]}
            onConnect={connectHandlers[platform.id]}
            onDisconnect={() => handleDisconnect(platform.id)}
          />
        ))}
      </div>
    </div>
  );
}
