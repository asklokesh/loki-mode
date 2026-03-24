import { useEffect, useRef, useState } from 'react';
import { MessageSquare, Hammer, Rocket } from 'lucide-react';

interface StepProps {
  icon: React.ComponentType<{ size?: number; className?: string; strokeWidth?: number }>;
  number: number;
  title: string;
  description: string;
  mockup: React.ReactNode;
  delay: number;
}

function Step({ icon: Icon, number, title, description, mockup, delay }: StepProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setTimeout(() => setVisible(true), delay);
          observer.disconnect();
        }
      },
      { threshold: 0.2 }
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [delay]);

  return (
    <div
      ref={ref}
      className={`flex flex-col items-center text-center max-w-xs transition-all duration-700 ${
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'
      }`}
    >
      {/* Step number + icon */}
      <div className="relative mb-4">
        <div className="w-14 h-14 rounded-2xl bg-[#553DE9]/10 flex items-center justify-center">
          <Icon size={24} className="text-[#553DE9]" strokeWidth={1.5} />
        </div>
        <span className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-[#553DE9] text-white text-xs font-bold flex items-center justify-center">
          {number}
        </span>
      </div>

      <h3 className="text-lg font-bold text-[#36342E] mb-1.5">{title}</h3>
      <p className="text-sm text-[#6B6960] mb-4 leading-relaxed">{description}</p>

      {/* Mini mockup */}
      <div className="w-full rounded-xl border border-[#ECEAE3] bg-white p-3 shadow-sm">
        {mockup}
      </div>
    </div>
  );
}

function InputMockup() {
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 px-3 py-2 rounded-lg bg-[#FAF9F6] border border-[#ECEAE3] text-left">
        <span className="text-xs text-[#36342E]">Build a SaaS dashboard with analytics</span>
      </div>
      <div className="w-7 h-7 rounded-lg bg-[#553DE9] flex items-center justify-center flex-shrink-0">
        <Rocket size={12} className="text-white" />
      </div>
    </div>
  );
}

function ProgressMockup() {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-[10px] text-[#6B6960]">
        <span>Phase: Implementation</span>
        <span>68%</span>
      </div>
      <div className="w-full h-2 rounded-full bg-[#ECEAE3] overflow-hidden">
        <div
          className="h-full rounded-full bg-gradient-to-r from-[#553DE9] to-[#1FC5A8]"
          style={{ width: '68%' }}
        />
      </div>
      <div className="flex gap-1">
        {['Planning', 'Scaffolding', 'Implementation', 'Testing', 'Deploy'].map((phase, i) => (
          <span
            key={phase}
            className={`text-[9px] px-1.5 py-0.5 rounded ${
              i <= 2
                ? 'bg-[#553DE9]/10 text-[#553DE9] font-medium'
                : 'bg-[#ECEAE3]/60 text-[#6B6960]'
            }`}
          >
            {phase}
          </span>
        ))}
      </div>
    </div>
  );
}

function SuccessMockup() {
  return (
    <div className="space-y-2 text-left">
      <div className="flex items-center gap-2">
        <div className="w-5 h-5 rounded-full bg-[#1FC5A8]/20 flex items-center justify-center">
          <svg width="10" height="8" viewBox="0 0 10 8" fill="none">
            <path d="M1 4L3.5 6.5L9 1" stroke="#1FC5A8" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <span className="text-xs font-semibold text-[#1FC5A8]">Deployed successfully</span>
      </div>
      <div className="px-3 py-1.5 rounded-lg bg-[#FAF9F6] border border-[#ECEAE3]">
        <span className="text-[10px] font-mono text-[#553DE9]">https://my-app.vercel.app</span>
      </div>
    </div>
  );
}

export function HowItWorks() {
  return (
    <section className="w-full max-w-5xl mx-auto py-16">
      <h2 className="font-heading text-h2 text-[#36342E] text-center mb-3">
        How It Works
      </h2>
      <p className="text-sm text-[#6B6960] text-center mb-12 max-w-lg mx-auto">
        Three steps from idea to production. No manual coding required.
      </p>

      <div className="relative flex flex-col md:flex-row items-start justify-center gap-10 md:gap-8">
        {/* Connecting dotted line (desktop only) */}
        <div className="hidden md:block absolute top-7 left-1/2 -translate-x-1/2 w-[60%] h-px border-t-2 border-dashed border-[#ECEAE3] z-0" />

        <Step
          icon={MessageSquare}
          number={1}
          title="Describe Your Idea"
          description="Type a one-line description. Loki handles the rest."
          mockup={<InputMockup />}
          delay={0}
        />
        <Step
          icon={Hammer}
          number={2}
          title="Watch It Build"
          description="AI writes code, runs tests, and ensures quality."
          mockup={<ProgressMockup />}
          delay={150}
        />
        <Step
          icon={Rocket}
          number={3}
          title="Ship It"
          description="Deploy to Vercel, Netlify, or GitHub in one click."
          mockup={<SuccessMockup />}
          delay={300}
        />
      </div>
    </section>
  );
}
