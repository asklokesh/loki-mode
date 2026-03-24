import { ROICalculator } from '../components/ROICalculator';
import { TestimonialCard, TESTIMONIALS } from '../components/TestimonialCard';

interface ComparisonRow {
  feature: string;
  category: string;
  lokiMode: boolean | string;
  boltNew: boolean | string;
  replit: boolean | string;
  lovable: boolean | string;
}

const COMPARISON_DATA: ComparisonRow[] = [
  // AI Models
  { feature: 'Claude (Opus/Sonnet/Haiku)', category: 'AI Models', lokiMode: true, boltNew: false, replit: false, lovable: true },
  { feature: 'GPT-4o / Codex', category: 'AI Models', lokiMode: true, boltNew: true, replit: true, lovable: false },
  { feature: 'Gemini', category: 'AI Models', lokiMode: true, boltNew: false, replit: true, lovable: false },
  { feature: '5-provider auto-failover', category: 'AI Models', lokiMode: true, boltNew: false, replit: false, lovable: false },
  // Quality
  { feature: '9 automated quality gates', category: 'Quality', lokiMode: true, boltNew: false, replit: false, lovable: false },
  { feature: 'Blind 3-reviewer code review', category: 'Quality', lokiMode: true, boltNew: false, replit: false, lovable: false },
  { feature: 'Anti-sycophancy checks', category: 'Quality', lokiMode: true, boltNew: false, replit: false, lovable: false },
  { feature: 'Automated test generation', category: 'Quality', lokiMode: true, boltNew: false, replit: 'Partial', lovable: false },
  // Deployment
  { feature: 'Docker container generation', category: 'Deployment', lokiMode: true, boltNew: false, replit: true, lovable: false },
  { feature: 'CI/CD pipeline generation', category: 'Deployment', lokiMode: true, boltNew: false, replit: false, lovable: false },
  { feature: 'One-click cloud deploy', category: 'Deployment', lokiMode: 'Planned', boltNew: true, replit: true, lovable: true },
  // Cost & Hosting
  { feature: 'Self-hosted (your keys)', category: 'Cost', lokiMode: true, boltNew: false, replit: false, lovable: false },
  { feature: 'Free tier available', category: 'Cost', lokiMode: 'Open source', boltNew: true, replit: true, lovable: true },
  { feature: 'No vendor lock-in', category: 'Cost', lokiMode: true, boltNew: false, replit: false, lovable: false },
  // Enterprise
  { feature: 'SSO / OIDC authentication', category: 'Enterprise', lokiMode: true, boltNew: false, replit: true, lovable: false },
  { feature: 'RBAC access control', category: 'Enterprise', lokiMode: true, boltNew: false, replit: true, lovable: false },
  { feature: 'Audit logging', category: 'Enterprise', lokiMode: true, boltNew: false, replit: true, lovable: false },
  { feature: 'Air-gapped deployment', category: 'Enterprise', lokiMode: true, boltNew: false, replit: false, lovable: false },
];

function CheckIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="text-[#1FC5A8]">
      <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="text-[#C45B5B]/40">
      <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CellValue({ value }: { value: boolean | string }) {
  if (typeof value === 'string') {
    return <span className="text-xs text-[#6B6960] font-medium">{value}</span>;
  }
  return value ? <CheckIcon /> : <XIcon />;
}

const BENEFIT_CARDS = [
  {
    title: 'Full Autonomy',
    description: 'Describe what you want. Loki Mode handles planning, coding, testing, and verification automatically.',
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="text-[#553DE9]">
        <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    title: 'Production Quality',
    description: '9 quality gates, blind code review, and anti-sycophancy checks ensure code that actually works.',
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="text-[#1FC5A8]">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    title: 'Your Infrastructure',
    description: 'Self-hosted, open source, no data leaves your network. Use your own API keys across 5 providers.',
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="text-[#2F71E3]">
        <rect x="2" y="2" width="20" height="8" rx="2" stroke="currentColor" strokeWidth="2" />
        <rect x="2" y="14" width="20" height="8" rx="2" stroke="currentColor" strokeWidth="2" />
        <circle cx="6" cy="6" r="1" fill="currentColor" />
        <circle cx="6" cy="18" r="1" fill="currentColor" />
      </svg>
    ),
  },
  {
    title: 'Built for Teams',
    description: 'Enterprise auth, RBAC, audit logs, and parallel workflows for teams of any size.',
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="text-[#E93D82]">
        <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="9" cy="7" r="4" stroke="currentColor" strokeWidth="2" />
        <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
];

export default function ComparePage() {
  // Group comparison rows by category
  const categories = [...new Set(COMPARISON_DATA.map((r) => r.category))];

  return (
    <div className="min-h-screen bg-[#FAF9F6]">
      <div className="max-w-6xl mx-auto px-6 py-8">
        {/* Page header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-[#36342E]">Compare</h1>
          <p className="text-[#6B6960] mt-1">
            See how Loki Mode stacks up against other AI development platforms.
          </p>
        </div>

        {/* Comparison table */}
        <div className="bg-white border border-[#ECEAE3] rounded-xl overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#ECEAE3]">
                  <th className="text-left px-4 py-3 font-medium text-[#6B6960] w-[240px]">Feature</th>
                  <th className="text-center px-4 py-3 font-bold text-[#553DE9] bg-[#553DE9]/5 w-[130px]">
                    Loki Mode
                  </th>
                  <th className="text-center px-4 py-3 font-medium text-[#6B6960] w-[130px]">bolt.new</th>
                  <th className="text-center px-4 py-3 font-medium text-[#6B6960] w-[130px]">Replit</th>
                  <th className="text-center px-4 py-3 font-medium text-[#6B6960] w-[130px]">Lovable</th>
                </tr>
              </thead>
              <tbody>
                {categories.map((category) => (
                  <>
                    <tr key={`cat-${category}`} className="bg-[#FAF9F6]">
                      <td
                        colSpan={5}
                        className="px-4 py-2 text-xs font-bold text-[#939084] uppercase tracking-wider"
                      >
                        {category}
                      </td>
                    </tr>
                    {COMPARISON_DATA.filter((r) => r.category === category).map((row) => (
                      <tr key={row.feature} className="border-b border-[#ECEAE3] last:border-b-0">
                        <td className="px-4 py-2.5 text-[#36342E]">{row.feature}</td>
                        <td className="px-4 py-2.5 text-center bg-[#553DE9]/5">
                          <div className="flex justify-center">
                            <CellValue value={row.lokiMode} />
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-center">
                          <div className="flex justify-center">
                            <CellValue value={row.boltNew} />
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-center">
                          <div className="flex justify-center">
                            <CellValue value={row.replit} />
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-center">
                          <div className="flex justify-center">
                            <CellValue value={row.lovable} />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Why developers choose Loki Mode */}
        <div className="mt-12">
          <h2 className="text-xl font-bold text-[#36342E] mb-6">
            Why developers choose Loki Mode
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {BENEFIT_CARDS.map((card) => (
              <div
                key={card.title}
                className="bg-white border border-[#ECEAE3] rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow"
              >
                <div className="mb-3">{card.icon}</div>
                <h3 className="text-base font-bold text-[#36342E] mb-1">{card.title}</h3>
                <p className="text-sm text-[#6B6960]">{card.description}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Testimonials */}
        <div className="mt-12">
          <h2 className="text-xl font-bold text-[#36342E] mb-6">
            What developers are saying
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {TESTIMONIALS.map((t) => (
              <TestimonialCard key={t.name} {...t} />
            ))}
          </div>
        </div>

        {/* ROI Calculator */}
        <div className="mt-12 max-w-xl mx-auto">
          <ROICalculator />
        </div>
      </div>
    </div>
  );
}
