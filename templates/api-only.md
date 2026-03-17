# PRD: REST API Service

## Overview
A simple REST API for managing notes. Tests Loki Mode's backend-only capabilities with proper validation, error handling, and test coverage.

## Target Users
- Developers who need a lightweight notes API for prototyping
- Teams evaluating backend code generation quality
- Frontend developers needing a mock API to build against

## Features

### MVP Features
1. **Create Note** - Add a new note with title and content
2. **List Notes** - Retrieve all notes
3. **Get Note** - Retrieve a single note by ID
4. **Update Note** - Edit an existing note's title or content
5. **Delete Note** - Remove a note
6. **Health Check** - Service health endpoint

### Data Model

```typescript
interface Note {
  id: string;
  title: string;
  content: string;
  createdAt: string;       // ISO 8601 timestamp
  updatedAt: string;       // ISO 8601 timestamp
}
```

## API Endpoints

### Notes Resource

#### GET /api/notes
- Returns list of all notes
- Response: `[{ id, title, content, createdAt, updatedAt }]`

#### GET /api/notes/:id
- Returns single note
- Response: `{ id, title, content, createdAt, updatedAt }`
- Error: 404 if not found

#### POST /api/notes
- Creates new note
- Body: `{ title, content }`
- Response: `{ id, title, content, createdAt, updatedAt }` (201)
- Error: 400 if validation fails (title required, content required)

#### PUT /api/notes/:id
- Updates existing note
- Body: `{ title?, content? }` (partial update)
- Response: `{ id, title, content, createdAt, updatedAt }`
- Error: 404 if not found

#### DELETE /api/notes/:id
- Deletes note
- Response: 204 No Content
- Error: 404 if not found

### Health Check

#### GET /health
- Returns `{ status: "ok", timestamp }`

## Tech Stack
- Runtime: Node.js 18+
- Framework: Express.js
- Language: TypeScript
- Database: In-memory (array) for simplicity
- Validation: zod
- Testing: Vitest + supertest

### Structure
```
/
├── src/
│   ├── index.ts                 # Express server setup, middleware
│   ├── routes/
│   │   ├── notes.ts             # Notes CRUD handlers
│   │   └── health.ts            # Health check endpoint
│   ├── middleware/
│   │   └── errorHandler.ts      # Global error handler
│   ├── schemas/
│   │   └── note.ts              # Zod validation schemas
│   └── types/
│       └── index.ts             # TypeScript type definitions
├── tests/
│   ├── notes.test.ts            # Notes endpoint tests
│   └── health.test.ts           # Health check test
├── package.json
├── tsconfig.json
└── README.md
```

## Requirements
- TypeScript throughout
- Input validation on all endpoints using zod
- Proper HTTP status codes (200, 201, 204, 400, 404)
- JSON error responses: `{ error: "message" }`
- Request logging (method, path, status code)
- CORS enabled for development

## Testing
- API tests: All endpoints with valid input, invalid input, and edge cases (Vitest + supertest)
- Minimum test cases:
  - `POST /api/notes` with valid data -> 201 + note object
  - `POST /api/notes` with missing title -> 400 + error
  - `POST /api/notes` with missing content -> 400 + error
  - `GET /api/notes` -> 200 + array
  - `GET /api/notes/:id` with valid id -> 200 + note
  - `GET /api/notes/:id` with invalid id -> 404
  - `PUT /api/notes/:id` with valid data -> 200 + updated note
  - `PUT /api/notes/:id` with invalid id -> 404
  - `DELETE /api/notes/:id` -> 204
  - `DELETE /api/notes/:id` with invalid id -> 404
  - `GET /health` -> 200 + status object

## Out of Scope
- Authentication
- Database persistence (file or SQL)
- Rate limiting
- API documentation (OpenAPI)
- Deployment

## Success Criteria
- All 6 endpoints return correct status codes and response bodies
- Validation rejects invalid input with descriptive error messages
- All tests pass
- Server starts without errors on `npm start`
- Health check returns valid response

---

**Purpose:** Tests backend agent capabilities, code review, and QA without frontend complexity. Expect ~15-20 minutes for full execution.
