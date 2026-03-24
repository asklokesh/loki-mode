# PRD: REST API Service (No Auth)

## Overview
A production-ready RESTful API backend with CRUD operations, pagination, filtering, input validation, and auto-generated documentation. This template focuses on API design fundamentals without authentication complexity. For JWT auth, see `rest-api-auth.md`.

## Target Users
- Backend developers building API-first applications
- Teams needing a structured API for frontend or mobile clients
- Developers learning REST API best practices

## Features

### MVP Features
1. **Resource CRUD** - Full create, read, update, delete operations with proper HTTP methods and status codes
2. **Pagination and Filtering** - Cursor-based pagination, field filtering, sorting, and search across resources
3. **Input Validation** - Request body and query parameter validation with detailed error messages
4. **API Documentation** - Auto-generated OpenAPI/Swagger documentation with interactive testing
5. **Error Handling** - Consistent error response format with appropriate HTTP status codes
6. **Structured Logging** - JSON-formatted request logs with correlation IDs
7. **CORS Configuration** - Configurable allowed origins, methods, and headers

### User Flow
1. Client sends request to a resource endpoint (e.g., GET /api/posts)
2. Server validates query params (pagination, filters, sort)
3. Server queries database with applied filters and pagination
4. Response returns data with pagination metadata (next cursor, total count)
5. Swagger UI available at /docs for interactive API exploration

## Tech Stack
- Runtime: Node.js 20+
- Framework: Express.js with TypeScript
- Database: SQLite (dev) / PostgreSQL (prod) via Prisma ORM
- Validation: zod
- Documentation: swagger-jsdoc + swagger-ui-express
- Testing: Vitest + supertest

## Project Structure
```
/
├── src/
│   ├── app.ts                  # Express app setup, middleware
│   ├── server.ts               # Entry point
│   ├── config/
│   │   └── index.ts            # Environment config with validation
│   ├── middleware/
│   │   ├── validate.ts         # Request validation middleware
│   │   ├── errorHandler.ts     # Global error handler
│   │   └── requestLogger.ts    # Structured logging middleware
│   ├── routes/
│   │   ├── posts.ts            # Post resource routes
│   │   └── health.ts           # Health check route
│   ├── controllers/
│   │   └── postController.ts   # Post business logic
│   ├── services/
│   │   └── postService.ts      # Data access layer
│   └── utils/
│       ├── pagination.ts       # Cursor-based pagination helpers
│       └── errors.ts           # Custom error classes
├── prisma/
│   ├── schema.prisma           # Database schema
│   └── seed.ts                 # Seed data
├── tests/
│   ├── posts.test.ts           # Post endpoint tests
│   ├── pagination.test.ts      # Pagination logic tests
│   └── validation.test.ts      # Validation tests
├── .env.example                # Environment variable template
├── package.json
└── README.md
```

## Environment Variables

### .env.example
```bash
# Server
PORT=3000
NODE_ENV=development

# Database (SQLite for dev, PostgreSQL for prod)
DATABASE_URL=file:./dev.db

# CORS
CORS_ORIGIN=http://localhost:5173
```

## Database Schema

```sql
CREATE TABLE posts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       VARCHAR(200) NOT NULL,
    body        TEXT NOT NULL,
    slug        VARCHAR(200) UNIQUE NOT NULL,
    status      VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
    tags        TEXT,  -- JSON array of strings
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_posts_status ON posts(status);
CREATE INDEX idx_posts_created_at ON posts(created_at);
```

## API Endpoints

### Posts

#### POST /api/posts
- Body: `{ title, body, tags?, status? }`
- Response: `201 { id, title, body, slug, status, tags, createdAt, updatedAt }`
- Error: `400` validation

#### GET /api/posts
- Query: `?cursor=&limit=20&status=published&search=keyword&sort=createdAt&order=desc`
- Response: `200 { data: [...], pagination: { nextCursor, hasMore, total } }`

#### GET /api/posts/:id
- Response: `200 { id, title, body, slug, status, tags, createdAt, updatedAt }`
- Error: `404` not found

#### PATCH /api/posts/:id
- Body: `{ title?, body?, tags?, status? }`
- Response: `200 { id, title, body, slug, status, tags, createdAt, updatedAt }`
- Error: `404` not found, `400` validation

#### DELETE /api/posts/:id
- Response: `204` no content
- Error: `404` not found

### Health

#### GET /health
- Response: `200 { status: "ok", timestamp, version }`

### Documentation

#### GET /docs
- Swagger UI with interactive API documentation

## Requirements
- TypeScript throughout
- All inputs validated with zod before processing
- Consistent error format: `{ error: { code, message, details? } }`
- No stack traces in production responses
- Proper HTTP status codes (200, 201, 204, 400, 404, 500)
- CORS configured via environment variable
- Request logging with correlation IDs
- Database migrations managed by Prisma

## Testing

### Unit Tests
- Pagination cursor encoding and decoding
- Input validation schemas
- Slug generation from titles
- Error formatting

### Integration Tests
- Full CRUD lifecycle for posts
- Pagination across multiple pages
- Filtering by status and search term
- Sorting in both directions
- Swagger endpoint serves valid OpenAPI spec

### Test Coverage
- Target: 85%+ line coverage
- All error paths tested
- All validation rules tested

## Out of Scope
- Authentication and authorization (see `rest-api-auth.md`)
- User accounts and sessions
- Rate limiting (see `rest-api-auth.md`)
- File uploads
- WebSocket connections
- Deployment configuration
- Frontend or UI

## Acceptance Criteria
- All CRUD endpoints return correct status codes and response shapes
- Pagination returns correct pages with proper cursor metadata
- Search and filtering narrow results accurately
- Swagger UI serves interactive documentation at /docs
- Invalid inputs return descriptive 400 errors
- All tests pass with 85%+ coverage

## Success Criteria
- API starts and responds to all documented endpoints
- Swagger docs match actual API behavior
- Seed data loads correctly for development
- All tests pass

---

**Purpose:** Tests Loki Mode's ability to build a clean REST API with proper HTTP semantics, pagination, validation, and documentation -- without auth complexity. Exercises backend agent and QA agent. Expect ~25-35 minutes for full execution.
