import { useEffect, useRef, useState } from 'react';
import { Package, Cloud, Code2 } from 'lucide-react';

interface CounterProps {
  end: number;
  suffix?: string;
  duration?: number;
}

function AnimatedCounter({ end, suffix = '', duration = 1500 }: CounterProps) {
  const [count, setCount] = useState(0);
  const ref = useRef<HTMLSpanElement>(null);
  const hasAnimated = useRef(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !hasAnimated.current) {
          hasAnimated.current = true;
          const startTime = performance.now();
          const animate = (now: number) => {
            const elapsed = now - startTime;
            const progress = Math.min(elapsed / duration, 1);
            // Ease out cubic
            const eased = 1 - Math.pow(1 - progress, 3);
            setCount(Math.floor(eased * end));
            if (progress < 1) requestAnimationFrame(animate);
          };
          requestAnimationFrame(animate);
        }
      },
      { threshold: 0.3 }
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [end, duration]);

  return (
    <span ref={ref} className="tabular-nums">
      {count}{suffix}
    </span>
  );
}

const STATS = [
  {
    icon: Package,
    value: 21,
    suffix: '+',
    label: 'Templates',
  },
  {
    icon: Cloud,
    value: 5,
    suffix: '',
    label: 'AI Providers',
  },
  {
    icon: Code2,
    value: 100,
    suffix: '%',
    label: 'Open Source',
  },
];

export function TrustedBy() {
  return (
    <section className="w-full max-w-3xl mx-auto mt-16 mb-4">
      <p className="text-center text-sm text-[#6B6960] mb-8 tracking-wide uppercase font-medium">
        Trusted by developers building the future
      </p>

      <div className="flex items-center justify-center gap-12 sm:gap-16">
        {STATS.map((stat) => {
          const Icon = stat.icon;
          return (
            <div key={stat.label} className="flex flex-col items-center gap-2">
              <Icon size={20} className="text-[#553DE9]" strokeWidth={1.5} />
              <span className="text-2xl font-bold text-[#36342E]">
                <AnimatedCounter end={stat.value} suffix={stat.suffix} />
              </span>
              <span className="text-xs text-[#6B6960] font-medium">{stat.label}</span>
            </div>
          );
        })}
      </div>

      {/* Subtle divider */}
      <div className="mt-12 border-t border-[#ECEAE3]" />
    </section>
  );
}
