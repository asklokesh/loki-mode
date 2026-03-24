import { useState, useEffect, useRef } from 'react';

function AnimatedCounter({ value, prefix = '', suffix = '' }: { value: number; prefix?: string; suffix?: string }) {
  const [displayed, setDisplayed] = useState(0);
  const ref = useRef<number>(0);

  useEffect(() => {
    const start = ref.current;
    const diff = value - start;
    if (diff === 0) return;

    const duration = 600;
    const startTime = performance.now();

    function animate(now: number) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Ease out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = Math.round(start + diff * eased);
      setDisplayed(current);
      ref.current = current;
      if (progress < 1) requestAnimationFrame(animate);
    }

    requestAnimationFrame(animate);
  }, [value]);

  return (
    <span className="tabular-nums">
      {prefix}{displayed.toLocaleString()}{suffix}
    </span>
  );
}

export function ROICalculator() {
  const [teamSize, setTeamSize] = useState(5);
  const [hoursPerWeek, setHoursPerWeek] = useState(30);
  const [hourlyRate, setHourlyRate] = useState(75);

  // Assumptions: Loki Mode saves ~40% of coding time
  const savingsPercent = 0.4;
  const weeksPerMonth = 4.33;

  const hoursSavedPerMonth = Math.round(teamSize * hoursPerWeek * savingsPercent * weeksPerMonth);
  const costSavedPerMonth = Math.round(hoursSavedPerMonth * hourlyRate);
  const annualSavings = costSavedPerMonth * 12;
  const lokiCost = 0; // Self-hosted, open source
  const roiPercent = lokiCost > 0 ? Math.round(((annualSavings - lokiCost) / lokiCost) * 100) : Infinity;

  return (
    <div className="bg-white border border-[#ECEAE3] rounded-xl p-6 shadow-sm">
      <h3 className="text-lg font-bold text-[#36342E] mb-1">ROI Calculator</h3>
      <p className="text-sm text-[#6B6960] mb-6">
        Estimate how much your team could save with autonomous development.
      </p>

      <div className="space-y-5">
        {/* Team size */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium text-[#36342E]">Team size</label>
            <span className="text-sm font-semibold text-[#553DE9] tabular-nums">{teamSize} developers</span>
          </div>
          <input
            type="range"
            min={1}
            max={50}
            value={teamSize}
            onChange={(e) => setTeamSize(Number(e.target.value))}
            className="w-full h-2 bg-[#ECEAE3] rounded-full appearance-none cursor-pointer accent-[#553DE9]"
          />
          <div className="flex justify-between text-xs text-[#939084] mt-1">
            <span>1</span>
            <span>50</span>
          </div>
        </div>

        {/* Hours per week */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium text-[#36342E]">Hours coding per week</label>
            <span className="text-sm font-semibold text-[#553DE9] tabular-nums">{hoursPerWeek}h</span>
          </div>
          <input
            type="range"
            min={5}
            max={60}
            value={hoursPerWeek}
            onChange={(e) => setHoursPerWeek(Number(e.target.value))}
            className="w-full h-2 bg-[#ECEAE3] rounded-full appearance-none cursor-pointer accent-[#553DE9]"
          />
          <div className="flex justify-between text-xs text-[#939084] mt-1">
            <span>5h</span>
            <span>60h</span>
          </div>
        </div>

        {/* Hourly rate */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium text-[#36342E]">Average hourly rate</label>
            <span className="text-sm font-semibold text-[#553DE9] tabular-nums">${hourlyRate}/hr</span>
          </div>
          <input
            type="range"
            min={25}
            max={250}
            step={5}
            value={hourlyRate}
            onChange={(e) => setHourlyRate(Number(e.target.value))}
            className="w-full h-2 bg-[#ECEAE3] rounded-full appearance-none cursor-pointer accent-[#553DE9]"
          />
          <div className="flex justify-between text-xs text-[#939084] mt-1">
            <span>$25</span>
            <span>$250</span>
          </div>
        </div>
      </div>

      {/* Results */}
      <div className="mt-6 pt-6 border-t border-[#ECEAE3]">
        <div className="grid grid-cols-3 gap-4 text-center">
          <div>
            <div className="text-2xl font-bold text-[#553DE9]">
              <AnimatedCounter value={hoursSavedPerMonth} suffix="h" />
            </div>
            <div className="text-xs text-[#6B6960] mt-1">Hours saved / month</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-[#1FC5A8]">
              <AnimatedCounter value={costSavedPerMonth} prefix="$" />
            </div>
            <div className="text-xs text-[#6B6960] mt-1">Cost saved / month</div>
          </div>
          <div>
            <div className="text-2xl font-bold text-[#36342E]">
              {roiPercent === Infinity ? 'Free' : <AnimatedCounter value={roiPercent} suffix="%" />}
            </div>
            <div className="text-xs text-[#6B6960] mt-1">ROI (open source)</div>
          </div>
        </div>

        <div className="mt-4 p-3 rounded-lg bg-[#553DE9]/5 border border-[#553DE9]/10">
          <p className="text-sm text-[#36342E] text-center">
            With Loki Mode, your team could save{' '}
            <span className="font-bold text-[#553DE9]">{hoursSavedPerMonth.toLocaleString()} hours</span>{' '}
            and{' '}
            <span className="font-bold text-[#1FC5A8]">${costSavedPerMonth.toLocaleString()}</span>{' '}
            per month.
          </p>
        </div>
      </div>
    </div>
  );
}
