import { useState, useEffect } from 'react';
import {
  Users,
  FolderKanban,
  Hammer,
  DollarSign,
  Activity,
  Server,
  Zap,
  Clock,
  ShieldAlert,
  BarChart3,
} from 'lucide-react';
import { useAuth } from '../hooks/useAuth';
import { UsageAnalytics } from '../components/UsageAnalytics';
import { AuditTrail } from '../components/AuditTrail';
import { UserManagement } from '../components/UserManagement';
import { ProjectGovernance } from '../components/ProjectGovernance';
import { ComplianceDashboard } from '../components/ComplianceDashboard';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OverviewCard {
  label: string;
  value: string;
  change?: string;
  changePositive?: boolean;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  color: string;
}

interface SystemHealth {
  name: string;
  status: 'healthy' | 'degraded' | 'down';
  latency?: number;
}

interface RecentAction {
  id: string;
  user: string;
  action: string;
  target: string;
  timestamp: string;
}

interface UserActivity {
  name: string;
  builds: number;
}

// ---------------------------------------------------------------------------
// Sample data generators
// ---------------------------------------------------------------------------

function generateOverviewCards(): OverviewCard[] {
  return [
    {
      label: 'Total Users',
      value: '24',
      change: '+3 this month',
      changePositive: true,
      icon: Users,
      color: '#553DE9',
    },
    {
      label: 'Active Projects',
      value: '18',
      change: '+5 this week',
      changePositive: true,
      icon: FolderKanban,
      color: '#1FC5A8',
    },
    {
      label: 'Total Builds',
      value: '342',
      change: '+47 this week',
      changePositive: true,
      icon: Hammer,
      color: '#F59E0B',
    },
    {
      label: 'Monthly Cost',
      value: '$201.00',
      change: '-12% vs last month',
      changePositive: true,
      icon: DollarSign,
      color: '#C45B5B',
    },
  ];
}

function generateSystemHealth(): SystemHealth[] {
  return [
    { name: 'API Server', status: 'healthy', latency: 45 },
    { name: 'Claude Provider', status: 'healthy', latency: 230 },
    { name: 'Codex Provider', status: 'degraded', latency: 890 },
    { name: 'Gemini Provider', status: 'healthy', latency: 310 },
    { name: 'Task Queue', status: 'healthy', latency: 12 },
    { name: 'WebSocket', status: 'healthy', latency: 8 },
  ];
}

function generateRecentActions(): RecentAction[] {
  const actions = [
    { user: 'alex@company.com', action: 'started build', target: 'customer-portal' },
    { user: 'sarah@company.com', action: 'deployed', target: 'analytics-dashboard' },
    { user: 'mike@company.com', action: 'created project', target: 'cli-tools' },
    { user: 'jordan@company.com', action: 'completed build', target: 'api-service' },
    { user: 'alex@company.com', action: 'updated settings', target: 'provider config' },
    { user: 'emily@company.com', action: 'invited user', target: 'new-dev@company.com' },
    { user: 'sarah@company.com', action: 'rotated API key', target: 'production' },
    { user: 'mike@company.com', action: 'started build', target: 'mobile-app' },
    { user: 'jordan@company.com', action: 'approved project', target: 'data-pipeline' },
    { user: 'alex@company.com', action: 'failed build', target: 'legacy-service' },
    { user: 'sarah@company.com', action: 'created checkpoint', target: 'analytics-dashboard' },
    { user: 'emily@company.com', action: 'changed role', target: 'mike -> editor' },
    { user: 'mike@company.com', action: 'deployed', target: 'cli-tools' },
    { user: 'alex@company.com', action: 'started build', target: 'landing-page' },
    { user: 'jordan@company.com', action: 'reviewed project', target: 'api-service' },
    { user: 'sarah@company.com', action: 'completed build', target: 'analytics-dashboard' },
    { user: 'emily@company.com', action: 'updated template', target: 'saas-app' },
    { user: 'mike@company.com', action: 'started build', target: 'discord-bot' },
    { user: 'alex@company.com', action: 'approved project', target: 'chrome-ext' },
    { user: 'jordan@company.com', action: 'deployed', target: 'data-pipeline' },
  ];

  return actions.map((a, i) => ({
    id: `act-${i}`,
    ...a,
    timestamp: new Date(Date.now() - i * 900000).toISOString(),
  }));
}

function generateUserActivity(): UserActivity[] {
  return [
    { name: 'Alex C.', builds: 87 },
    { name: 'Sarah J.', builds: 64 },
    { name: 'Mike D.', builds: 52 },
    { name: 'Jordan L.', builds: 41 },
    { name: 'Emily P.', builds: 38 },
    { name: 'Others', builds: 60 },
  ];
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function OverviewCards({ cards }: { cards: OverviewCard[] }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map(card => (
        <div key={card.label} className="card p-4">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs text-[#6B6960] uppercase tracking-wider">{card.label}</p>
              <p className="text-2xl font-bold text-[#36342E] dark:text-[#E8E6E3] mt-1">{card.value}</p>
              {card.change && (
                <p className={`text-xs mt-1 ${card.changePositive ? 'text-[#1FC5A8]' : 'text-[#C45B5B]'}`}>
                  {card.change}
                </p>
              )}
            </div>
            <div
              className="p-2 rounded-lg"
              style={{ backgroundColor: `${card.color}10`, color: card.color }}
            >
              <card.icon size={20} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function UserActivityChart({ data }: { data: UserActivity[] }) {
  const maxBuilds = Math.max(...data.map(d => d.builds));

  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-4">
        <BarChart3 size={14} className="text-[#553DE9]" />
        <h4 className="text-sm font-medium text-[#36342E] dark:text-[#E8E6E3]">Builds per User</h4>
      </div>
      <div className="space-y-3">
        {data.map(d => (
          <div key={d.name} className="flex items-center gap-3">
            <span className="text-xs text-[#6B6960] w-16 text-right flex-shrink-0">{d.name}</span>
            <div className="flex-1 h-6 bg-[#F8F4F0] dark:bg-[#1A1A1E] rounded-full overflow-hidden">
              <div
                className="h-full rounded-full bg-[#553DE9] transition-all duration-500 flex items-center justify-end pr-2"
                style={{ width: `${(d.builds / maxBuilds) * 100}%` }}
              >
                <span className="text-[10px] text-white font-mono">{d.builds}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SystemHealthPanel({ health }: { health: SystemHealth[] }) {
  const statusColors: Record<string, string> = {
    healthy: '#1FC5A8',
    degraded: '#F59E0B',
    down: '#C45B5B',
  };

  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-4">
        <Server size={14} className="text-[#553DE9]" />
        <h4 className="text-sm font-medium text-[#36342E] dark:text-[#E8E6E3]">System Health</h4>
      </div>
      <div className="space-y-2">
        {health.map(h => (
          <div key={h.name} className="flex items-center justify-between py-1.5">
            <div className="flex items-center gap-2">
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: statusColors[h.status] }}
              />
              <span className="text-sm text-[#36342E] dark:text-[#E8E6E3]">{h.name}</span>
            </div>
            <div className="flex items-center gap-3">
              {h.latency !== undefined && (
                <span className="text-xs font-mono text-[#939084]">{h.latency}ms</span>
              )}
              <span
                className="text-[10px] font-medium uppercase"
                style={{ color: statusColors[h.status] }}
              >
                {h.status}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RecentActivityLog({ actions }: { actions: RecentAction[] }) {
  const formatTime = (ts: string) =>
    new Date(ts).toLocaleString('en-US', {
      hour: '2-digit', minute: '2-digit', hour12: false,
    });

  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-4">
        <Activity size={14} className="text-[#553DE9]" />
        <h4 className="text-sm font-medium text-[#36342E] dark:text-[#E8E6E3]">Recent Activity</h4>
      </div>
      <div className="space-y-1 max-h-[400px] overflow-y-auto terminal-scroll">
        {actions.map(action => (
          <div
            key={action.id}
            className="flex items-center gap-3 px-2 py-1.5 rounded-lg hover:bg-[#F8F4F0] dark:hover:bg-[#222228] transition-colors"
          >
            <span className="text-[10px] font-mono text-[#939084] flex-shrink-0 w-10">
              {formatTime(action.timestamp)}
            </span>
            <div className="flex-1 min-w-0">
              <span className="text-xs">
                <span className="text-[#553DE9] font-medium">{action.user.split('@')[0]}</span>
                <span className="text-[#6B6960]"> {action.action} </span>
                <span className="text-[#201515] dark:text-[#E8E6E3] font-medium">{action.target}</span>
              </span>
            </div>
          </div>
        ))}
      </div>
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
import { Shield } from 'lucide-react';

export default function AdminPage() {
  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Shield size={24} className="text-[#553DE9] dark:text-[#8B7BF7]" />
        <h1 className="text-2xl font-heading font-bold text-[#36342E] dark:text-[#F5F3EE]">
          Admin
        </h1>
      </div>
      <p className="text-[#6B6960] dark:text-[#A8A49A]">
        System administration, user management, and configuration.
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

  // In local mode, allow access (single user). In auth mode, check role.
  // Since the User type doesn't have a role field, we allow access in local mode
  // and for authenticated users. In production, you'd check user.role === 'admin'.
  const isAdmin = isLocalMode || (user?.authenticated === true);

  const [overviewCards] = useState(generateOverviewCards);
  const [systemHealth] = useState(generateSystemHealth);
  const [recentActions] = useState(generateRecentActions);
  const [userActivity] = useState(generateUserActivity);

  if (!isAdmin) {
    return <AccessDenied />;
  }

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
          <OverviewCards cards={overviewCards} />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <UserActivityChart data={userActivity} />
            <SystemHealthPanel health={systemHealth} />
          </div>
          <RecentActivityLog actions={recentActions} />
        </div>
      )}

      {activeTab === 'users' && (
        <UserManagement />
      )}

      {activeTab === 'analytics' && (
        <UsageAnalytics />
      )}

      {activeTab === 'governance' && (
        <ProjectGovernance />
      )}

      {activeTab === 'audit' && (
        <AuditTrail />
      )}

      {activeTab === 'compliance' && (
        <ComplianceDashboard />
      )}
    </div>
  );
}
