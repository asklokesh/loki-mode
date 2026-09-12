import { useState, useEffect, useMemo } from 'react';
import { DollarSign, Coins, Layers, TrendingUp, TrendingDown } from 'lucide-react';
import { LineChart } from '../components/charts/LineChart';
import { DonutChart } from '../components/charts/DonutChart';
import { EvidenceReceiptPanel } from '../components/EvidenceReceiptPanel';
import { api } from '../api/client';

// ---------------------------------------------------------------------------
// THIS PAGE RENDERS ONLY MEASURED VALUES.
//
// It previously shipped seven hardcoded arrays and zero fetch calls: a cost
// trend, a token split, builds-per-day, a 28-day activity heatmap built from
// Math.random(), a provider-comparison radar, a pipeline timeline, four KPI
// cards with invented sparklines, a GaugeChart pinned to 87, and a CodeTimeline
// listing three fabricated iterations with made-up file paths and line counts.
// All of it looked like measurement and none of it was.
//
// Everything below now comes from /api/cost and /api/cost/timeline. Surfaces
// with no backing field in either payload were DELETED rather than re-fed from
// a new source of invented numbers -- there is no builds-per-day series, no
// per-provider quality score, and no pipeline-phase series in the API, so those
// charts do not appear.
//
// The honesty contract is inherited from the readers these delegate to: when
// nothing was recorded, the API returns null with cost_recorded=false. Null
// renders as "Not recorded", NEVER as $0.00 or 0 -- a zero is a measurement,
// and claiming one we do not have is the defect this page used to be.
// ---------------------------------------------------------------------------

type CostSummary = Awaited<ReturnType<typeof api.getCost>>;
type CostTimeline = Awaited<ReturnType<typeof api.getCostTimeline>>;

const ACCENT = '#553DE9';
const TEAL = '#1FC5A8';
const BLUE = '#6B8AFD';
const GOLD = '#D4A843';

function formatUsd(v: number | null | undefined): string {
  if (v === null || v === undefined) return 'Not recorded';
  return `$${v.toFixed(2)}`;
}

function formatCount(v: number | null | undefined): string {
  if (v === null || v === undefined) return 'Not recorded';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}

// ---------------------------------------------------------------------------
// KPI card. `value` is a pre-formatted string so an unmeasured metric can say
// "Not recorded" instead of being coerced through a number formatter.
// ---------------------------------------------------------------------------
const colorClassMap: Record<string, string> = {
  [ACCENT]: 'text-[#553DE9]',
  [TEAL]: 'text-[#1FC5A8]',
  [BLUE]: 'text-[#6B8AFD]',
  [GOLD]: 'text-[#D4A843]',
};

interface KPICardProps {
  label: string;
  value: string;
  detail?: string;
  trend?: number | null;
  icon: React.ComponentType<{ className?: string; size?: number }>;
  color: string;
}

function KPICard({ label, value, detail, trend, icon: Icon, color }: KPICardProps) {
  const TrendIcon = trend != null && trend < 0 ? TrendingDown : TrendingUp;
  return (
    <div className="rounded-card border border-[#ECEAE3] dark:border-[#2A2A2E] bg-white dark:bg-[#18181B] p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-[#6B6960] dark:text-[#A8A69E]">{label}</span>
        <Icon className={colorClassMap[color] ?? ''} size={16} />
      </div>
      <div className="text-xl font-semibold text-[#36342E] dark:text-[#E8E6E3] tabular-nums">
        {value}
      </div>
      {detail && (
        <div className="mt-1 text-xs text-[#6B6960] dark:text-[#A8A69E]">{detail}</div>
      )}
      {trend != null && (
        <div className="mt-1 flex items-center gap-1 text-xs text-[#6B6960] dark:text-[#A8A69E]">
          <TrendIcon size={12} />
          <span className="tabular-nums">{Math.abs(trend).toFixed(1)}%</span>
        </div>
      )}
    </div>
  );
}

function ChartCard({ title, subtitle, children }: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-card border border-[#ECEAE3] dark:border-[#2A2A2E] bg-white dark:bg-[#18181B] p-4">
      <h3 className="text-sm font-semibold text-[#36342E] dark:text-[#E8E6E3] mb-1">{title}</h3>
      {subtitle && (
        <p className="text-xs text-[#6B6960] dark:text-[#A8A69E] mb-3">{subtitle}</p>
      )}
      {children}
    </div>
  );
}

// An explicit empty state. A chart with no series must say so rather than draw
// empty axes that read as "zero spend".
function NoData({ what }: { what: string }) {
  return (
    <div className="flex h-[200px] items-center justify-center text-center">
      <p className="max-w-[26ch] text-xs text-[#6B6960] dark:text-[#A8A69E]">
        No {what} recorded yet. This fills in once a build writes cost data.
      </p>
    </div>
  );
}

export function MetricsPage() {
  const [cost, setCost] = useState<CostSummary | null>(null);
  const [timeline, setTimeline] = useState<CostTimeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [containerWidth, setContainerWidth] = useState(560);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [c, t] = await Promise.all([api.getCost(), api.getCostTimeline()]);
        if (cancelled) return;
        setCost(c);
        setTimeline(t);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        // Surface the real message. The previous page could not fail at all,
        // because it never called anything.
        setError(e instanceof Error ? e.message : 'Could not load cost data');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const chartWidth = Math.max(280, containerWidth - 48);

  // Per-run cost history. `runs` is the persistent per-run series; an entry
  // with a null cost is dropped rather than plotted as 0.
  const costTrend = useMemo(() => {
    const runs = timeline?.runs ?? [];
    return runs
      .filter((r) => typeof r.cost_usd === 'number')
      .map((r, i) => ({
        label: r.run_id ? r.run_id.slice(-6) : `run ${i + 1}`,
        value: r.cost_usd as number,
      }));
  }, [timeline]);

  // Token split. Only non-null counts become segments, so a partially recorded
  // run shows the parts it has rather than implying zeros for the rest.
  const tokenSegments = useMemo(() => {
    if (!cost) return [];
    const parts: Array<[string, number | null, string]> = [
      ['Input', cost.total_input_tokens, ACCENT],
      ['Output', cost.total_output_tokens, TEAL],
      ['Cache read', cost.total_cache_read_tokens, BLUE],
      ['Cache write', cost.total_cache_creation_tokens, GOLD],
    ];
    return parts
      .filter(([, v]) => typeof v === 'number' && v > 0)
      .map(([label, v, color]) => ({ label, value: v as number, color }));
  }, [cost]);

  const budget = timeline?.budget;

  if (loading) {
    return (
      <div className="p-6">
        <p className="text-sm text-[#6B6960] dark:text-[#A8A69E]">Loading cost data...</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      <h1 className="text-lg font-semibold text-[#36342E] dark:text-[#E8E6E3] mb-1">Metrics</h1>
      <p className="text-xs text-[#6B6960] dark:text-[#A8A69E] mb-6">
        Measured cost and token usage. Values read &quot;Not recorded&quot; when no build has
        written them.
      </p>

      {error && (
        <div className="mb-6 rounded-card border border-[#C45B5B]/30 bg-[#C45B5B]/5 p-4">
          <p className="text-xs text-[#C45B5B]">{error}</p>
        </div>
      )}

      {/* The Evidence Receipt is the durable record of what a past build proved,
          and this route needs no running session -- which is the state a user is
          in when they come looking for it. */}
      <div className="mb-6 rounded-card border border-[#ECEAE3] dark:border-[#2A2A2E] bg-white dark:bg-[#18181B] p-4">
        <EvidenceReceiptPanel />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <KPICard
          label="Total cost"
          value={formatUsd(cost?.estimated_cost_usd)}
          detail={cost?.cost_recorded === false ? 'No cost recorded yet' : undefined}
          icon={DollarSign}
          color={GOLD}
        />
        <KPICard
          label="Total tokens"
          value={formatCount(cost?.total_tokens)}
          icon={Coins}
          color={ACCENT}
        />
        <KPICard
          label="Runs with cost"
          value={String(timeline?.runs_count ?? 0)}
          detail="Runs that wrote a receipt"
          icon={Layers}
          color={BLUE}
        />
        <KPICard
          label="Budget used"
          value={
            budget?.percent_used == null
              ? 'No budget set'
              : `${budget.percent_used.toFixed(0)}%`
          }
          detail={
            budget?.limit == null
              ? undefined
              : `${formatUsd(budget.used)} of ${formatUsd(budget.limit)}`
          }
          icon={TrendingUp}
          color={budget?.exceeded ? '#C45B5B' : TEAL}
        />
      </div>

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
        <ChartCard title="Cost per run" subtitle="From each run's Evidence Receipt">
          {costTrend.length > 0 ? (
            <LineChart data={costTrend} width={chartWidth} height={220} color={ACCENT} />
          ) : (
            <NoData what="per-run cost" />
          )}
        </ChartCard>

        <ChartCard title="Token usage" subtitle="Input, output and cache totals">
          {tokenSegments.length > 0 ? (
            <DonutChart segments={tokenSegments} size={190} thickness={28} />
          ) : (
            <NoData what="token usage" />
          )}
        </ChartCard>
      </div>
    </div>
  );
}

export default MetricsPage;
