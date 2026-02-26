---
stepsCompleted: [init, context, decisions, patterns, structure, validation, complete]
inputDocuments: [prd-taskflow.md]
workflowType: 'architecture'
project_name: 'TaskFlow'
date: '2026-02-21'
---

# TaskFlow -- Architecture Document

## Project Context Analysis

### Requirements Overview
Task management web application for small engineering teams. Real-time collaborative
board with AI-powered features. MVP scope: task CRUD, real-time updates, team management,
OAuth authentication.

### Technical Constraints & Dependencies
- Must support real-time updates (WebSocket requirement from FR9)
- AI features require LLM API access (OpenAI or similar)
- OAuth providers: Google and GitHub SSO
- Target: 10,000 concurrent users at launch

### Cross-Cutting Concerns
- Authentication flows through every API endpoint
- Real-time subscription management across all board operations
- Rate limiting applied globally

## Core Architectural Decisions

### Data Architecture
- **Database:** PostgreSQL 16 with row-level security policies
- **Caching:** Redis for session management and real-time pub/sub
- **Schema:** Multi-tenant with team_id foreign key on all tables

### Authentication & Security
- OAuth 2.0 via Google and GitHub (NextAuth.js)
- JWT tokens with 15-minute expiry, refresh token rotation
- Row-level security policies in PostgreSQL

### API & Communication Patterns
- REST API for CRUD operations (Next.js API routes)
- WebSocket via Socket.io for real-time board updates
- Server-Sent Events fallback for environments blocking WebSocket

### Frontend Architecture
- Next.js 14 with App Router
- React Server Components for initial board load
- Client-side state: Zustand for local UI state
- Real-time: Socket.io client with optimistic updates
- Drag-and-drop: @dnd-kit/core

### Infrastructure & Deployment
- Vercel for frontend and API (serverless functions)
- Supabase for PostgreSQL + real-time subscriptions
- Redis Cloud for caching
- Docker Compose for local development

## Implementation Patterns

### Code Conventions
- TypeScript strict mode throughout
- Server components by default, client components only when needed
- API routes follow REST conventions: /api/teams/:id/tasks/:id
- Error responses use RFC 7807 Problem Details format

### Testing Strategy
- Unit: Vitest for business logic
- Integration: Supertest for API routes
- E2E: Playwright for critical user journeys
- Coverage target: 80% unit, 100% critical paths

## Project Structure

```
taskflow/
  src/
    app/                    # Next.js App Router pages
      (auth)/               # Authentication pages
      (dashboard)/          # Main board views
      api/                  # API routes
    components/             # React components
      board/                # Board-specific components
      ui/                   # Shared UI primitives
    lib/                    # Shared utilities
      db/                   # Database client and queries
      auth/                 # Authentication helpers
      ai/                   # AI feature modules
      realtime/             # WebSocket/SSE management
    types/                  # TypeScript type definitions
  tests/                    # Test files mirroring src/
  prisma/                   # Database schema and migrations
  public/                   # Static assets
```

## Architecture Validation

All 15 Functional Requirements are addressable by this architecture:
- FR1-FR6 (Task Management): REST API + PostgreSQL
- FR7-FR10 (Collaboration): OAuth + WebSocket + PostgreSQL RLS
- FR11-FR13 (AI): OpenAI API + background job processing
- FR14-FR15 (Search): PostgreSQL full-text search + API filters
