import { useEffect, useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from './ui/Button';
import {
  X, Rocket, FileText, Clock, Star, BarChart3,
  FolderTree, Lightbulb, ChevronRight, Eye,
} from 'lucide-react';
import { api } from '../api/client';
import type { TemplateMetadata } from '../types/api';

// Category-specific gradients (solid colors for large preview)
const CATEGORY_GRADIENT_SOLID: Record<string, string> = {
  Website: 'from-violet-600 via-purple-500 to-indigo-600',
  API: 'from-teal-600 via-emerald-500 to-cyan-600',
  CLI: 'from-slate-600 via-gray-500 to-blue-600',
  Bot: 'from-orange-500 via-rose-500 to-pink-600',
  Data: 'from-blue-600 via-indigo-500 to-purple-600',
  Other: 'from-slate-500 via-gray-500 to-zinc-600',
};

const TECH_DESCRIPTIONS: Record<string, string> = {
  React: 'Component-based UI library',
  'Node.js': 'Server-side JavaScript runtime',
  Python: 'General-purpose programming language',
  TypeScript: 'Type-safe JavaScript superset',
  PostgreSQL: 'Advanced relational database',
  MongoDB: 'Document-oriented NoSQL database',
  Docker: 'Container platform',
  Redis: 'In-memory data store',
  Express: 'Minimal Node.js web framework',
  FastAPI: 'Modern async Python web framework',
  SQLite: 'Lightweight embedded database',
  Tailwind: 'Utility-first CSS framework',
  Discord: 'Discord API integration',
  Slack: 'Slack API integration',
  CLI: 'Command-line interface tooling',
  Playwright: 'End-to-end testing framework',
  Vite: 'Next-gen frontend build tool',
  Next: 'React framework with SSR/SSG',
  Prisma: 'Type-safe ORM for Node.js',
  Stripe: 'Payment processing platform',
};

const DIFFICULTY_INFO: Record<string, { label: string; color: string; bars: number; description: string }> = {
  beginner: { label: 'Beginner', color: 'text-green-500', bars: 1, description: 'Suitable for developers new to this stack. Simple setup and straightforward concepts.' },
  intermediate: { label: 'Intermediate', color: 'text-yellow-500', bars: 2, description: 'Assumes familiarity with the core technologies. Moderate complexity with several integrated features.' },
  advanced: { label: 'Advanced', color: 'text-red-400', bars: 3, description: 'Complex architecture with multiple services. Best for experienced developers comfortable with infrastructure.' },
};

// Mock file structures per category
const FILE_STRUCTURES: Record<string, string[]> = {
  Website: [
    'src/',
    '  app/',
    '    layout.tsx',
    '    page.tsx',
    '    globals.css',
    '  components/',
    '    Header.tsx',
    '    Footer.tsx',
    '  lib/',
    '    utils.ts',
    'public/',
    '  favicon.ico',
    'package.json',
    'tailwind.config.ts',
    'tsconfig.json',
  ],
  API: [
    'src/',
    '  routes/',
    '    index.ts',
    '    users.ts',
    '    auth.ts',
    '  middleware/',
    '    auth.ts',
    '    validation.ts',
    '  models/',
    '    user.ts',
    '  config/',
    '    database.ts',
    'tests/',
    '  api.test.ts',
    'package.json',
    'Dockerfile',
  ],
  CLI: [
    'src/',
    '  commands/',
    '    init.ts',
    '    run.ts',
    '    config.ts',
    '  utils/',
    '    logger.ts',
    '    parser.ts',
    '  index.ts',
    'bin/',
    '  cli.js',
    'tests/',
    '  cli.test.ts',
    'package.json',
    'tsconfig.json',
  ],
  Bot: [
    'src/',
    '  commands/',
    '    help.ts',
    '    moderate.ts',
    '    settings.ts',
    '  events/',
    '    ready.ts',
    '    messageCreate.ts',
    '  utils/',
    '    embed.ts',
    '    permissions.ts',
    '  index.ts',
    '.env.example',
    'package.json',
    'Dockerfile',
  ],
  Data: [
    'src/',
    '  pipelines/',
    '    extract.py',
    '    transform.py',
    '    load.py',
    '  models/',
    '    schema.py',
    '  utils/',
    '    database.py',
    '    logger.py',
    'tests/',
    '  test_pipeline.py',
    'config.yaml',
    'requirements.txt',
    'Dockerfile',
  ],
  Other: [
    'src/',
    '  main.ts',
    '  config.ts',
    '  utils/',
    '    helpers.ts',
    'tests/',
    '  main.test.ts',
    'package.json',
    'tsconfig.json',
    'README.md',
  ],
};

// Feature lists per category
const CATEGORY_FEATURES: Record<string, string[]> = {
  Website: [
    'Responsive layout with mobile-first design',
    'SEO-optimized pages with meta tags',
    'Modern component architecture',
    'Production build configuration',
    'Styling system with design tokens',
    'Type-safe development setup',
  ],
  API: [
    'RESTful endpoint structure',
    'Authentication and authorization middleware',
    'Database models and migrations',
    'Input validation and error handling',
    'API documentation generation',
    'Docker deployment configuration',
  ],
  CLI: [
    'Subcommand architecture with help text',
    'Configuration file management',
    'Colored terminal output',
    'Progress indicators and spinners',
    'Error handling with helpful messages',
    'Cross-platform compatibility',
  ],
  Bot: [
    'Slash command registration and handling',
    'Event-driven architecture',
    'Permissions and role checking',
    'Rich embed message formatting',
    'Configuration persistence',
    'Graceful shutdown handling',
  ],
  Data: [
    'Extract-Transform-Load pipeline',
    'Data validation and cleaning',
    'Database connection pooling',
    'Logging and monitoring',
    'Scheduled job execution',
    'Error recovery and retry logic',
  ],
  Other: [
    'Clean project structure',
    'Type-safe configuration',
    'Comprehensive test setup',
    'Build and deployment scripts',
    'Documentation templates',
    'Linting and formatting rules',
  ],
};

interface TemplatePreviewProps {
  template: TemplateMetadata;
  onClose: () => void;
}

export function TemplatePreview({ template, onClose }: TemplatePreviewProps) {
  const navigate = useNavigate();
  const [prdContent, setPrdContent] = useState<string | null>(null);
  const [showPrd, setShowPrd] = useState(false);

  useEffect(() => {
    api.getTemplateContent(template.filename)
      .then((res) => setPrdContent(res.content))
      .catch(() => setPrdContent(null));
  }, [template.filename]);

  const handleUse = useCallback(() => {
    sessionStorage.setItem('pl_template', template.filename);
    navigate('/');
    onClose();
  }, [template.filename, navigate, onClose]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Prevent body scroll when modal is open
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  const category = template.category || 'Other';
  const gradientSolid = CATEGORY_GRADIENT_SOLID[category] || CATEGORY_GRADIENT_SOLID.Other;
  const difficulty = DIFFICULTY_INFO[template.difficulty] || DIFFICULTY_INFO.intermediate;
  const fileTree = FILE_STRUCTURES[category] || FILE_STRUCTURES.Other;
  const features = CATEGORY_FEATURES[category] || CATEGORY_FEATURES.Other;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="relative bg-white rounded-xl shadow-2xl w-[95vw] max-w-[1100px] max-h-[90vh] overflow-hidden animate-in"
        style={{ animation: 'modal-enter 0.25s ease-out' }}
      >
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 z-10 p-2 rounded-lg bg-white/90 hover:bg-white text-[#6B6960] hover:text-[#36342E] shadow-sm"
          aria-label="Close preview"
        >
          <X size={18} />
        </button>

        <div className="flex flex-col lg:flex-row h-full max-h-[90vh]">
          {/* Left panel (60%) */}
          <div className="flex-1 lg:w-[60%] overflow-y-auto p-6 lg:p-8">
            {/* Title */}
            <div className="mb-6">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs font-semibold text-[#553DE9] bg-[#553DE9]/10 px-2 py-0.5 rounded">
                  {category}
                </span>
              </div>
              <h2 className="text-2xl font-bold text-[#36342E] mb-2">
                {template.name.replace(/\.md$/i, '').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
              </h2>
              <p className="text-[#6B6960] leading-relaxed">
                {template.description || 'A ready-to-use template to kickstart your project.'}
              </p>
            </div>

            {/* Features */}
            <div className="mb-6">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-[#36342E] mb-3">
                <Star size={15} className="text-[#553DE9]" />
                What You Get
              </h3>
              <ul className="space-y-2">
                {features.map((feature, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-[#6B6960]">
                    <ChevronRight size={14} className="text-[#553DE9] mt-0.5 flex-shrink-0" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* File structure */}
            <div className="mb-6">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-[#36342E] mb-3">
                <FolderTree size={15} className="text-[#553DE9]" />
                Project Structure
              </h3>
              <div className="bg-[#FAF9F6] rounded-lg border border-[#ECEAE3] p-4 font-mono text-xs text-[#6B6960] leading-relaxed">
                {fileTree.map((line, i) => (
                  <div key={i} className={line.startsWith('  ') ? 'ml-4' : ''}>
                    {line.includes('/') && !line.includes('.') ? (
                      <span className="text-[#553DE9]">{line}</span>
                    ) : line.includes('.') ? (
                      <span className="text-[#36342E]">{line}</span>
                    ) : (
                      line
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Customization hint */}
            <div className="bg-[#553DE9]/5 rounded-lg border border-[#553DE9]/10 p-4">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-[#553DE9] mb-2">
                <Lightbulb size={15} />
                How to Customize
              </h3>
              <p className="text-sm text-[#6B6960]">
                After selecting this template, describe your specific requirements in the prompt.
                For example: "Add user authentication with Google OAuth" or "Change the database to MongoDB".
                The AI will adapt the template to your needs.
              </p>
            </div>
          </div>

          {/* Right panel (40%) */}
          <div className="lg:w-[40%] bg-[#FAF9F6] border-t lg:border-t-0 lg:border-l border-[#ECEAE3] p-6 lg:p-8 overflow-y-auto flex flex-col">
            {/* Gradient preview */}
            <div className={`h-40 rounded-xl bg-gradient-to-br ${gradientSolid} relative overflow-hidden mb-6 shadow-lg`}>
              {/* Decorative pattern */}
              <svg className="absolute inset-0 w-full h-full opacity-10" viewBox="0 0 400 200">
                <circle cx="50" cy="50" r="30" fill="none" stroke="white" strokeWidth="2" />
                <circle cx="350" cy="150" r="45" fill="none" stroke="white" strokeWidth="2" />
                <circle cx="200" cy="30" r="15" fill="white" />
                <rect x="300" y="20" width="40" height="40" rx="8" fill="none" stroke="white" strokeWidth="2" transform="rotate(15 320 40)" />
                <line x1="50" y1="180" x2="150" y2="120" stroke="white" strokeWidth="1.5" />
                <circle cx="100" cy="140" r="8" fill="white" fillOpacity="0.5" />
                <circle cx="250" cy="100" r="20" fill="none" stroke="white" strokeWidth="1.5" strokeDasharray="4 4" />
              </svg>
              <div className="absolute bottom-3 left-4 right-4">
                <span className="text-white/90 text-xs font-semibold bg-white/20 backdrop-blur-sm px-3 py-1 rounded-full">
                  {category} Template
                </span>
              </div>
            </div>

            {/* Tech stack */}
            <div className="mb-6">
              <h4 className="text-xs font-semibold text-[#36342E] uppercase tracking-wider mb-3">Tech Stack</h4>
              <div className="space-y-2">
                {(template.tech_stack || []).map((tech) => (
                  <div key={tech} className="flex items-center justify-between bg-white rounded-lg border border-[#ECEAE3] px-3 py-2">
                    <span className="text-sm font-medium text-[#36342E]">{tech}</span>
                    <span className="text-xs text-[#6B6960]">{TECH_DESCRIPTIONS[tech] || 'Development tool'}</span>
                  </div>
                ))}
                {(!template.tech_stack || template.tech_stack.length === 0) && (
                  <p className="text-xs text-[#6B6960]">Tech stack details available after selection</p>
                )}
              </div>
            </div>

            {/* Build time */}
            <div className="flex items-center gap-3 bg-white rounded-lg border border-[#ECEAE3] px-4 py-3 mb-3">
              <Clock size={16} className="text-[#553DE9]" />
              <div>
                <div className="text-xs text-[#6B6960]">Estimated Build Time</div>
                <div className="text-sm font-semibold text-[#36342E]">{template.build_time || '5-10 min'}</div>
              </div>
            </div>

            {/* Difficulty */}
            <div className="bg-white rounded-lg border border-[#ECEAE3] px-4 py-3 mb-6">
              <div className="flex items-center gap-3 mb-2">
                <BarChart3 size={16} className={difficulty.color} />
                <div>
                  <div className="text-xs text-[#6B6960]">Difficulty</div>
                  <div className="flex items-center gap-2">
                    <span className={`text-sm font-semibold ${difficulty.color}`}>{difficulty.label}</span>
                    <div className="flex gap-0.5">
                      {[1, 2, 3].map(i => (
                        <div
                          key={i}
                          className={`w-2 h-4 rounded-sm ${
                            i <= difficulty.bars ? 'bg-current ' + difficulty.color : 'bg-[#ECEAE3]'
                          }`}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              </div>
              <p className="text-xs text-[#6B6960] leading-relaxed">{difficulty.description}</p>
            </div>

            {/* Action buttons */}
            <div className="mt-auto space-y-3">
              <Button
                variant="primary"
                size="lg"
                icon={Rocket}
                onClick={handleUse}
                className="w-full justify-center text-base"
              >
                Use This Template
              </Button>
              <Button
                variant="secondary"
                size="md"
                icon={showPrd ? Eye : FileText}
                onClick={() => setShowPrd(!showPrd)}
                className="w-full justify-center"
              >
                {showPrd ? 'Hide Spec' : 'View Spec'}
              </Button>
            </div>
          </div>
        </div>

        {/* PRD viewer overlay */}
        {showPrd && (
          <div className="absolute inset-0 bg-white z-20 overflow-y-auto">
            <div className="sticky top-0 bg-white border-b border-[#ECEAE3] px-6 py-4 flex items-center justify-between z-10">
              <h3 className="text-lg font-semibold text-[#36342E]">
                Template Spec: {template.name.replace(/\.md$/i, '').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
              </h3>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => setShowPrd(false)}>
                  Back to Preview
                </Button>
                <button
                  onClick={onClose}
                  className="p-2 rounded-lg hover:bg-[#F8F4F0] text-[#6B6960]"
                  aria-label="Close"
                >
                  <X size={18} />
                </button>
              </div>
            </div>
            <div className="p-6 lg:p-8 max-w-4xl mx-auto">
              {prdContent ? (
                <pre className="whitespace-pre-wrap text-sm text-[#36342E] font-mono leading-relaxed">
                  {prdContent}
                </pre>
              ) : (
                <div className="text-center py-12 text-[#6B6960]">
                  <FileText size={32} className="mx-auto mb-3 opacity-30" />
                  <p className="text-sm">Loading template content...</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <style>{`
        @keyframes modal-enter {
          from { opacity: 0; transform: scale(0.95) translateY(10px); }
          to { opacity: 1; transform: scale(1) translateY(0); }
        }
      `}</style>
    </div>
  );
}
