import { useState, useEffect, useMemo } from 'react';
import {
  X,
  Search,
  BookOpen,
  Rocket,
  LayoutTemplate,
  Cpu,
  Keyboard,
  HelpCircle,
  ChevronRight,
  ArrowLeft,
  Play,
  Video,
  GitBranch,
  MessageSquare,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DocSection {
  id: string;
  title: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  content: string;
}

interface VideoCard {
  title: string;
  description: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  gradient: string;
  url: string;
}

// ---------------------------------------------------------------------------
// Documentation content
// ---------------------------------------------------------------------------

const DOCS: DocSection[] = [
  {
    id: 'quick-start',
    title: 'Quick Start',
    icon: Rocket,
    content: `# Quick Start

**1. Create a project**
Click "New Project" on the home page, or type a description in the input box and press Enter.

**2. Choose a mode**
- **Quick** -- single-task fix, 3 iterations max
- **Standard** -- thorough implementation with testing
- **Max** -- full autonomous build from scratch

**3. Watch the build**
The progress bar shows each phase: Plan, Build, Test, Review. You will see real-time streaming output in the chat panel.

**4. Preview and iterate**
Switch to the Preview tab to see your running app. Use the AI chat to request changes, fixes, or new features.

**5. Deploy**
Head to the Deploy tab when you are satisfied. Purple Lab supports Vercel, Netlify, Railway, and more.

> Tip: Press \`Cmd+K\` (or \`Ctrl+K\`) to open the Command Palette for quick navigation.`,
  },
  {
    id: 'templates',
    title: 'Templates',
    icon: LayoutTemplate,
    content: `# Templates

Purple Lab includes ready-made templates to help you start fast:

- **SaaS App** -- Full-stack application with auth, dashboard, and billing
- **Landing Page** -- Marketing page with hero, features, pricing sections
- **API Server** -- REST/GraphQL backend with database integration
- **CLI Tool** -- Command-line application with argument parsing
- **Discord Bot** -- Discord bot with slash commands and event handling
- **Chrome Extension** -- Browser extension with popup and content scripts
- **Mobile App** -- React Native app with navigation and screens
- **Dashboard** -- Data visualization with charts and metrics

Browse templates from the sidebar or the home page. Each template includes a pre-written spec that you can customize before building.`,
  },
  {
    id: 'providers',
    title: 'AI Providers',
    icon: Cpu,
    content: `# AI Providers

Purple Lab supports multiple AI providers for building your projects:

**Claude (Recommended)**
Full-featured provider with parallel execution, sub-agents, and the Task tool. Best for complex, multi-file projects.

**Codex**
OpenAI's code-specialized model. Runs in degraded mode (sequential only, no Task tool). Good for focused coding tasks.

**Gemini**
Google's model. Runs in degraded mode (sequential only). Suitable for general-purpose development.

You can select a provider from the settings or specify it per-build in the project configuration.`,
  },
  {
    id: 'shortcuts',
    title: 'Keyboard Shortcuts',
    icon: Keyboard,
    content: `# Keyboard Shortcuts

**Navigation**
- \`Cmd+K\` -- Open Command Palette
- \`Cmd+P\` -- Quick open file
- \`?\` -- Show keyboard shortcuts overlay

**Editor**
- \`Cmd+S\` -- Save current file
- \`Cmd+Z\` -- Undo
- \`Cmd+Shift+Z\` -- Redo

**Build**
- \`Cmd+B\` -- Start or stop build
- \`Cmd+\\\`\` -- Toggle terminal

**General**
- \`Escape\` -- Close any modal or overlay
- \`Cmd+,\` -- Open settings`,
  },
  {
    id: 'faq',
    title: 'FAQ',
    icon: HelpCircle,
    content: `# Frequently Asked Questions

**How does Purple Lab build my project?**
Purple Lab uses the RARV cycle (Reason, Act, Reflect, Verify). The AI plans the architecture, writes code, reflects on quality, and verifies with tests -- all automatically.

**Can I edit code manually?**
Yes. The code editor supports full editing. Your changes are preserved across builds. Use the AI chat to ask for modifications too.

**What languages are supported?**
Purple Lab can build projects in JavaScript, TypeScript, Python, Go, Rust, Ruby, and more. The AI adapts to whatever stack your project needs.

**How do I deploy?**
Use the Deploy tab. Purple Lab can deploy to Vercel, Netlify, Railway, or generate a Docker container. You will need to connect your deployment account in Settings.

**Is my code private?**
Your code stays in your project workspace. In local mode, everything runs on your machine. In hosted mode, projects are isolated per user.

**What are Quality Gates?**
Automated checks that run after each build phase. They verify code quality, test coverage, and security before moving to the next phase. This ensures your code meets production standards.

**What is the RARV cycle?**
Reason, Act, Reflect, Verify -- the AI's thinking process. It plans what to do (Reason), writes code (Act), reviews its own work (Reflect), and runs tests (Verify).`,
  },
];

// ---------------------------------------------------------------------------
// Video tutorial placeholder cards (H86)
// ---------------------------------------------------------------------------

const VIDEO_TUTORIALS: VideoCard[] = [
  {
    title: 'Your First Build',
    description: 'Learn how to create a project from scratch and watch the AI build it step by step.',
    icon: Rocket,
    gradient: 'from-primary/20 to-primary/5',
    url: '#',
  },
  {
    title: 'Using AI Chat',
    description: 'Discover how to iterate on your project by chatting with the AI assistant.',
    icon: MessageSquare,
    gradient: 'from-blue-500/20 to-blue-500/5',
    url: '#',
  },
  {
    title: 'Deploying Your App',
    description: 'Take your project from preview to production with one-click deployment.',
    icon: Play,
    gradient: 'from-green-500/20 to-green-500/5',
    url: '#',
  },
  {
    title: 'Git Integration',
    description: 'Connect your repository, manage branches, and push changes directly from Purple Lab.',
    icon: GitBranch,
    gradient: 'from-orange-500/20 to-orange-500/5',
    url: '#',
  },
];

// ---------------------------------------------------------------------------
// Simple markdown renderer
// ---------------------------------------------------------------------------

function renderMarkdown(md: string): React.ReactNode[] {
  const lines = md.split('\n');
  const nodes: React.ReactNode[] = [];
  let listItems: string[] = [];

  const flushList = () => {
    if (listItems.length > 0) {
      nodes.push(
        <ul key={`ul-${nodes.length}`} className="list-disc list-inside space-y-1 text-xs text-ink leading-relaxed">
          {listItems.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </ul>,
      );
      listItems = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Headers
    if (line.startsWith('# ')) {
      flushList();
      nodes.push(
        <h2 key={i} className="text-lg font-heading font-bold text-ink mt-2 mb-2">
          {line.slice(2)}
        </h2>,
      );
      continue;
    }
    if (line.startsWith('## ')) {
      flushList();
      nodes.push(
        <h3 key={i} className="text-sm font-heading font-bold text-ink mt-4 mb-1">
          {line.slice(3)}
        </h3>,
      );
      continue;
    }

    // Block quote
    if (line.startsWith('> ')) {
      flushList();
      nodes.push(
        <blockquote
          key={i}
          className="border-l-2 border-primary/30 pl-3 text-xs text-muted-accessible italic my-2"
        >
          {renderInline(line.slice(2))}
        </blockquote>,
      );
      continue;
    }

    // List items
    if (line.startsWith('- ')) {
      listItems.push(line.slice(2));
      continue;
    }

    // Empty line
    if (!line.trim()) {
      flushList();
      continue;
    }

    // Paragraph
    flushList();
    nodes.push(
      <p key={i} className="text-xs text-ink leading-relaxed my-1">
        {renderInline(line)}
      </p>,
    );
  }
  flushList();
  return nodes;
}

function renderInline(text: string): React.ReactNode {
  // Bold, code, and plain text
  const parts: React.ReactNode[] = [];
  const re = /(\*\*(.+?)\*\*)|(`(.+?)`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    if (match[2]) {
      parts.push(
        <strong key={match.index} className="font-semibold text-ink">
          {match[2]}
        </strong>,
      );
    } else if (match[4]) {
      parts.push(
        <code
          key={match.index}
          className="px-1.5 py-0.5 text-[11px] font-mono bg-hover border border-border rounded text-primary"
        >
          {match[4]}
        </code>,
      );
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts.length === 1 ? parts[0] : <>{parts}</>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface DocsSidebarProps {
  open: boolean;
  onClose: () => void;
}

export function DocsSidebar({ open, onClose }: DocsSidebarProps) {
  const [search, setSearch] = useState('');
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const [showVideos, setShowVideos] = useState(false);

  // Reset state when opened
  useEffect(() => {
    if (open) {
      setSearch('');
      setActiveSection(null);
      setShowVideos(false);
    }
  }, [open]);

  // Escape to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const filteredDocs = useMemo(() => {
    if (!search.trim()) return DOCS;
    const q = search.toLowerCase();
    return DOCS.filter(
      (d) =>
        d.title.toLowerCase().includes(q) ||
        d.content.toLowerCase().includes(q),
    );
  }, [search]);

  const activeDoc = activeSection
    ? DOCS.find((d) => d.id === activeSection)
    : null;

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-ink/10"
        onClick={onClose}
      />

      {/* Panel */}
      <div
        className="fixed top-0 right-0 bottom-0 z-50 w-full max-w-md bg-card border-l border-border shadow-2xl flex flex-col animate-slide-in-right"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 h-14 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2">
            {activeDoc || showVideos ? (
              <button
                onClick={() => {
                  setActiveSection(null);
                  setShowVideos(false);
                }}
                className="text-muted hover:text-ink transition-colors p-1 rounded-btn hover:bg-hover"
              >
                <ArrowLeft size={16} />
              </button>
            ) : (
              <BookOpen size={16} className="text-primary" />
            )}
            <h2 className="text-sm font-heading font-bold text-ink">
              {activeDoc
                ? activeDoc.title
                : showVideos
                  ? 'Video Tutorials'
                  : 'Documentation'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-muted hover:text-ink transition-colors p-1 rounded-btn hover:bg-hover"
          >
            <X size={16} />
          </button>
        </div>

        {/* Search (only in index view) */}
        {!activeDoc && !showVideos && (
          <div className="px-4 py-3 border-b border-border flex-shrink-0">
            <div className="relative">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted"
              />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search documentation..."
                className="w-full pl-9 pr-3 py-2 text-xs bg-card border border-border rounded-btn outline-none focus:border-primary transition-colors"
                autoFocus
              />
            </div>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto terminal-scroll">
          {activeDoc ? (
            // Single doc view
            <div className="px-5 py-4">{renderMarkdown(activeDoc.content)}</div>
          ) : showVideos ? (
            // Video tutorials view
            <div className="px-4 py-4 space-y-3">
              {VIDEO_TUTORIALS.map((video) => {
                const Icon = video.icon;
                return (
                  <a
                    key={video.title}
                    href={video.url}
                    className="block rounded-xl overflow-hidden border border-border hover:border-primary/30 transition-colors group"
                  >
                    {/* Thumbnail placeholder */}
                    <div
                      className={`relative h-32 bg-gradient-to-br ${video.gradient} flex items-center justify-center`}
                    >
                      <Icon size={32} className="text-ink/20" />
                      <div className="absolute inset-0 flex items-center justify-center">
                        <div className="w-12 h-12 rounded-full bg-white/90 dark:bg-card/90 flex items-center justify-center shadow-lg group-hover:scale-110 transition-transform">
                          <Play
                            size={20}
                            className="text-primary ml-0.5"
                          />
                        </div>
                      </div>
                    </div>
                    <div className="px-4 py-3">
                      <h4 className="text-sm font-medium text-ink">
                        {video.title}
                      </h4>
                      <p className="text-xs text-muted-accessible mt-0.5 leading-relaxed">
                        {video.description}
                      </p>
                    </div>
                  </a>
                );
              })}
              <p className="text-center text-[11px] text-muted pt-2">
                Video content coming soon. Stay tuned!
              </p>
            </div>
          ) : (
            // Index view
            <div className="px-3 py-3 space-y-1">
              {filteredDocs.map((doc) => {
                const Icon = doc.icon;
                return (
                  <button
                    key={doc.id}
                    onClick={() => setActiveSection(doc.id)}
                    className="w-full flex items-center gap-3 px-3 py-3 rounded-lg text-left hover:bg-hover transition-colors group"
                  >
                    <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                      <Icon size={16} className="text-primary" />
                    </div>
                    <span className="flex-1 text-sm text-ink font-medium">
                      {doc.title}
                    </span>
                    <ChevronRight
                      size={14}
                      className="text-muted group-hover:text-ink transition-colors"
                    />
                  </button>
                );
              })}

              {/* Video tutorials card */}
              <button
                onClick={() => setShowVideos(true)}
                className="w-full flex items-center gap-3 px-3 py-3 rounded-lg text-left hover:bg-hover transition-colors group mt-2 border-t border-border pt-4"
              >
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                  <Video size={16} className="text-primary" />
                </div>
                <span className="flex-1 text-sm text-ink font-medium">
                  Video Tutorials
                </span>
                <ChevronRight
                  size={14}
                  className="text-muted group-hover:text-ink transition-colors"
                />
              </button>

              {filteredDocs.length === 0 && (
                <div className="py-8 text-center">
                  <p className="text-xs text-muted">
                    No docs matching "{search}"
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
