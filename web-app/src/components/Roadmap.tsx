type FeatureStatus = 'completed' | 'in-progress' | 'planned';

interface RoadmapFeature {
  name: string;
  status: FeatureStatus;
}

interface RoadmapQuarter {
  label: string;
  period: string;
  features: RoadmapFeature[];
}

const ROADMAP: RoadmapQuarter[] = [
  {
    label: 'Q1 2026',
    period: 'Jan - Mar',
    features: [
      { name: 'Multi-provider support (5 providers)', status: 'completed' },
      { name: 'Memory system with vector search', status: 'completed' },
      { name: 'Purple Lab web UI', status: 'completed' },
      { name: 'Enterprise auth (OIDC, RBAC)', status: 'completed' },
      { name: 'Legacy system healing', status: 'completed' },
    ],
  },
  {
    label: 'Q2 2026',
    period: 'Apr - Jun',
    features: [
      { name: 'Real-time collaboration (multi-user)', status: 'in-progress' },
      { name: 'Visual workflow builder', status: 'in-progress' },
      { name: 'Plugin marketplace', status: 'planned' },
      { name: 'Custom agent creation UI', status: 'planned' },
    ],
  },
  {
    label: 'Q3 2026',
    period: 'Jul - Sep',
    features: [
      { name: 'Cloud deployment integration', status: 'planned' },
      { name: 'Team analytics dashboard', status: 'planned' },
      { name: 'AI-powered debugging assistant', status: 'planned' },
      { name: 'Mobile companion app', status: 'planned' },
    ],
  },
  {
    label: 'Q4 2026',
    period: 'Oct - Dec',
    features: [
      { name: 'Multi-repo orchestration', status: 'planned' },
      { name: 'Custom model fine-tuning', status: 'planned' },
      { name: 'Compliance report generation', status: 'planned' },
      { name: 'On-prem cluster mode', status: 'planned' },
    ],
  },
];

const STATUS_STYLES: Record<FeatureStatus, { dot: string; text: string; label: string }> = {
  completed: { dot: 'bg-[#1FC5A8]', text: 'text-[#36342E]', label: 'Shipped' },
  'in-progress': { dot: 'bg-[#553DE9]', text: 'text-[#36342E]', label: 'In Progress' },
  planned: { dot: 'bg-[#939084]', text: 'text-[#6B6960]', label: 'Planned' },
};

export function Roadmap() {
  return (
    <div className="py-8">
      <h3 className="text-xl font-bold text-[#36342E] mb-2">Product Roadmap</h3>
      <p className="text-sm text-[#6B6960] mb-8">
        Where we have been and where we are heading.
      </p>

      {/* Legend */}
      <div className="flex gap-6 mb-6">
        {(['completed', 'in-progress', 'planned'] as FeatureStatus[]).map((status) => (
          <div key={status} className="flex items-center gap-2 text-xs">
            <span className={`w-2.5 h-2.5 rounded-full ${STATUS_STYLES[status].dot}`} />
            <span className="text-[#6B6960]">{STATUS_STYLES[status].label}</span>
          </div>
        ))}
      </div>

      {/* Timeline */}
      <div className="relative">
        {/* Vertical line */}
        <div className="absolute left-[7px] top-2 bottom-2 w-0.5 bg-[#ECEAE3]" />

        <div className="space-y-8">
          {ROADMAP.map((quarter, qi) => (
            <div key={quarter.label} className="relative pl-8">
              {/* Timeline dot */}
              <div
                className={`absolute left-0 top-1 w-[15px] h-[15px] rounded-full border-2 border-white shadow-sm ${
                  qi === 0
                    ? 'bg-[#1FC5A8]'
                    : qi === 1
                      ? 'bg-[#553DE9]'
                      : 'bg-[#ECEAE3]'
                }`}
              />

              <div>
                <div className="flex items-baseline gap-2 mb-3">
                  <h4 className="text-base font-bold text-[#36342E]">{quarter.label}</h4>
                  <span className="text-xs text-[#939084]">{quarter.period}</span>
                  {qi === 1 && (
                    <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-[#553DE9]/10 text-[#553DE9]">
                      Current
                    </span>
                  )}
                </div>

                <div className="space-y-2">
                  {quarter.features.map((feature) => {
                    const style = STATUS_STYLES[feature.status];
                    return (
                      <div key={feature.name} className="flex items-center gap-2.5">
                        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${style.dot}`} />
                        <span className={`text-sm ${style.text}`}>{feature.name}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
