import { useNavigate } from 'react-router-dom';

interface FooterLink {
  label: string;
  href?: string;
  to?: string;
}

interface FooterColumn {
  title: string;
  links: FooterLink[];
}

const COLUMNS: FooterColumn[] = [
  {
    title: 'Product',
    links: [
      { label: 'Features', to: '/' },
      { label: 'Templates', to: '/templates' },
      { label: 'Pricing', href: 'https://www.autonomi.dev/#pricing' },
      { label: 'Docs', href: 'https://github.com/asklokesh/loki-mode/wiki' },
    ],
  },
  {
    title: 'Developers',
    links: [
      { label: 'Quick Start', to: '/' },
      { label: 'API Reference', href: 'https://github.com/asklokesh/loki-mode/wiki/API-Reference' },
      { label: 'CLI Docs', href: 'https://github.com/asklokesh/loki-mode/wiki/CLI-Reference' },
      { label: 'Changelog', href: 'https://github.com/asklokesh/loki-mode/blob/main/CHANGELOG.md' },
    ],
  },
  {
    title: 'Company',
    links: [
      { label: 'About Autonomi', href: 'https://www.autonomi.dev/' },
      { label: 'Blog', href: 'https://www.autonomi.dev/blog' },
      { label: 'Careers', href: 'https://www.autonomi.dev/careers' },
      { label: 'Contact', href: 'mailto:hello@autonomi.dev' },
    ],
  },
  {
    title: 'Community',
    links: [
      { label: 'GitHub', href: 'https://github.com/asklokesh/loki-mode' },
      { label: 'Discord', href: 'https://discord.gg/autonomi' },
      { label: 'Twitter', href: 'https://twitter.com/autonomidev' },
      { label: 'Forum', href: 'https://github.com/asklokesh/loki-mode/discussions' },
    ],
  },
];

export function Footer() {
  const navigate = useNavigate();

  const handleClick = (link: FooterLink, e: React.MouseEvent) => {
    if (link.to) {
      e.preventDefault();
      navigate(link.to);
    }
  };

  return (
    <footer className="w-full bg-[#F0EDE8] border-t border-[#ECEAE3] mt-8">
      <div className="max-w-5xl mx-auto px-6 py-12">
        {/* Column layout */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-10">
          {COLUMNS.map((column) => (
            <div key={column.title}>
              <h4 className="text-xs font-bold text-[#36342E] uppercase tracking-wider mb-4">
                {column.title}
              </h4>
              <ul className="space-y-2.5">
                {column.links.map((link) => (
                  <li key={link.label}>
                    <a
                      href={link.href || link.to || '#'}
                      onClick={(e) => handleClick(link, e)}
                      className="text-sm text-[#6B6960] hover:text-[#553DE9] transition-colors"
                      {...(link.href ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Bottom row */}
        <div className="border-t border-[#ECEAE3] pt-6 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-3 text-xs text-[#6B6960]">
            <span>Built with care by Autonomi</span>
            <span className="hidden sm:inline text-[#ECEAE3]">|</span>
            <span className="px-2 py-0.5 rounded bg-[#553DE9]/10 text-[#553DE9] font-semibold text-[10px]">
              v6.73.0
            </span>
          </div>
          <div className="flex items-center gap-4 text-xs text-[#6B6960]">
            <a href="https://www.autonomi.dev/privacy" target="_blank" rel="noopener noreferrer" className="hover:text-[#553DE9] transition-colors">
              Privacy
            </a>
            <a href="https://www.autonomi.dev/terms" target="_blank" rel="noopener noreferrer" className="hover:text-[#553DE9] transition-colors">
              Terms
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
