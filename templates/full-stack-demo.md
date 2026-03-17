# PRD: Full-Stack Demo App

## Overview
A complete full-stack application demonstrating Loki Mode's end-to-end capabilities. A bookmark manager called "Stash" with tags, search, and a clean UI.

## Target Users
- Users who want to save and organize bookmarks with tags
- Developers testing Loki Mode's full-stack generation pipeline

## Features

### Core Features
1. **Add Bookmark** - Save URL with title and optional tags
   - Acceptance: Form validates URL format, title is required, tags are comma-separated, form clears on submit
2. **View Bookmarks** - List all bookmarks with search and tag filter
   - Acceptance: Shows URL, title, tags, and creation date; search filters by title with 300ms debounce; tag chips are clickable for filtering
3. **Edit Bookmark** - Update title, URL, or tags
   - Acceptance: Inline edit or modal form, pre-populated with current values, saves on submit
4. **Delete Bookmark** - Remove bookmark with confirmation
   - Acceptance: Confirmation dialog before delete, bookmark removed from list and database
5. **Tag Management** - Create, view, and filter by tags
   - Acceptance: Tag sidebar shows all tags with bookmark counts, clicking a tag filters the list, unused tags cleaned up on bookmark delete

### User Flow
1. User opens app -> sees bookmark list (or empty state if none)
2. Clicks "Add Bookmark" -> form appears
3. Enters URL, title, tags -> submits
4. Bookmark appears in list with tag chips
5. Can filter by tag (click tag) or search by title (search bar)
6. Can edit or delete any bookmark
7. Refreshes page -> all state persists from database

## Tech Stack

### Frontend
- React 18 with TypeScript
- Vite for bundling
- TailwindCSS for styling
- React Query for data fetching

### Backend
- Node.js 18+
- Express.js
- SQLite with better-sqlite3
- zod for validation

### Structure
```
/
├── frontend/
│   ├── src/
│   │   ├── App.tsx                      # Main app with layout
│   │   ├── components/
│   │   │   ├── BookmarkList.tsx         # List of bookmark cards
│   │   │   ├── BookmarkCard.tsx         # Single bookmark display
│   │   │   ├── BookmarkForm.tsx         # Add/edit form
│   │   │   ├── SearchBar.tsx            # Search input with debounce
│   │   │   ├── TagSidebar.tsx           # Tag list with counts
│   │   │   ├── TagChip.tsx              # Clickable tag badge
│   │   │   ├── ConfirmDialog.tsx        # Delete confirmation
│   │   │   └── EmptyState.tsx           # Shown when no bookmarks
│   │   ├── hooks/
│   │   │   ├── useBookmarks.ts          # CRUD operations via React Query
│   │   │   └── useTags.ts              # Tag fetching hook
│   │   ├── types/
│   │   │   └── index.ts                # Bookmark and Tag types
│   │   └── main.tsx
│   ├── tests/
│   │   ├── BookmarkCard.test.tsx        # Card rendering and actions
│   │   ├── BookmarkForm.test.tsx        # Form validation and submit
│   │   └── SearchBar.test.tsx           # Debounce and filter behavior
│   ├── package.json
│   └── vite.config.ts
├── backend/
│   ├── src/
│   │   ├── index.ts                     # Express server setup
│   │   ├── routes/
│   │   │   ├── bookmarks.ts             # Bookmark CRUD handlers
│   │   │   └── tags.ts                  # Tag list handler
│   │   ├── db/
│   │   │   └── index.ts                 # SQLite connection + schema init
│   │   └── schemas/
│   │       └── bookmark.ts              # Zod validation schemas
│   ├── tests/
│   │   ├── bookmarks.test.ts            # Bookmark API tests
│   │   └── tags.test.ts                 # Tag API tests
│   ├── package.json
│   └── tsconfig.json
└── README.md
```

## API Endpoints

### Bookmarks
- `GET /api/bookmarks` - List all (query: `?tag=`, `?search=`)
- `POST /api/bookmarks` - Create new (body: `{ url, title, tags? }`)
- `PUT /api/bookmarks/:id` - Update (body: `{ url?, title?, tags? }`)
- `DELETE /api/bookmarks/:id` - Delete (returns 204)

### Tags
- `GET /api/tags` - List all tags with bookmark counts

### Health
- `GET /health` - Returns `{ status: "ok" }`

## Database Schema
```sql
CREATE TABLE bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE bookmark_tags (
  bookmark_id INTEGER REFERENCES bookmarks(id) ON DELETE CASCADE,
  tag_id INTEGER REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (bookmark_id, tag_id)
);
```

## Requirements
- TypeScript throughout
- Input validation (frontend + backend): URL format, title required
- Error handling with user-visible feedback (toast or inline messages)
- Loading states during API calls
- Empty states for no bookmarks and no search results
- Search debounce: 300ms delay before API call
- Responsive design (single-column on mobile, sidebar on desktop)

## Testing
- Backend API tests: Bookmark CRUD, tag listing, search/filter queries (Vitest + supertest)
- Frontend component tests: BookmarkCard rendering, BookmarkForm validation, SearchBar debounce (Vitest + React Testing Library)
- Minimum 10 test cases across frontend and backend
- All tests required to pass (no optional tests)

## Out of Scope
- User authentication
- Import/export
- Browser extension
- Cloud deployment
- Real-time sync

## Success Criteria
- All CRUD operations work end-to-end (create, read, update, delete)
- Search filters bookmarks by title with debounce
- Tag filter shows only bookmarks with selected tag
- Tag counts are accurate
- Data persists across page refresh
- No console errors
- All tests pass
- Code review passes (all 3 reviewers)

---

**Purpose:** Comprehensive test of Loki Mode's full capabilities including frontend, backend, database, and code review agents. Expect ~30-60 minutes for full execution.
