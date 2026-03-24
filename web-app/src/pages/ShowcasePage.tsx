import { useNavigate } from 'react-router-dom';
import { Roadmap } from '../components/Roadmap';
import { ChangelogWidget } from '../components/ChangelogWidget';

interface ProjectCard {
  title: string;
  description: string;
  techStack: string[];
  buildTime: string;
  gradient: string;
  prompt: string;
}

const GALLERY: ProjectCard[] = [
  {
    title: 'SaaS Dashboard',
    description: 'Admin dashboard with user analytics, charts, and real-time data visualization.',
    techStack: ['React', 'Tailwind', 'Chart.js'],
    buildTime: '~25 min',
    gradient: 'from-[#553DE9] to-[#7B6BEF]',
    prompt: 'Build a SaaS admin dashboard with user analytics, charts showing MRR and churn, and a table of recent signups',
  },
  {
    title: 'REST API Server',
    description: 'Production-ready API with authentication, validation, and database integration.',
    techStack: ['Node.js', 'Express', 'PostgreSQL'],
    buildTime: '~20 min',
    gradient: 'from-[#1FC5A8] to-[#38D9A9]',
    prompt: 'Build a REST API server with JWT authentication, user CRUD, input validation, and PostgreSQL database',
  },
  {
    title: 'E-commerce Store',
    description: 'Online store with product catalog, cart, checkout, and payment integration.',
    techStack: ['Next.js', 'Stripe', 'Prisma'],
    buildTime: '~45 min',
    gradient: 'from-[#E93D82] to-[#F06595]',
    prompt: 'Build an e-commerce store with product listings, shopping cart, Stripe checkout, and order management',
  },
  {
    title: 'Portfolio Website',
    description: 'Personal portfolio with animations, project showcase, and contact form.',
    techStack: ['React', 'Framer Motion', 'Tailwind'],
    buildTime: '~15 min',
    gradient: 'from-[#F59F00] to-[#FCC419]',
    prompt: 'Build a developer portfolio website with animated sections, project gallery, skills list, and contact form',
  },
  {
    title: 'CLI Tool',
    description: 'Command-line tool with subcommands, flags, configuration, and colorful output.',
    techStack: ['Node.js', 'Commander', 'Chalk'],
    buildTime: '~15 min',
    gradient: 'from-[#36342E] to-[#6B6960]',
    prompt: 'Build a CLI tool with subcommands for file management: list, copy, move, and search with glob patterns',
  },
  {
    title: 'Discord Bot',
    description: 'Interactive bot with slash commands, moderation, and custom responses.',
    techStack: ['Discord.js', 'Node.js', 'SQLite'],
    buildTime: '~20 min',
    gradient: 'from-[#5865F2] to-[#7289DA]',
    prompt: 'Build a Discord bot with slash commands for polls, reminders, moderation (kick/ban), and a leveling system',
  },
  {
    title: 'Blog Platform',
    description: 'Full-featured blog with markdown support, categories, and RSS feed.',
    techStack: ['React', 'MDX', 'Tailwind'],
    buildTime: '~30 min',
    gradient: 'from-[#845EF7] to-[#B197FC]',
    prompt: 'Build a blog platform with MDX support, category filtering, search, RSS feed, and a clean reading experience',
  },
  {
    title: 'Task Manager',
    description: 'Kanban-style task board with drag-and-drop, labels, and persistence.',
    techStack: ['React', 'DnD Kit', 'SQLite'],
    buildTime: '~25 min',
    gradient: 'from-[#2F71E3] to-[#5C93E8]',
    prompt: 'Build a task manager with kanban board, drag-and-drop cards, labels, due dates, and local SQLite storage',
  },
  {
    title: 'Weather App',
    description: 'Weather dashboard with location search, forecasts, and beautiful visualizations.',
    techStack: ['React', 'OpenWeatherMap', 'Chart.js'],
    buildTime: '~15 min',
    gradient: 'from-[#0EA5E9] to-[#38BDF8]',
    prompt: 'Build a weather app with city search, 5-day forecast, current conditions, and temperature charts',
  },
  {
    title: 'Chat Application',
    description: 'Real-time chat with rooms, typing indicators, and message history.',
    techStack: ['React', 'WebSocket', 'Node.js'],
    buildTime: '~30 min',
    gradient: 'from-[#22C55E] to-[#4ADE80]',
    prompt: 'Build a real-time chat application with chat rooms, user presence, typing indicators, and message history',
  },
  {
    title: 'Landing Page',
    description: 'Conversion-optimized landing page with hero, features, pricing, and CTA sections.',
    techStack: ['HTML', 'Tailwind', 'Alpine.js'],
    buildTime: '~10 min',
    gradient: 'from-[#F97316] to-[#FB923C]',
    prompt: 'Build a SaaS landing page with hero section, feature grid, pricing table, testimonials, and email signup',
  },
  {
    title: 'Mobile App',
    description: 'Cross-platform mobile app with navigation, state management, and native features.',
    techStack: ['React Native', 'Expo', 'TypeScript'],
    buildTime: '~35 min',
    gradient: 'from-[#DC2626] to-[#F87171]',
    prompt: 'Build a React Native mobile app with tab navigation, a home feed, profile page, and push notifications setup',
  },
];

function TechBadge({ name }: { name: string }) {
  return (
    <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-[#F8F4F0] text-[#6B6960] border border-[#ECEAE3]">
      {name}
    </span>
  );
}

export default function ShowcasePage() {
  const navigate = useNavigate();

  const handleBuildThis = (prompt: string) => {
    // Store the prompt so HomePage can pick it up
    sessionStorage.setItem('pl_showcase_prompt', prompt);
    navigate('/');
  };

  return (
    <div className="min-h-screen bg-[#FAF9F6]">
      <div className="max-w-6xl mx-auto px-6 py-8">
        {/* Page header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-[#36342E]">Showcase</h1>
          <p className="text-[#6B6960] mt-1">
            Explore example projects you can build with Loki Mode. Click "Build This" to start any project instantly.
          </p>
        </div>

        {/* Project gallery grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {GALLERY.map((project) => (
            <div
              key={project.title}
              className="bg-white border border-[#ECEAE3] rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-shadow flex flex-col"
            >
              {/* Gradient header */}
              <div className={`h-28 bg-gradient-to-br ${project.gradient} flex items-end p-4`}>
                <h3 className="text-lg font-bold text-white drop-shadow-sm">{project.title}</h3>
              </div>

              {/* Content */}
              <div className="p-4 flex-1 flex flex-col">
                <p className="text-sm text-[#6B6960] mb-3">{project.description}</p>

                {/* Tech stack badges */}
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {project.techStack.map((tech) => (
                    <TechBadge key={tech} name={tech} />
                  ))}
                </div>

                <div className="mt-auto pt-3 border-t border-[#ECEAE3] flex items-center justify-between">
                  <span className="text-xs text-[#939084]">Est. {project.buildTime}</span>
                  <button
                    onClick={() => handleBuildThis(project.prompt)}
                    className="px-4 py-1.5 text-sm font-semibold rounded-lg bg-[#553DE9] text-white hover:bg-[#4832c7] transition-colors"
                  >
                    Build This
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Roadmap section */}
        <div className="mt-12">
          <Roadmap />
        </div>

        {/* Changelog widget */}
        <div className="mt-8 max-w-md">
          <ChangelogWidget />
        </div>
      </div>
    </div>
  );
}
