import { useState, useEffect, useCallback } from 'react';
import {
  Users,
  FolderKanban,
  DollarSign,
  Activity,
  Zap,
  Clock,
  ShieldAlert,
  BarChart3,
  ScrollText,
} from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { api } from '../api/client';
import type { AuditEntry } from '../components/RBACPanel';
import { UsageAnalytics, type CostBreakdown } from '../components/UsageAnalytics';
import { AuditTrail, type AuditEvent } from '../components/AuditTrail';
import { UserManagement } from '../components/UserManagement';
import { ProjectGovernance } from '../components/ProjectGovernance';
import { ComplianceDashboard } from '../components/ComplianceDashboard';

// ---------------------------------------------------------------------------
// Every number on this page comes from an endpoint that measured it. The
// overview used to render invented values ("24 users", "$201.00 Monthly Cost",
// a 94% success ring, fake provider latencies, twenty fake audit rows); those
// are gone. A read that has not finished shows "...", a read that failed shows
// "Unavailable", and an unrecorded cost shows "Not recorded" -- never 0.
// ---------------------------------------------------------------------------

type CostSummary = Awaited<ReturnType<typeof api.getCost>>;

/** A fetch result: pending (undefined), failed (null), or the value. */
type Read<T> = T | null | undefined;

interface OverviewData {
  projects: Read<number>;
  teams: Read<{ count: number; members: number }>;
  cost: Read<CostSummary>;
  audit: Read<AuditEntry[]>;
}

function formatUsd(v: number | null | undefined): string {
  if (v === null || v === undefined) return 'Not recorded';
  return `$${v.toFixed(2)}`;
}

function show<T>(r: Read<T>, fmt: (v: T) => string): string {
  if (r === undefined) return '...';
  if (r === null) return 'Unavailable';
  return fmt(r);
}

const MODEL_COLORS = ['#553DE9', '#1FC5A8', '#F59E0B', '#6366F1', '#C45B5B', '#939084'];

/** Per-model cost from /api/cost. Only models with a recorded number are kept. */
function costByModel(cost: Read<CostSummary>): CostBreakdown[] | undefined {
  if (!cost || cost.cost_recorded !== true) return undefined;
  const rows = Object.entries(cost.by_model || {})
    .map(([model, v]) => {
      // The dashboard reader emits per-model objects; tolerate a bare number.
      const raw = typeof v === 'number' ? v : (v as { cost_usd?: number | null } | null)?.cost_usd;
      return { model, usd: typeof raw === 'number' && isFinite(raw) ? raw : null };
    })
    .filter((r): r is { model: string; usd: number } => r.usd !== null);
  if (rows.length === 0) return undefined;
  // A recorded total of $0.00 is a measurement and is shown, with no share.
  const total = rows.reduce((sum, r) => sum + r.usd, 0);
  return rows.map((r, i) => ({
    provider: r.model,
    cost: r.usd,
    percentage: total > 0 ? (r.usd / total) * 100 : 0,
    color: MODEL_COLORS[i % MODEL_COLORS.length],
  }));
}

function categoryOf(action: string): AuditEvent['category'] {
  const head = action.split('.')[0].toLowerCase();
  if (['user', 'auth', 'login', 'logout'].includes(head)) return 'auth';
  if (['team', 'member', 'role', 'settings'].includes(head)) return 'admin';
  if (['deploy', 'build', 'session'].includes(head)) return 'deploy';
  if (['key', 'secret', 'api'].includes(head)) return 'api';
  if (head === 'project') return 'project';
  return 'system';
}

function toAuditEvent(e: AuditEntry): AuditEvent {
  return {
    id: e.id,
    timestamp: e.timestamp,
    user: e.user || 'unknown',
    action: e.action,
    target: e.target || '',
    details: e.details || '',
    ip: '', // the web-app audit log does not record an IP
    category: categoryOf(e.action),
  };
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function OverviewCard({ label, value, note, icon: Icon, color }: {
  label: string;
  value: string;
  note: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  color: string;
}) {
  return (
    <div className="card p-4">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs text-[#6B6960] uppercase tracking-wider">{label}</p>
          <p className="text-2xl font-bold text-[#36342E] dark:text-[#E8E6E3] mt-1">{value}</p>
          <p className="text-xs mt-1 text-[#939084]">{note}</p>
        </div>
        <div className="p-2 rounded-lg" style={{ backgroundColor: `${color}10`, color }}>
          <Icon size={20} />
        </div>
      </div>
    </div>
  );
}

function RecentActivityLog({ entries }: { entries: Read<AuditEntry[]> }) {
  const formatTime = (ts: string) =>
    new Date(ts).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    });
  const recent = (entries || [])
    .slice()
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
    .slice(0, 20);

  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-1">
        <Activity size={14} className="text-[#553DE9]" />
        <h4 className="text-sm font-medium text-[#36342E] dark:text-[#E8E6E3]">Recent Activity</h4>
      </div>
      <p className="text-[11px] text-[#939084] mb-3">
        From this server&apos;s recent-activity log. It keeps the last 500 entries and is not hash-chained.
      </p>
      {entries === undefined && <p className="text-sm text-[#939084]">Loading...</p>}
      {entries === null && (
        <p className="text-sm text-[#939084]">Could not load the activity log. Nothing is shown rather than a guess.</p>
      )}
      {entries && recent.length === 0 && <p className="text-sm text-[#939084]">No activity recorded yet.</p>}
      {recent.length > 0 && (
        <div className="space-y-1 max-h-[400px] overflow-y-auto terminal-scroll">
          {recent.map(entry => (
            <div
              key={entry.id}
              className="flex items-center gap-3 px-2 py-1.5 rounded-lg hover:bg-[#F8F4F0] dark:hover:bg-[#222228] transition-colors"
            >
              <span className="text-[10px] font-mono text-[#939084] flex-shrink-0 w-24">
                {formatTime(entry.timestamp)}
              </span>
              <div className="flex-1 min-w-0">
                <span className="text-xs">
                  <span className="text-[#553DE9] font-medium">{entry.user || 'unknown'}</span>
                  <span className="text-[#6B6960]"> {entry.action} </span>
                  <span className="text-[#201515] dark:text-[#E8E6E3] font-medium">{entry.target}</span>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

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
        You do not have permission to access the admin dashboard.
        Contact your organization administrator for access.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Admin Page Tabs
// ---------------------------------------------------------------------------

type AdminTab = 'overview' | 'users' | 'analytics' | 'governance' | 'audit' | 'compliance';

const ADMIN_TABS: { id: AdminTab; label: string; icon: React.ComponentType<{ size?: number }> }[] = [
  { id: 'overview', label: 'Overview', icon: Activity },
  { id: 'users', label: 'Users', icon: Users },
  { id: 'analytics', label: 'Analytics', icon: BarChart3 },
  { id: 'governance', label: 'Governance', icon: FolderKanban },
  { id: 'audit', label: 'Audit Trail', icon: Clock },
  { id: 'compliance', label: 'Compliance', icon: Zap },
];

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function AdminPage() {
  const { user, isLocalMode } = useAuth();
  const [activeTab, setActiveTab] = useState<AdminTab>('overview');
  const [data, setData] = useState<OverviewData>({
    projects: undefined, teams: undefined, cost: undefined, audit: undefined,
  });

  // In local mode, allow access (single user). In auth mode, check role.
  // Since the User type doesn't have a role field, we allow access in local mode
  // and for authenticated users. In production, you'd check user.role === 'admin'.
  const isAdmin = isLocalMode || (user?.authenticated === true);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    Promise.allSettled([api.getSessionsHistory(), api.getTeams(), api.getCost(), api.getAuditLog()])
      .then(([history, teams, cost, audit]) => {
        if (cancelled) return;
        const val = <T,>(r: PromiseSettledResult<T>): T | null => (r.status === 'fulfilled' ? r.value : null);
        const t = val(teams);
        const h = val(history);
        const a = val(audit);
        setData({
          projects: Array.isArray(h) ? h.length : null,
          teams: Array.isArray(t)
            ? { count: t.length, members: t.reduce((n, x) => n + (x.members?.length ?? 0), 0) }
            : null,
          cost: val(cost),
          audit: Array.isArray(a) ? a : null,
        });
      });
    return () => { cancelled = true; };
  }, [isAdmin]);

  const fetchAudit = useCallback(async () => (await api.getAuditLog()).map(toAuditEvent), []);

  if (!isAdmin) {
    return <AccessDenied />;
  }

  const costBreakdown = costByModel(data.cost);

  return (
    <div className="max-w-[1200px] mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-heading text-h1 text-[#36342E] dark:text-[#E8E6E3]">Admin</h1>
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-[#ECEAE3] dark:border-[#2A2A30] mb-6 overflow-x-auto">
        {ADMIN_TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap ${
              activeTab === tab.id
                ? 'border-[#553DE9] text-[#553DE9]'
                : 'border-transparent text-[#939084] hover:text-[#36342E] dark:hover:text-[#E8E6E3]'
            }`}
          >
            <tab.icon size={14} />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <OverviewCard
              label="Projects"
              value={show(data.projects, String)}
              // /api/sessions/history reads at most 20 entries per search folder,
              // so this is a recent-folders count, not a machine-wide total.
              note="Recent project folders (history lists up to 20 per location)"
              icon={FolderKanban}
              color="#1FC5A8"
            />
            <OverviewCard
              label="Teams"
              value={show(data.teams, t => String(t.count))}
              note={data.teams ? `${data.teams.members} member${data.teams.members === 1 ? '' : 's'}` : 'Team membership'}
              icon={Users}
              color="#553DE9"
            />
            <OverviewCard
              label="Total cost"
              value={show(data.cost, c => formatUsd(c.estimated_cost_usd))}
              note="Recorded for the current project"
              icon={DollarSign}
              color="#C45B5B"
            />
            <OverviewCard
              label="Audit events"
              value={show(data.audit, a => String(a.length))}
              note="Recent-activity log entries"
              icon={ScrollText}
              color="#F59E0B"
            />
          </div>
          <RecentActivityLog entries={data.audit} />
        </div>
      )}

      {activeTab === 'users' && (
        <UserManagement />
      )}

      {activeTab === 'analytics' && (
        <UsageAnalytics data={costBreakdown ? { costBreakdown } : {}} />
      )}

      {activeTab === 'governance' && (
        <ProjectGovernance />
      )}

      {activeTab === 'audit' && (
        <AuditTrail onFetch={fetchAudit} />
      )}

      {activeTab === 'compliance' && (
        <ComplianceDashboard />
      )}
    </div>
  );
}
