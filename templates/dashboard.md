# PRD: Analytics Dashboard

## Overview
A real-time analytics dashboard that visualizes key business metrics with interactive charts, filterable data tables, and customizable dashboard layouts.

## Target Users
- Product managers tracking feature adoption and user engagement
- Business analysts monitoring KPIs and trends
- Operations teams watching system health and performance metrics

## Core Features
1. **Interactive Charts** - Line, bar, pie, and area charts with hover tooltips and click-to-drill-down
2. **Data Tables** - Sortable, filterable, and paginated tables with column visibility controls
3. **Date Range Picker** - Filter all dashboard data by custom date ranges with preset shortcuts
4. **Real-Time Updates** - WebSocket connection for live metric updates without page refresh
5. **Dashboard Layouts** - Drag-and-drop widget arrangement with save and load layout presets
6. **Export** - Export charts as PNG images and tables as CSV files
7. **Responsive Design** - Fully functional on desktop, tablet, and mobile screen sizes

## Technical Requirements
- React 18 with TypeScript
- Recharts or Chart.js for data visualization
- TanStack Table for data tables
- WebSocket for real-time updates
- TailwindCSS for styling
- Express backend serving mock data API
- LocalStorage for saved layouts

## Quality Gates
- Unit tests for data transformation and formatting utilities
- Component tests for chart and table rendering
- E2E tests for date filtering and layout persistence (Playwright)
- Responsive design tested at 3 breakpoints (mobile, tablet, desktop)
- Accessibility: all charts have aria labels, tables are keyboard navigable

## Project Structure
```
/
├── src/
│   ├── components/
│   │   ├── charts/            # Line, bar, pie, area chart components
│   │   ├── tables/            # Data table with sorting and filtering
│   │   ├── layout/            # Dashboard grid, drag-and-drop wrapper
│   │   └── controls/          # Date picker, export buttons, filters
│   ├── hooks/
│   │   ├── useWebSocket.ts    # Real-time data subscription
│   │   └── useLayout.ts       # Layout persistence (localStorage)
│   ├── services/
│   │   └── api.ts             # Mock data API client
│   ├── types/
│   │   └── index.ts           # Shared TypeScript types
│   ├── App.tsx
│   └── main.tsx
├── server/
│   ├── index.ts               # Express + WebSocket server
│   └── mockData.ts            # Sample metrics generator
├── tests/
│   ├── charts.test.tsx        # Chart rendering tests
│   └── e2e/                   # Playwright tests
├── package.json
└── README.md
```

## Out of Scope
- Real database or data warehouse connections
- User authentication or multi-tenant dashboards
- Server-side rendering
- PDF report generation
- Alerting or notification rules
- Historical data backfill
- Custom chart builder UI

## Acceptance Criteria
- All four chart types (line, bar, pie, area) render with correct data
- Date range filter applies to every widget on the dashboard
- WebSocket pushes update visible charts without page refresh
- Layout changes via drag-and-drop persist after browser reload
- CSV export matches displayed table data exactly
- PNG export captures the selected chart at screen resolution

## Success Metrics
- Dashboard loads with sample data and renders all chart types
- Date range filter updates all widgets simultaneously
- Real-time updates reflect in charts within 2 seconds
- Drag-and-drop layout changes persist across page reloads
- CSV and PNG exports contain accurate data
- All tests pass

---

**Purpose:** Tests Loki Mode's ability to build a data visualization application with real-time updates, interactive charts, drag-and-drop layouts, and export functionality. Expect ~45-60 minutes for full execution.
