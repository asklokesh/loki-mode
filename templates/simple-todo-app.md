# PRD: Simple Todo App

## Overview
A minimal todo application for testing Loki Mode with a simple, well-defined scope. A single-page app called "Todos" with a React frontend, Express API, and SQLite persistence.

## Target Users
- Individual users who want a simple way to track tasks
- Developers testing Loki Mode's core generation pipeline

## Features

### MVP Features
1. **Add Todo** - Users can add a new todo item with a title
2. **View Todos** - Display list of all todos with completion status
3. **Complete Todo** - Mark a todo as done (toggle)
4. **Delete Todo** - Remove a todo from the list with confirmation

### User Flow
1. User opens app -> sees todo list (or empty state if none)
2. Types a title in the input field -> presses Enter or clicks Add
3. New todo appears at the top of the list, input clears
4. Clicks checkbox to toggle complete -> visual strikethrough
5. Clicks delete icon -> confirmation prompt -> todo removed
6. Refreshes page -> all state persists from database

## Tech Stack

### Frontend
- React 18 with TypeScript
- Vite for bundling
- TailwindCSS for styling

### Backend
- Node.js 18+
- Express.js
- SQLite via better-sqlite3
- zod for input validation

### Structure
```
/
├── frontend/
│   ├── src/
│   │   ├── App.tsx                  # Main app component
│   │   ├── components/
│   │   │   ├── TodoList.tsx         # List of todo items
│   │   │   ├── TodoItem.tsx         # Single todo with checkbox/delete
│   │   │   ├── AddTodo.tsx          # Input form for new todos
│   │   │   └── EmptyState.tsx       # Shown when no todos exist
│   │   ├── hooks/
│   │   │   └── useTodos.ts         # API fetch/mutate hook
│   │   ├── types/
│   │   │   └── index.ts            # Todo type definition
│   │   └── main.tsx
│   ├── package.json
│   └── vite.config.ts
├── backend/
│   ├── src/
│   │   ├── index.ts                # Express server setup
│   │   ├── routes/
│   │   │   └── todos.ts            # CRUD route handlers
│   │   └── db/
│   │       └── index.ts            # SQLite connection + init
│   ├── package.json
│   └── tsconfig.json
├── tests/
│   ├── todos.test.ts               # API endpoint tests
│   └── components/
│       └── TodoItem.test.tsx        # Component tests
└── README.md
```

## Database Schema

```sql
CREATE TABLE todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  completed INTEGER DEFAULT 0,       -- 0 = false, 1 = true
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## API Endpoints

### Todos
- `GET /api/todos` - List all todos (ordered by created_at DESC)
- `POST /api/todos` - Create todo (body: `{ title }`, returns created todo)
- `PATCH /api/todos/:id` - Toggle completion (body: `{ completed }`)
- `DELETE /api/todos/:id` - Delete todo (returns 204)

### Health
- `GET /health` - Returns `{ status: "ok" }`

## Acceptance Criteria

### Add Todo
- [ ] Input field for todo title
- [ ] Submit on Enter key or button click
- [ ] New todo appears in list
- [ ] Input clears after submit
- [ ] Empty title is rejected (frontend + backend validation)

### View Todos
- [ ] Shows all todos in a list
- [ ] Shows completion status (checkbox)
- [ ] Empty state message when no todos exist

### Complete Todo
- [ ] Checkbox toggles complete/incomplete
- [ ] Visual strikethrough for completed items
- [ ] Persists after page refresh

### Delete Todo
- [ ] Delete button on each todo
- [ ] Confirmation before delete
- [ ] Removes from list and database

## Requirements
- TypeScript throughout
- Input validation on both frontend and backend
- Proper HTTP status codes (201 for create, 204 for delete, 400 for validation errors)
- Loading states during API calls
- Responsive design (usable on mobile)

## Testing
- API tests: All 4 CRUD endpoints with valid and invalid input (Vitest + supertest)
- Component tests: TodoItem renders correctly, AddTodo form submission works
- Minimum 6 test cases covering happy path and error cases

## Out of Scope
- User authentication
- Due dates
- Categories/tags
- Mobile app
- Cloud deployment

## Success Criteria
- All 4 CRUD features functional end-to-end
- All tests pass
- No console errors
- Empty state displays correctly
- Data persists across page refresh
- Input validation rejects empty titles

---

**Purpose:** This PRD is intentionally simple to allow quick testing of Loki Mode's core functionality without waiting for complex builds or deployments. Expect ~15-25 minutes for full execution.
