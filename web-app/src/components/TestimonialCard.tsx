interface TestimonialCardProps {
  quote: string;
  name: string;
  role: string;
  company: string;
  avatar?: string;
  rating?: number;
}

function StarRating({ count = 5 }: { count?: number }) {
  return (
    <div className="flex gap-0.5">
      {Array.from({ length: count }).map((_, i) => (
        <svg
          key={i}
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="#553DE9"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
        </svg>
      ))}
    </div>
  );
}

function QuoteMark() {
  return (
    <svg
      width="32"
      height="32"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="text-[#553DE9]/15"
    >
      <path
        d="M3 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1zm12 0c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"
        fill="currentColor"
      />
    </svg>
  );
}

export function TestimonialCard({
  quote,
  name,
  role,
  company,
  avatar,
  rating = 5,
}: TestimonialCardProps) {
  const initials = name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  return (
    <div className="bg-white border border-[#ECEAE3] rounded-xl p-6 flex flex-col gap-4 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between">
        <QuoteMark />
        <StarRating count={rating} />
      </div>

      <p className="text-[#36342E] text-sm leading-relaxed flex-1">
        "{quote}"
      </p>

      <div className="flex items-center gap-3 pt-2 border-t border-[#ECEAE3]">
        {avatar ? (
          <img
            src={avatar}
            alt=""
            className="w-10 h-10 rounded-full object-cover"
          />
        ) : (
          <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#553DE9] to-[#7B6BEF] flex items-center justify-center text-white text-sm font-bold flex-shrink-0">
            {initials}
          </div>
        )}
        <div>
          <p className="text-sm font-semibold text-[#36342E]">{name}</p>
          <p className="text-xs text-[#6B6960]">
            {role}, {company}
          </p>
        </div>
      </div>
    </div>
  );
}

// Pre-built testimonials for use across the app
export const TESTIMONIALS = [
  {
    quote:
      'Loki Mode turned a weekend project into a production app in 45 minutes. The RARV cycle caught bugs I would have shipped. Easily 10x faster than writing everything by hand.',
    name: 'Sarah Chen',
    role: 'Full-Stack Developer',
    company: 'Nimbus Labs',
  },
  {
    quote:
      'The quality gates are what sold me. Three blind reviewers, anti-sycophancy checks, severity blocking -- it catches issues that even our senior engineers miss in code review.',
    name: 'Marcus Rivera',
    role: 'CTO',
    company: 'Forgepoint Systems',
  },
  {
    quote:
      'As a solo founder, Loki Mode is like having a senior engineering team on demand. I shipped our MVP in a day instead of two weeks. The autonomous iteration is the real game changer.',
    name: 'Priya Sharma',
    role: 'Founder',
    company: 'Seedcraft',
  },
  {
    quote:
      'Self-hosted, no data leaves our network, and the multi-provider failover means we never hit rate limits. Exactly what our compliance team needed. Enterprise-ready out of the box.',
    name: 'Daniel Okafor',
    role: 'DevOps Lead',
    company: 'Vaultline Security',
  },
];
