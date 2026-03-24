import { useState, useMemo } from 'react';
import {
  Layers,
  CheckCircle2,
  Clock,
  DollarSign,
  TrendingUp,
  TrendingDown,
} from 'lucide-react';
import { LineChart } from '../components/charts/LineChart';
import { DonutChart } from '../components/charts/DonutChart';
import { BarChart } from '../components/charts/BarChart';
import { GaugeChart } from '../components/charts/GaugeChart';
import { Sparkline } from '../components/charts/Sparkline';
import { HeatMap } from '../components/charts/HeatMap';
import { RadarChart } from '../components/charts/RadarChart';
import { Timeline } from '../components/charts/Timeline';

// --------------------------------------------------------------------------
// Sample data -- in production these would come from API
// --------------------------------------------------------------------------

const costTrendData = [
  { label: 'Mon', value: 12.5 },
  { label: 'Tue', value: 18.3 },
  { label: 'Wed', value: 14.7 },
  { label: 'Thu', value: 22.1 },
  { label: 'Fri', value: 19.8 },
  { label: 'Sat', value: 8.4 },
  { label: 'Sun', value: 15.6 },
];

const tokenSegments = [
  { label: 'Input', value: 245000, color: '#553DE9' },
  { label: 'Output', value: 128000, color: '#1FC5A8' },
  { label: 'Cached', value: 89000, color: '#6B8AFD' },
  { label: 'System', value: 42000, color: '#D4A843' },
];

const buildsPerDay = [
  { label: 'Mon', value: 8 },
  { label: 'Tue', value: 12 },
  { label: 'Wed', value: 6 },
  { label: 'Thu', value: 15 },
  { label: 'Fri', value: 11 },
  { label: 'Sat', value: 3 },
  { label: 'Sun', value: 5 },
];

const heatmapData = Array.from({ length: 28 }, (_, i) => ({
  date: `Mar ${i + 1}`,
  count: Math.floor(Math.random() * 12),
}));

const radarAxes = [
  { label: 'Speed' },
  { label: 'Quality' },
  { label: 'Cost' },
  { label: 'Reliability' },
  { label: 'Coverage' },
];

const radarDatasets = [
  { label: 'Claude', values: [85, 92, 65, 88, 78], color: '#553DE9' },
  { label: 'Codex', values: [78, 70, 80, 72, 60], color: '#1FC5A8' },
];

const timelinePhases = [
  { name: 'Plan', duration: 12, color: '#6B8AFD', status: 'completed' as const },
  { name: 'Build', duration: 45, color: '#553DE9', status: 'completed' as const },
  { name: 'Test', duration: 18, color: '#1FC5A8', status: 'active' as const },
  { name: 'Deploy', duration: 8, color: '#D4A843', status: 'pending' as const },
];

// KPI definitions
const kpiData = [
  {
    label: 'Total Builds',
    value: 142,
    trend: 12.4,
    sparkline: [8, 12, 6, 15, 11, 3, 5, 9, 14, 7],
    icon: Layers,
    color: '#553DE9',
  },
  {
    label: 'Success Rate',
    value: 94.2,
    suffix: '%',
    trend: 2.1,
    sparkline: [88, 91, 90, 93, 92, 95, 94, 96, 93, 94],
    icon: CheckCircle2,
    color: '#1FC5A8',
  },
  {
    label: 'Avg Build Time',
    value: 3.2,
    suffix: 'min',
    trend: -8.5,
    sparkline: [4.1, 3.8, 3.5, 3.9, 3.4, 3.2, 3.6, 3.1, 3.3, 3.2],
    icon: Clock,
    color: '#6B8AFD',
  },
  {
    label: 'Total Cost',
    value: 84.30,
    prefix: '$',
    trend: 15.2,
    sparkline: [12, 18, 14, 22, 19, 8, 15, 10, 16, 13],
    icon: DollarSign,
    color: '#D4A843',
  },
];

// --------------------------------------------------------------------------
// KPI Card sub-component
// --------------------------------------------------------------------------

// Map color hex to tailwind-compatible class for lucide icons
const colorClassMap: Record<string, string> = {
  '#553DE9': 'text-[#553DE9]',
  '#1FC5A8': 'text-[#1FC5A8]',
  '#6B8AFD': 'text-[#6B8AFD]',
  '#D4A843': 'text-[#D4A843]',
};

interface KPICardProps {
  label: string;
  value: number;
  prefix?: string;
  suffix?: string;
  trend: number;
  sparkline: number[];
  icon: React.ComponentType<{ size?: number; className?: string }>;
  color: string;
}

function KPICard({ label, value, prefix, suffix, trend, sparkline, icon: Icon, color }: KPICardProps) {
  const trendUp = trend >= 0;
  // For build time, negative trend is good
  const isGoodTrend = label === 'Avg Build Time' ? trend < 0 : trend > 0;
  const TrendIcon = trendUp ? TrendingUp : TrendingDown;
  const iconClass = colorClassMap[color] || 'text-[#553DE9]';

  return (
    <div className="card p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{ backgroundColor: `${color}14` }}
          >
            <Icon size={16} className={iconClass} />
          </div>
          <span className="text-xs text-[#6B6960] dark:text-[#8A8880] font-medium">{label}</span>
        </div>
        <Sparkline data={sparkline} color={color} />
      </div>

      <div className="flex items-end justify-between">
        <span className="text-2xl font-bold text-[#36342E] dark:text-[#E8E6E3]">
          {prefix}{typeof value === 'number' && value % 1 !== 0 ? value.toFixed(1) : value}
          {suffix && <span className="text-sm font-normal text-[#939084] ml-1">{suffix}</span>}
        </span>
        <div className={`flex items-center gap-1 text-xs font-medium ${
          isGoodTrend ? 'text-[#1FC5A8]' : 'text-[#C07A5E]'
        }`}>
          <TrendIcon size={12} />
          <span>{Math.abs(trend).toFixed(1)}%</span>
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Chart wrapper with title
// --------------------------------------------------------------------------

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card p-5">
      <h3 className="text-sm font-semibold text-[#36342E] dark:text-[#E8E6E3] mb-4">{title}</h3>
      <div className="flex items-center justify-center">
        {children}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// MetricsPage
// --------------------------------------------------------------------------

export function MetricsPage() {
  // Track chart container widths for responsive sizing
  const [containerWidth, setContainerWidth] = useState(380);

  const chartWidth = useMemo(() => Math.min(containerWidth - 40, 420), [containerWidth]);

  return (
    <div className="min-h-screen bg-[#FAF9F6] dark:bg-[#0F0F11] p-6">
      {/* Page header */}
      <div className="mb-6">
        <h1 className="text-xl font-bold text-[#36342E] dark:text-[#E8E6E3]">Metrics</h1>
        <p className="text-sm text-[#6B6960] dark:text-[#8A8880] mt-1">
          Build performance, cost tracking, and system health
        </p>
      </div>

      {/* KPI cards - 4 column grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {kpiData.map((kpi) => (
          <KPICard key={kpi.label} {...kpi} />
        ))}
      </div>

      {/* Main charts - 2x2 grid */}
      <div
        className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6"
        ref={(el) => {
          if (el) {
            const obs = new ResizeObserver((entries) => {
              const entry = entries[0];
              if (entry) {
                const cols = window.innerWidth >= 1024 ? 2 : 1;
                setContainerWidth(Math.floor(entry.contentRect.width / cols));
              }
            });
            obs.observe(el);
          }
        }}
      >
        <ChartCard title="Cost Trend (7 days)">
          <LineChart data={costTrendData} width={chartWidth} height={220} color="#553DE9" />
        </ChartCard>

        <ChartCard title="Token Usage">
          <DonutChart segments={tokenSegments} size={190} thickness={28} />
        </ChartCard>

        <ChartCard title="Builds Per Day">
          <BarChart data={buildsPerDay} width={chartWidth} height={220} color="#6B8AFD" />
        </ChartCard>

        <ChartCard title="Quality Score">
          <GaugeChart value={87} label="Overall Quality" size={200} />
        </ChartCard>
      </div>

      {/* Secondary charts row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <ChartCard title="Agent Activity (28 days)">
          <HeatMap data={heatmapData} columns={7} rows={4} color="#553DE9" />
        </ChartCard>

        <ChartCard title="Provider Comparison">
          <RadarChart axes={radarAxes} datasets={radarDatasets} size={240} />
        </ChartCard>

        <ChartCard title="Current Pipeline">
          <Timeline phases={timelinePhases} width={Math.min(chartWidth, 360)} height={72} />
        </ChartCard>
      </div>
    </div>
  );
}

export default MetricsPage;
import { BarChart3 } from 'lucide-react';

export default function MetricsPage() {
  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <BarChart3 size={24} className="text-[#553DE9] dark:text-[#8B7BF7]" />
        <h1 className="text-2xl font-heading font-bold text-[#36342E] dark:text-[#F5F3EE]">
          Metrics
        </h1>
      </div>
      <p className="text-[#6B6960] dark:text-[#A8A49A]">
        System-wide metrics, token usage, cost tracking, and performance analytics.
      </p>
    </div>
  );
}
