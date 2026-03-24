import { useState } from 'react';
import {
  Settings2,
  Server,
  Hammer,
  Shield,
  Bell,
  Database,
  Save,
  RotateCcw,
  Eye,
  EyeOff,
  Check,
  AlertTriangle,
  ShieldAlert,
} from 'lucide-react';
import { Button } from '../components/ui/Button';
import { APIKeyManager } from '../components/APIKeyManager';
import { useAuth } from '../hooks/useAuth';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProviderConfig {
  id: string;
  name: string;
  apiKeySet: boolean;
  model: string;
  fallbackOrder: number;
  enabled: boolean;
}

interface BuildDefaults {
  maxIterations: number;
  timeoutMinutes: number;
  qualityGateThreshold: number;
  autoReview: boolean;
  parallelAgents: number;
}

interface SecurityConfig {
  sessionTimeoutMinutes: number;
  allowedOrigins: string;
  rateLimitPerMinute: number;
  requireMFA: boolean;
  ipAllowlist: string;
}

interface NotificationConfig {
  emailEnabled: boolean;
  emailAddress: string;
  browserEnabled: boolean;
  slackEnabled: boolean;
  slackWebhookUrl: string;
  notifyOnBuildComplete: boolean;
  notifyOnBuildFailure: boolean;
  notifyOnBudgetAlert: boolean;
  notifyOnSecurityEvent: boolean;
}

interface DataRetentionConfig {
  logRetentionDays: number;
  auditRetentionDays: number;
  sessionRetentionDays: number;
  autoCleanupEnabled: boolean;
  lastCleanup: string | null;
}

// ---------------------------------------------------------------------------
// Default configs
// ---------------------------------------------------------------------------

const DEFAULT_PROVIDERS: ProviderConfig[] = [
  { id: 'claude', name: 'Claude', apiKeySet: true, model: 'claude-sonnet-4-20250514', fallbackOrder: 1, enabled: true },
  { id: 'codex', name: 'Codex', apiKeySet: false, model: 'gpt-5.3-codex', fallbackOrder: 2, enabled: true },
  { id: 'gemini', name: 'Gemini', apiKeySet: false, model: 'gemini-3-pro-medium', fallbackOrder: 3, enabled: false },
];

const DEFAULT_BUILD: BuildDefaults = {
  maxIterations: 25,
  timeoutMinutes: 60,
  qualityGateThreshold: 80,
  autoReview: true,
  parallelAgents: 3,
};

const DEFAULT_SECURITY: SecurityConfig = {
  sessionTimeoutMinutes: 30,
  allowedOrigins: '*',
  rateLimitPerMinute: 100,
  requireMFA: false,
  ipAllowlist: '',
};

const DEFAULT_NOTIFICATIONS: NotificationConfig = {
  emailEnabled: false,
  emailAddress: '',
  browserEnabled: true,
  slackEnabled: false,
  slackWebhookUrl: '',
  notifyOnBuildComplete: true,
  notifyOnBuildFailure: true,
  notifyOnBudgetAlert: true,
  notifyOnSecurityEvent: true,
};

const DEFAULT_RETENTION: DataRetentionConfig = {
  logRetentionDays: 30,
  auditRetentionDays: 365,
  sessionRetentionDays: 90,
  autoCleanupEnabled: true,
  lastCleanup: new Date(Date.now() - 86400000).toISOString(),
};

// ---------------------------------------------------------------------------
// Section components
// ---------------------------------------------------------------------------

function ProviderSection() {
  const [providers, setProviders] = useState(DEFAULT_PROVIDERS);
  const [showKey, setShowKey] = useState<Record<string, boolean>>({});
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-[#6B6960]">
        Configure AI provider API keys, model preferences, and fallback chain.
      </p>

      {providers.map((provider, idx) => (
        <div
          key={provider.id}
          className="border border-[#ECEAE3] dark:border-[#2A2A30] rounded-lg p-4 space-y-3"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="w-6 h-6 rounded-full bg-[#553DE9]/10 flex items-center justify-center text-xs font-bold text-[#553DE9]">
                {provider.fallbackOrder}
              </span>
              <span className="text-sm font-medium text-[#201515] dark:text-[#E8E6E3]">
                {provider.name}
              </span>
              {provider.apiKeySet && (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-[#1FC5A8]/10 text-[#1FC5A8]">
                  Configured
                </span>
              )}
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <span className="text-xs text-[#939084]">
                {provider.enabled ? 'Enabled' : 'Disabled'}
              </span>
              <input
                type="checkbox"
                checked={provider.enabled}
                onChange={(e) => {
                  const next = [...providers];
                  next[idx] = { ...next[idx], enabled: e.target.checked };
                  setProviders(next);
                }}
                className="rounded border-[#ECEAE3] text-[#553DE9] focus:ring-[#553DE9]"
              />
            </label>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[#6B6960] mb-1">API Key</label>
              <div className="relative">
                <input
                  type={showKey[provider.id] ? 'text' : 'password'}
                  value={provider.apiKeySet ? 'sk-****************************' : ''}
                  placeholder="Enter API key..."
                  className="w-full px-3 py-2 pr-10 text-sm rounded-lg border border-[#ECEAE3] dark:border-[#2A2A30] bg-white dark:bg-[#1A1A1E] text-[#201515] dark:text-[#E8E6E3] placeholder-[#939084] font-mono"
                  readOnly
                />
                <button
                  onClick={() => setShowKey(prev => ({ ...prev, [provider.id]: !prev[provider.id] }))}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[#939084] hover:text-[#36342E]"
                >
                  {showKey[provider.id] ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-[#6B6960] mb-1">Model</label>
              <input
                value={provider.model}
                onChange={(e) => {
                  const next = [...providers];
                  next[idx] = { ...next[idx], model: e.target.value };
                  setProviders(next);
                }}
                className="w-full px-3 py-2 text-sm rounded-lg border border-[#ECEAE3] dark:border-[#2A2A30] bg-white dark:bg-[#1A1A1E] text-[#201515] dark:text-[#E8E6E3] font-mono"
              />
            </div>
          </div>
        </div>
      ))}

      <div className="flex items-center gap-2">
        <Button size="sm" icon={saved ? Check : Save} onClick={handleSave}>
          {saved ? 'Saved' : 'Save Provider Config'}
        </Button>
      </div>
    </div>
  );
}

function BuildDefaultsSection() {
  const [config, setConfig] = useState(DEFAULT_BUILD);
  const [saved, setSaved] = useState(false);

  const update = <K extends keyof BuildDefaults>(key: K, value: BuildDefaults[K]) => {
    setConfig(prev => ({ ...prev, [key]: value }));
  };

  const handleSave = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-[#6B6960]">
        Default settings for new builds. Individual projects can override these.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-medium text-[#6B6960] mb-1">Max Iterations</label>
          <input
            type="number"
            value={config.maxIterations}
            onChange={(e) => update('maxIterations', parseInt(e.target.value) || 0)}
            min={1}
            max={100}
            className="w-full px-3 py-2 text-sm rounded-lg border border-[#ECEAE3] dark:border-[#2A2A30] bg-white dark:bg-[#1A1A1E] text-[#201515] dark:text-[#E8E6E3]"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-[#6B6960] mb-1">Timeout (minutes)</label>
          <input
            type="number"
            value={config.timeoutMinutes}
            onChange={(e) => update('timeoutMinutes', parseInt(e.target.value) || 0)}
            min={5}
            max={480}
            className="w-full px-3 py-2 text-sm rounded-lg border border-[#ECEAE3] dark:border-[#2A2A30] bg-white dark:bg-[#1A1A1E] text-[#201515] dark:text-[#E8E6E3]"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-[#6B6960] mb-1">
            Quality Gate Threshold (%)
          </label>
          <input
            type="number"
            value={config.qualityGateThreshold}
            onChange={(e) => update('qualityGateThreshold', parseInt(e.target.value) || 0)}
            min={0}
            max={100}
            className="w-full px-3 py-2 text-sm rounded-lg border border-[#ECEAE3] dark:border-[#2A2A30] bg-white dark:bg-[#1A1A1E] text-[#201515] dark:text-[#E8E6E3]"
          />
          <div className="mt-1 h-1.5 bg-[#F8F4F0] dark:bg-[#1A1A1E] rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${config.qualityGateThreshold}%`,
                background: config.qualityGateThreshold >= 80 ? '#1FC5A8' : config.qualityGateThreshold >= 60 ? '#F59E0B' : '#C45B5B',
              }}
            />
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-[#6B6960] mb-1">Parallel Agents</label>
          <input
            type="number"
            value={config.parallelAgents}
            onChange={(e) => update('parallelAgents', parseInt(e.target.value) || 1)}
            min={1}
            max={10}
            className="w-full px-3 py-2 text-sm rounded-lg border border-[#ECEAE3] dark:border-[#2A2A30] bg-white dark:bg-[#1A1A1E] text-[#201515] dark:text-[#E8E6E3]"
          />
        </div>
      </div>

      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={config.autoReview}
          onChange={(e) => update('autoReview', e.target.checked)}
          className="rounded border-[#ECEAE3] text-[#553DE9] focus:ring-[#553DE9]"
        />
        <span className="text-sm text-[#201515] dark:text-[#E8E6E3]">
          Auto-run code review after each build
        </span>
      </label>

      <Button size="sm" icon={saved ? Check : Save} onClick={handleSave}>
        {saved ? 'Saved' : 'Save Build Defaults'}
      </Button>
    </div>
  );
}

function SecuritySection() {
  const [config, setConfig] = useState(DEFAULT_SECURITY);
  const [saved, setSaved] = useState(false);

  const update = <K extends keyof SecurityConfig>(key: K, value: SecurityConfig[K]) => {
    setConfig(prev => ({ ...prev, [key]: value }));
  };

  const handleSave = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-[#6B6960]">
        Security settings for session management, rate limiting, and access control.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-medium text-[#6B6960] mb-1">
            Session Timeout (minutes)
          </label>
          <input
            type="number"
            value={config.sessionTimeoutMinutes}
            onChange={(e) => update('sessionTimeoutMinutes', parseInt(e.target.value) || 0)}
            min={5}
            max={1440}
            className="w-full px-3 py-2 text-sm rounded-lg border border-[#ECEAE3] dark:border-[#2A2A30] bg-white dark:bg-[#1A1A1E] text-[#201515] dark:text-[#E8E6E3]"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-[#6B6960] mb-1">
            Rate Limit (requests/minute)
          </label>
          <input
            type="number"
            value={config.rateLimitPerMinute}
            onChange={(e) => update('rateLimitPerMinute', parseInt(e.target.value) || 0)}
            min={10}
            max={10000}
            className="w-full px-3 py-2 text-sm rounded-lg border border-[#ECEAE3] dark:border-[#2A2A30] bg-white dark:bg-[#1A1A1E] text-[#201515] dark:text-[#E8E6E3]"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-[#6B6960] mb-1">
            Allowed Origins
          </label>
          <input
            type="text"
            value={config.allowedOrigins}
            onChange={(e) => update('allowedOrigins', e.target.value)}
            placeholder="* or comma-separated origins"
            className="w-full px-3 py-2 text-sm rounded-lg border border-[#ECEAE3] dark:border-[#2A2A30] bg-white dark:bg-[#1A1A1E] text-[#201515] dark:text-[#E8E6E3] placeholder-[#939084] font-mono"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-[#6B6960] mb-1">
            IP Allowlist
          </label>
          <input
            type="text"
            value={config.ipAllowlist}
            onChange={(e) => update('ipAllowlist', e.target.value)}
            placeholder="Leave empty for no restriction"
            className="w-full px-3 py-2 text-sm rounded-lg border border-[#ECEAE3] dark:border-[#2A2A30] bg-white dark:bg-[#1A1A1E] text-[#201515] dark:text-[#E8E6E3] placeholder-[#939084] font-mono"
          />
        </div>
      </div>

      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={config.requireMFA}
          onChange={(e) => update('requireMFA', e.target.checked)}
          className="rounded border-[#ECEAE3] text-[#553DE9] focus:ring-[#553DE9]"
        />
        <span className="text-sm text-[#201515] dark:text-[#E8E6E3]">
          Require MFA for all users
        </span>
        {!config.requireMFA && (
          <span className="text-xs text-[#F59E0B] flex items-center gap-1">
            <AlertTriangle size={12} />
            Not recommended for production
          </span>
        )}
      </label>

      <Button size="sm" icon={saved ? Check : Save} onClick={handleSave}>
        {saved ? 'Saved' : 'Save Security Settings'}
      </Button>
    </div>
  );
}

function NotificationSection() {
  const [config, setConfig] = useState(DEFAULT_NOTIFICATIONS);
  const [saved, setSaved] = useState(false);

  const update = <K extends keyof NotificationConfig>(key: K, value: NotificationConfig[K]) => {
    setConfig(prev => ({ ...prev, [key]: value }));
  };

  const handleSave = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-[#6B6960]">
        Configure how and when you receive notifications about system events.
      </p>

      {/* Channels */}
      <div className="space-y-3">
        <h4 className="text-xs font-semibold text-[#6B6960] uppercase tracking-wider">Channels</h4>

        <div className="border border-[#ECEAE3] dark:border-[#2A2A30] rounded-lg divide-y divide-[#ECEAE3] dark:divide-[#2A2A30]">
          <div className="p-3 flex items-center justify-between">
            <div>
              <p className="text-sm text-[#201515] dark:text-[#E8E6E3]">Browser Notifications</p>
              <p className="text-xs text-[#939084]">Show desktop notifications</p>
            </div>
            <input
              type="checkbox"
              checked={config.browserEnabled}
              onChange={(e) => update('browserEnabled', e.target.checked)}
              className="rounded border-[#ECEAE3] text-[#553DE9] focus:ring-[#553DE9]"
            />
          </div>

          <div className="p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-[#201515] dark:text-[#E8E6E3]">Email Notifications</p>
                <p className="text-xs text-[#939084]">Send email for important events</p>
              </div>
              <input
                type="checkbox"
                checked={config.emailEnabled}
                onChange={(e) => update('emailEnabled', e.target.checked)}
                className="rounded border-[#ECEAE3] text-[#553DE9] focus:ring-[#553DE9]"
              />
            </div>
            {config.emailEnabled && (
              <input
                type="email"
                value={config.emailAddress}
                onChange={(e) => update('emailAddress', e.target.value)}
                placeholder="notifications@company.com"
                className="w-full px-3 py-2 text-sm rounded-lg border border-[#ECEAE3] dark:border-[#2A2A30] bg-white dark:bg-[#1A1A1E] text-[#201515] dark:text-[#E8E6E3] placeholder-[#939084]"
              />
            )}
          </div>

          <div className="p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-[#201515] dark:text-[#E8E6E3]">Slack Webhook</p>
                <p className="text-xs text-[#939084]">Post to a Slack channel</p>
              </div>
              <input
                type="checkbox"
                checked={config.slackEnabled}
                onChange={(e) => update('slackEnabled', e.target.checked)}
                className="rounded border-[#ECEAE3] text-[#553DE9] focus:ring-[#553DE9]"
              />
            </div>
            {config.slackEnabled && (
              <input
                type="url"
                value={config.slackWebhookUrl}
                onChange={(e) => update('slackWebhookUrl', e.target.value)}
                placeholder="https://hooks.slack.com/services/..."
                className="w-full px-3 py-2 text-sm rounded-lg border border-[#ECEAE3] dark:border-[#2A2A30] bg-white dark:bg-[#1A1A1E] text-[#201515] dark:text-[#E8E6E3] placeholder-[#939084] font-mono"
              />
            )}
          </div>
        </div>
      </div>

      {/* Events */}
      <div className="space-y-3">
        <h4 className="text-xs font-semibold text-[#6B6960] uppercase tracking-wider">Events</h4>
        <div className="border border-[#ECEAE3] dark:border-[#2A2A30] rounded-lg divide-y divide-[#ECEAE3] dark:divide-[#2A2A30]">
          {[
            { key: 'notifyOnBuildComplete' as const, label: 'Build Complete', desc: 'When a build finishes successfully' },
            { key: 'notifyOnBuildFailure' as const, label: 'Build Failure', desc: 'When a build fails or times out' },
            { key: 'notifyOnBudgetAlert' as const, label: 'Budget Alert', desc: 'When spending approaches the limit' },
            { key: 'notifyOnSecurityEvent' as const, label: 'Security Event', desc: 'Login from new device, key rotation, etc.' },
          ].map(item => (
            <div key={item.key} className="p-3 flex items-center justify-between">
              <div>
                <p className="text-sm text-[#201515] dark:text-[#E8E6E3]">{item.label}</p>
                <p className="text-xs text-[#939084]">{item.desc}</p>
              </div>
              <input
                type="checkbox"
                checked={config[item.key]}
                onChange={(e) => update(item.key, e.target.checked)}
                className="rounded border-[#ECEAE3] text-[#553DE9] focus:ring-[#553DE9]"
              />
            </div>
          ))}
        </div>
      </div>

      <Button size="sm" icon={saved ? Check : Save} onClick={handleSave}>
        {saved ? 'Saved' : 'Save Notifications'}
      </Button>
    </div>
  );
}

function DataRetentionSection() {
  const [config, setConfig] = useState(DEFAULT_RETENTION);
  const [saved, setSaved] = useState(false);

  const update = <K extends keyof DataRetentionConfig>(key: K, value: DataRetentionConfig[K]) => {
    setConfig(prev => ({ ...prev, [key]: value }));
  };

  const handleSave = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-[#6B6960]">
        Configure how long different types of data are retained before automatic cleanup.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <label className="block text-xs font-medium text-[#6B6960] mb-1">
            Log Retention (days)
          </label>
          <input
            type="number"
            value={config.logRetentionDays}
            onChange={(e) => update('logRetentionDays', parseInt(e.target.value) || 0)}
            min={7}
            max={365}
            className="w-full px-3 py-2 text-sm rounded-lg border border-[#ECEAE3] dark:border-[#2A2A30] bg-white dark:bg-[#1A1A1E] text-[#201515] dark:text-[#E8E6E3]"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-[#6B6960] mb-1">
            Audit Retention (days)
          </label>
          <input
            type="number"
            value={config.auditRetentionDays}
            onChange={(e) => update('auditRetentionDays', parseInt(e.target.value) || 0)}
            min={30}
            max={3650}
            className="w-full px-3 py-2 text-sm rounded-lg border border-[#ECEAE3] dark:border-[#2A2A30] bg-white dark:bg-[#1A1A1E] text-[#201515] dark:text-[#E8E6E3]"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-[#6B6960] mb-1">
            Session Retention (days)
          </label>
          <input
            type="number"
            value={config.sessionRetentionDays}
            onChange={(e) => update('sessionRetentionDays', parseInt(e.target.value) || 0)}
            min={7}
            max={365}
            className="w-full px-3 py-2 text-sm rounded-lg border border-[#ECEAE3] dark:border-[#2A2A30] bg-white dark:bg-[#1A1A1E] text-[#201515] dark:text-[#E8E6E3]"
          />
        </div>
      </div>

      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={config.autoCleanupEnabled}
          onChange={(e) => update('autoCleanupEnabled', e.target.checked)}
          className="rounded border-[#ECEAE3] text-[#553DE9] focus:ring-[#553DE9]"
        />
        <span className="text-sm text-[#201515] dark:text-[#E8E6E3]">
          Enable automatic cleanup
        </span>
      </label>

      {config.lastCleanup && (
        <p className="text-xs text-[#939084]">
          Last cleanup: {new Date(config.lastCleanup).toLocaleString()}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button size="sm" icon={saved ? Check : Save} onClick={handleSave}>
          {saved ? 'Saved' : 'Save Retention Settings'}
        </Button>
        <Button size="sm" variant="ghost" icon={RotateCcw}>
          Run Cleanup Now
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section config
// ---------------------------------------------------------------------------

type SettingsSection = 'providers' | 'builds' | 'security' | 'api-keys' | 'notifications' | 'retention';

const SECTIONS: { id: SettingsSection; label: string; icon: React.ComponentType<{ size?: number; className?: string }> }[] = [
  { id: 'providers', label: 'Providers', icon: Server },
  { id: 'builds', label: 'Build Defaults', icon: Hammer },
  { id: 'security', label: 'Security', icon: Shield },
  { id: 'api-keys', label: 'API Keys', icon: Shield },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'retention', label: 'Data Retention', icon: Database },
];

// ---------------------------------------------------------------------------
// Access Denied
// ---------------------------------------------------------------------------

function AccessDenied() {
  return (
    <div className="max-w-[500px] mx-auto px-6 py-20 text-center">
      <ShieldAlert size={48} className="mx-auto text-[#C45B5B] mb-4" />
      <h1 className="font-heading text-h1 text-[#36342E] dark:text-[#E8E6E3] mb-2">
        Access Denied
      </h1>
      <p className="text-sm text-[#6B6960]">
        You do not have permission to access system settings.
        Contact your organization administrator for access.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function SystemSettingsPage() {
  const { user, isLocalMode } = useAuth();
  const [activeSection, setActiveSection] = useState<SettingsSection>('providers');

  const isAdmin = isLocalMode || (user?.authenticated === true);

  if (!isAdmin) {
    return <AccessDenied />;
  }

  return (
    <div className="max-w-[1000px] mx-auto px-6 py-8">
      <h1 className="font-heading text-h1 text-[#36342E] dark:text-[#E8E6E3] mb-6">
        System Settings
      </h1>

      <div className="flex gap-6">
        {/* Sidebar navigation */}
        <nav className="w-48 flex-shrink-0 space-y-1">
          {SECTIONS.map(section => (
            <button
              key={section.id}
              onClick={() => setActiveSection(section.id)}
              className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded-lg text-left transition-colors ${
                activeSection === section.id
                  ? 'bg-[#553DE9]/8 text-[#553DE9] font-medium'
                  : 'text-[#6B6960] hover:bg-[#F8F4F0] dark:hover:bg-[#222228] hover:text-[#36342E] dark:hover:text-[#E8E6E3]'
              }`}
            >
              <section.icon size={16} />
              {section.label}
            </button>
          ))}
        </nav>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="card p-6">
            <div className="flex items-center gap-2 mb-4">
              {SECTIONS.find(s => s.id === activeSection)?.icon &&
                (() => {
                  const Icon = SECTIONS.find(s => s.id === activeSection)!.icon;
                  return <Icon size={18} className="text-[#553DE9]" />;
                })()
              }
              <h2 className="text-sm font-semibold text-[#201515] dark:text-[#E8E6E3] uppercase tracking-wider">
                {SECTIONS.find(s => s.id === activeSection)?.label}
              </h2>
            </div>

            {activeSection === 'providers' && <ProviderSection />}
            {activeSection === 'builds' && <BuildDefaultsSection />}
            {activeSection === 'security' && <SecuritySection />}
            {activeSection === 'api-keys' && <APIKeyManager />}
            {activeSection === 'notifications' && <NotificationSection />}
            {activeSection === 'retention' && <DataRetentionSection />}
          </div>
        </div>
      </div>
import { Settings2 } from 'lucide-react';

export default function SystemSettingsPage() {
  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Settings2 size={24} className="text-[#553DE9] dark:text-[#8B7BF7]" />
        <h1 className="text-2xl font-heading font-bold text-[#36342E] dark:text-[#F5F3EE]">
          System Settings
        </h1>
      </div>
      <p className="text-[#6B6960] dark:text-[#A8A49A]">
        Global system configuration, provider settings, and quality gate thresholds.
      </p>
    </div>
  );
}
