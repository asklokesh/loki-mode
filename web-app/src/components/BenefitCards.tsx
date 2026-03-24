import { Layers, ShieldCheck, HardDrive, Code2 } from 'lucide-react';

interface BenefitCardProps {
  icon: React.ComponentType<{ size?: number; className?: string; strokeWidth?: number }>;
  title: string;
  description: string;
}

function BenefitCard({ icon: Icon, title, description }: BenefitCardProps) {
  return (
    <div className="rounded-xl border border-[#ECEAE3] bg-white p-5 hover:border-[#553DE9]/40 hover:shadow-lg transition-all group">
      <div className="w-10 h-10 rounded-xl bg-[#553DE9]/10 flex items-center justify-center mb-3 group-hover:bg-[#553DE9]/15 transition-colors">
        <Icon size={20} className="text-[#553DE9]" strokeWidth={1.5} />
      </div>
      <h3 className="text-sm font-bold text-[#36342E] mb-1.5">{title}</h3>
      <p className="text-xs text-[#6B6960] leading-relaxed">{description}</p>
    </div>
  );
}

const BENEFITS = [
  {
    icon: Layers,
    title: 'Multi-AI',
    description: 'Use Claude, GPT, Gemini. Pick the best for each task.',
  },
  {
    icon: ShieldCheck,
    title: 'Quality First',
    description: '10 quality gates. 3 blind reviewers. Zero sycophancy.',
  },
  {
    icon: HardDrive,
    title: 'Self-Hosted',
    description: 'Your code stays on your machine. Full privacy.',
  },
  {
    icon: Code2,
    title: 'Open Source',
    description: 'MIT-licensed. Fork it, extend it, own it.',
  },
];

export function BenefitCards() {
  return (
    <section className="w-full max-w-4xl mx-auto py-16">
      <h2 className="font-heading text-h2 text-[#36342E] text-center mb-3">
        Why developers choose Loki Mode
      </h2>
      <p className="text-sm text-[#6B6960] text-center mb-10 max-w-lg mx-auto">
        Built by developers, for developers. Every decision optimized for shipping faster.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {BENEFITS.map((benefit) => (
          <BenefitCard key={benefit.title} {...benefit} />
        ))}
      </div>
    </section>
  );
}
