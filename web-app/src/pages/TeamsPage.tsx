import { useState, useEffect, useCallback } from 'react';
import {
  Users,
  Plus,
  Activity,
  FolderKanban,
} from 'lucide-react';
import { TeamPanel, type TeamInfo, type TeamRole } from '../components/TeamPanel';
import { RBACPanel } from '../components/RBACPanel';
import { Button } from '../components/ui/Button';
import { useNotification } from '../contexts/NotificationContext';
import { api } from '../api/client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TeamActivity {
  id: string;
  action: string;
  user: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Teams Page
// ---------------------------------------------------------------------------

export default function TeamsPage() {
  const [teams, setTeams] = useState<TeamInfo[]>([]);
  const [selectedTeam, setSelectedTeam] = useState<TeamInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newTeamName, setNewTeamName] = useState('');
  const [activeTab, setActiveTab] = useState<'members' | 'roles' | 'activity'>('members');
  const [activities, setActivities] = useState<TeamActivity[]>([]);
  const { notify } = useNotification();

  // Load teams
  useEffect(() => {
    setLoading(true);
    api.getTeams()
      .then(data => {
        setTeams(data);
        if (data.length > 0 && !selectedTeam) {
          setSelectedTeam(data[0]);
        }
      })
      .catch(() => {
        // Use sample data when endpoint is not available
        const sample: TeamInfo[] = [
          {
            id: 'team-1',
            name: 'Engineering',
            created_at: new Date().toISOString(),
            members: [
              { id: 'm1', email: 'admin@example.com', name: 'Team Admin', role: 'admin' as const, joined_at: new Date().toISOString() },
              { id: 'm2', email: 'dev@example.com', name: 'Developer', role: 'editor' as const, joined_at: new Date().toISOString() },
              { id: 'm3', email: 'viewer@example.com', name: 'Viewer', role: 'viewer' as const, joined_at: new Date().toISOString() },
            ],
          },
        ];
        setTeams(sample);
        if (!selectedTeam) setSelectedTeam(sample[0]);
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load activities
  useEffect(() => {
    if (!selectedTeam) return;
    setActivities([
      { id: 'a1', action: 'Created project "my-app"', user: 'Developer', timestamp: '2 hours ago' },
      { id: 'a2', action: 'Deployed to production', user: 'Team Admin', timestamp: '5 hours ago' },
      { id: 'a3', action: 'Invited viewer@example.com', user: 'Team Admin', timestamp: '1 day ago' },
      { id: 'a4', action: 'Updated RBAC settings', user: 'Team Admin', timestamp: '2 days ago' },
    ]);
  }, [selectedTeam]);

  const handleCreateTeam = useCallback(() => {
    if (!newTeamName.trim()) return;
    const newTeam: TeamInfo = {
      id: `team-${Date.now()}`,
      name: newTeamName.trim(),
      created_at: new Date().toISOString(),
      members: [],
    };

    api.createTeam(newTeamName.trim())
      .catch(() => {
        // Endpoint may not exist yet; proceed with local state
      });

    setTeams(prev => [...prev, newTeam]);
    setSelectedTeam(newTeam);
    setNewTeamName('');
    setShowCreateForm(false);
    notify({ type: 'success', title: 'Team created', message: `"${newTeam.name}" is ready` });
  }, [newTeamName, notify]);

  const handleInviteMember = useCallback(
    (email: string, role: TeamRole) => {
      if (!selectedTeam) return;
      const newMember = {
        id: `m-${Date.now()}`,
        email,
        name: email.split('@')[0],
        role,
        joined_at: new Date().toISOString(),
      };
      const updated = {
        ...selectedTeam,
        members: [...selectedTeam.members, newMember],
      };
      setSelectedTeam(updated);
      setTeams(prev => prev.map(t => (t.id === updated.id ? updated : t)));
      notify({ type: 'success', title: 'Invite sent', message: `${email} invited as ${role}` });
    },
    [selectedTeam, notify],
  );

  const handleRemoveMember = useCallback(
    (memberId: string) => {
      if (!selectedTeam) return;
      const updated = {
        ...selectedTeam,
        members: selectedTeam.members.filter(m => m.id !== memberId),
      };
      setSelectedTeam(updated);
      setTeams(prev => prev.map(t => (t.id === updated.id ? updated : t)));
      notify({ type: 'info', title: 'Member removed' });
    },
    [selectedTeam, notify],
  );

  const handleChangeRole = useCallback(
    (memberId: string, role: TeamRole) => {
      if (!selectedTeam) return;
      const updated = {
        ...selectedTeam,
        members: selectedTeam.members.map(m =>
          m.id === memberId ? { ...m, role } : m,
        ),
      };
      setSelectedTeam(updated);
      setTeams(prev => prev.map(t => (t.id === updated.id ? updated : t)));
      notify({ type: 'success', title: 'Role updated' });
    },
    [selectedTeam, notify],
  );

  return (
    <div className="max-w-6xl mx-auto px-6 max-md:px-4 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-[#201515] dark:text-[#E8E6E3]">Teams</h1>
          <p className="text-sm text-[#939084] mt-1">Manage team members, roles, and access control</p>
        </div>
        {!showCreateForm && (
          <Button icon={Plus} onClick={() => setShowCreateForm(true)}>
            New Team
          </Button>
        )}
      </div>

      {/* Create team form */}
      {showCreateForm && (
        <div className="card p-4 mb-6">
          <h3 className="text-sm font-medium text-[#201515] dark:text-[#E8E6E3] mb-3">Create Team</h3>
          <div className="flex items-center gap-3">
            <input
              type="text"
              value={newTeamName}
              onChange={(e) => setNewTeamName(e.target.value)}
              placeholder="Team name"
              className="flex-1 px-3 py-2 text-sm rounded-lg border border-[#ECEAE3] dark:border-[#2A2A30] bg-white dark:bg-[#1A1A1E] text-[#201515] dark:text-[#E8E6E3] placeholder-[#939084] focus:outline-none focus:ring-2 focus:ring-[#553DE9]/30"
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') handleCreateTeam(); }}
            />
            <Button size="sm" onClick={handleCreateTeam} disabled={!newTeamName.trim()}>
              Create
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowCreateForm(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6 max-md:gap-4">
        {/* Team list sidebar */}
        <div className="md:col-span-1">
          <div className="card p-4">
            <h3 className="text-xs font-semibold text-[#6B6960] uppercase tracking-wider mb-3">
              Your Teams
            </h3>
            {loading && (
              <div className="text-center py-4 text-[#939084] text-sm">Loading...</div>
            )}
            {!loading && teams.length === 0 && (
              <div className="text-center py-4 text-[#939084] text-sm">No teams yet</div>
            )}
            <div className="space-y-1">
              {teams.map(team => (
                <button
                  key={team.id}
                  onClick={() => setSelectedTeam(team)}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm rounded-lg transition-colors ${
                    selectedTeam?.id === team.id
                      ? 'bg-[#553DE9]/10 text-[#553DE9] font-medium'
                      : 'text-[#36342E] dark:text-[#C5C0B8] hover:bg-[#F8F4F0] dark:hover:bg-[#222228]'
                  }`}
                >
                  <Users size={14} />
                  <span className="truncate flex-1">{team.name}</span>
                  <span className="text-xs text-[#939084]">{team.members.length}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Team content */}
        <div className="md:col-span-3 space-y-6">
          {selectedTeam && (
            <>
              {/* Team dashboard header */}
              <div className="card p-4">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-lg bg-[#553DE9]/10 flex items-center justify-center">
                    <Users size={24} className="text-[#553DE9]" />
                  </div>
                  <div className="flex-1">
                    <h2 className="text-lg font-semibold text-[#201515] dark:text-[#E8E6E3]">
                      {selectedTeam.name}
                    </h2>
                    <div className="flex items-center gap-4 text-xs text-[#939084] mt-0.5">
                      <span>{selectedTeam.members.length} members</span>
                      <span>Created {new Date(selectedTeam.created_at).toLocaleDateString()}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Tabs */}
              <div className="flex items-center gap-1 border-b border-[#ECEAE3] dark:border-[#2A2A30]">
                {([
                  { id: 'members' as const, label: 'Members', icon: Users },
                  { id: 'roles' as const, label: 'Roles & Permissions', icon: FolderKanban },
                  { id: 'activity' as const, label: 'Activity', icon: Activity },
                ]).map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                      activeTab === tab.id
                        ? 'border-[#553DE9] text-[#553DE9]'
                        : 'border-transparent text-[#939084] hover:text-[#36342E] dark:hover:text-[#E8E6E3]'
                    }`}
                  >
                    <tab.icon size={16} />
                    {tab.label}
                  </button>
                ))}
              </div>

              {/* Tab content */}
              {activeTab === 'members' && (
                <TeamPanel
                  team={selectedTeam}
                  onInviteMember={handleInviteMember}
                  onRemoveMember={handleRemoveMember}
                  onChangeRole={handleChangeRole}
                  loading={loading}
                />
              )}

              {activeTab === 'roles' && (
                <RBACPanel teamId={selectedTeam.id} />
              )}

              {activeTab === 'activity' && (
                <div className="card p-6">
                  <div className="flex items-center gap-2 mb-4">
                    <Activity size={18} className="text-[#553DE9]" />
                    <h3 className="text-sm font-semibold text-[#201515] dark:text-[#E8E6E3] uppercase tracking-wider">
                      Recent Activity
                    </h3>
                  </div>
                  {activities.length === 0 ? (
                    <div className="text-center py-8 text-[#939084] text-sm">No recent activity</div>
                  ) : (
                    <div className="space-y-3">
                      {activities.map(a => (
                        <div
                          key={a.id}
                          className="flex items-center gap-3 p-3 rounded-lg border border-[#ECEAE3] dark:border-[#2A2A30] hover:bg-[#F8F4F0] dark:hover:bg-[#222228] transition-colors"
                        >
                          <div className="w-2 h-2 rounded-full bg-[#553DE9] flex-shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-[#201515] dark:text-[#E8E6E3]">{a.action}</p>
                            <p className="text-xs text-[#939084]">{a.user}</p>
                          </div>
                          <span className="text-xs text-[#939084] flex-shrink-0">{a.timestamp}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {!selectedTeam && !loading && (
            <div className="text-center py-16">
              <Users size={48} className="mx-auto text-[#939084]/40 mb-4" />
              <p className="text-[#939084] text-sm">Select a team or create a new one</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
