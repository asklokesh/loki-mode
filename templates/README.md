# Loki Mode - PRD Templates Gallery

Ready-to-use Product Requirement Documents for launching projects with Loki Mode. Each template is a complete PRD that can be passed directly to Loki Mode for autonomous execution.

## Usage

```bash
# Launch with any template
claude --dangerously-skip-permissions
# Then: "Loki Mode with PRD at templates/saas-starter.md"

# Or via CLI
./autonomy/run.sh templates/e-commerce.md

# Or scaffold a new project from a template
loki init my-project --template saas-starter
```

## Templates

### Simple

| Template | Description | Tech Stack | Est. Time |
|----------|-------------|------------|-----------|
| [simple-todo-app.md](simple-todo-app.md) | Minimal todo app for testing Loki Mode basics | React, Express, SQLite | 15-20 min |
| [static-landing-page.md](static-landing-page.md) | SaaS landing page with hero, features, pricing, FAQ | HTML, CSS, vanilla JS | 10-15 min |
| [api-only.md](api-only.md) | REST API for notes with full CRUD and tests | Express, in-memory, Vitest | 15-20 min |

### Standard

| Template | Description | Tech Stack | Est. Time |
|----------|-------------|------------|-----------|
| [rest-api.md](rest-api.md) | REST API with CRUD, pagination, filtering, Swagger docs (no auth) | Express, TypeScript, Prisma, SQLite | 25-35 min |
| [rest-api-auth.md](rest-api-auth.md) | REST API with JWT auth, registration, login, refresh, rate limiting | Express/FastAPI, PostgreSQL, JWT, bcrypt | 30-45 min |
| [cli-tool.md](cli-tool.md) | File organizer CLI with subcommands, config, watch mode, undo | Node.js, Commander.js, chalk, chokidar | 30-45 min |
| [discord-bot.md](discord-bot.md) | Moderation bot with slash commands, auto-mod, reaction roles | discord.js, SQLite, node-cron | 45-60 min |
| [chrome-extension.md](chrome-extension.md) | Tab manager extension with groups, sessions, search, memory monitor | Manifest V3, vanilla JS, Chrome APIs | 30-45 min |
| [blog-platform.md](blog-platform.md) | Blog with markdown CMS, categories, RSS feed, SEO | Next.js, CodeMirror, SQLite, TailwindCSS | 45-60 min |
| [full-stack-demo.md](full-stack-demo.md) | Bookmark manager with tags, search, and filtering | React, Express, SQLite, TailwindCSS | 30-60 min |
| [web-scraper.md](web-scraper.md) | Configurable scraper with pagination, robots.txt, multi-format export | Python, httpx, BeautifulSoup4, SQLite | 30-45 min |
| [data-pipeline.md](data-pipeline.md) | ETL pipeline with multi-source ingestion, transforms, monitoring | Python, Pydantic, SQLAlchemy, Click | 30-45 min |
| [dashboard.md](dashboard.md) | Real-time analytics dashboard with charts, tables, drag-and-drop layout | React, Recharts, TanStack Table, WebSocket | 45-60 min |
| [game.md](game.md) | Browser-based 2D game with enemy AI, scoring, levels, high scores | HTML5 Canvas, TypeScript, Web Audio API | 30-45 min |
| [slack-bot.md](slack-bot.md) | Slack bot with slash commands, events, interactive messages, scheduling | Node.js, Bolt SDK, SQLite | 30-45 min |
| [npm-library.md](npm-library.md) | npm package with TypeScript, dual ESM/CJS, tree shaking, auto docs | TypeScript, tsup, Vitest, typedoc | 30-45 min |
| [microservice.md](microservice.md) | Containerized service with health checks, logging, Prometheus metrics | Express, TypeScript, Docker, Prisma, pino | 30-45 min |

### Complex

| Template | Description | Tech Stack | Est. Time |
|----------|-------------|------------|-----------|
| [mobile-app.md](mobile-app.md) | Habit tracker with streaks, reminders, calendar, charts | React Native (Expo), Zustand, AsyncStorage | 45-60 min |
| [saas-starter.md](saas-starter.md) | SaaS app with auth, OAuth, Stripe billing, admin dashboard | Next.js, Prisma, PostgreSQL, Stripe, NextAuth | 60-90 min |
| [e-commerce.md](e-commerce.md) | Storefront with catalog, cart, Stripe checkout, order management | Next.js, Prisma, PostgreSQL, Stripe | 60-90 min |
| [ai-chatbot.md](ai-chatbot.md) | RAG chatbot with document upload, vector search, streaming responses | Next.js, OpenAI API, ChromaDB, Vercel AI SDK | 60-90 min |

## Template Structure

Every template follows a consistent structure:

- **Overview** - What the project is and why it exists
- **Target Users** - Who will use this
- **Features** - MVP feature list with acceptance criteria
- **Tech Stack** - Frameworks, libraries, and infrastructure
- **Project Structure** - Directory layout
- **Database Schema** - Data model (if applicable)
- **API Endpoints** - REST API surface (if applicable)
- **Requirements** - Non-functional requirements
- **Testing** - Test strategy and coverage expectations
- **Out of Scope** - Explicit boundaries to prevent scope creep
- **Acceptance Criteria** - Measurable conditions for each feature
- **Success Criteria** - How to know when it is done
- **Purpose Footer** - What aspect of Loki Mode this template exercises

## Choosing a Template

**First time using Loki Mode?** Start with `simple-todo-app.md` or `api-only.md`. These complete quickly and validate your setup.

**Testing full capabilities?** Use `full-stack-demo.md`. It exercises frontend, backend, database, and code review agents without taking too long.

**Building something real?** Pick the template closest to your goal and customize it. The complex templates (`saas-starter.md`, `e-commerce.md`, `ai-chatbot.md`) are production-grade starting points.

**Testing specific agent types:**
- Frontend agent: `static-landing-page.md`, `chrome-extension.md`, `dashboard.md`
- Backend agent: `api-only.md`, `rest-api.md`, `rest-api-auth.md`, `microservice.md`
- Full-stack agent: `full-stack-demo.md`, `blog-platform.md`
- DevOps/CLI agent: `cli-tool.md`, `data-pipeline.md`
- Bot agent: `discord-bot.md`, `slack-bot.md`
- Mobile agent: `mobile-app.md`
- AI/ML agent: `ai-chatbot.md`
- Game agent: `game.md`
- Library agent: `npm-library.md`

## Customizing Templates

Templates are starting points. Common modifications:

1. **Swap tech stack** - Replace React with Vue, Express with Fastify, SQLite with PostgreSQL
2. **Add/remove features** - Comment out features in the MVP list or add new ones
3. **Change scope** - Move items between "Features" and "Out of Scope"
4. **Adjust complexity** - Remove database schema for a simpler version, or add auth for a more complex one

## Contributing a Template

New templates should:
1. Follow the standard structure listed above
2. Be realistic (something a developer would actually want to build)
3. Include enough detail for autonomous execution (no ambiguity)
4. List explicit out-of-scope items to prevent unbounded work
5. Include a purpose footer explaining what it tests
6. Not use emojis anywhere in the document
