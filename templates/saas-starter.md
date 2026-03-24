# PRD: SaaS Starter App

## Overview
A production-ready SaaS starter application with authentication, subscription billing, an admin dashboard, and user settings. Provides the foundation for any subscription-based web application.

## Target Users
- Indie developers launching a SaaS product
- Small teams needing a billing-ready starting point
- Founders validating a SaaS idea quickly

## Features

### MVP Features
1. **Authentication** - Email/password signup and login with email verification
2. **OAuth Login** - Sign in with Google and GitHub
3. **Subscription Billing** - Stripe integration with Free, Pro, and Enterprise tiers
4. **Admin Dashboard** - View users, subscriptions, revenue metrics, and system health
5. **User Settings** - Profile editing, password change, avatar upload, and plan management
6. **Team Support** - Invite members by email, assign roles (owner, admin, member)

### User Flow
1. User signs up via email or OAuth -> receives verification email
2. Lands on onboarding screen -> selects a plan
3. Free tier: immediate access to basic features
4. Paid tier: redirected to Stripe Checkout -> subscription created
5. User accesses dashboard with feature gates based on plan
6. Admin users see admin panel with analytics and user management

## Tech Stack

### Frontend
- Next.js 14 (App Router)
- TypeScript
- TailwindCSS + shadcn/ui components
- React Hook Form + zod for form validation

### Backend
- Next.js API Routes (Route Handlers)
- Prisma ORM
- PostgreSQL
- NextAuth.js v5 for authentication
- Stripe SDK for billing

### Infrastructure
- Database: PostgreSQL (local via Docker for dev)
- Email: Resend or Nodemailer (SMTP) for transactional emails
- File uploads: Local filesystem (S3-ready interface)

### Structure
```
/
├── src/
│   ├── app/
│   │   ├── (auth)/
│   │   │   ├── login/
│   │   │   ├── signup/
│   │   │   └── verify-email/
│   │   ├── (dashboard)/
│   │   │   ├── dashboard/
│   │   │   ├── settings/
│   │   │   └── team/
│   │   ├── (admin)/
│   │   │   ├── admin/
│   │   │   └── admin/users/
│   │   ├── api/
│   │   │   ├── auth/
│   │   │   ├── billing/
│   │   │   ├── users/
│   │   │   └── webhooks/
│   │   └── layout.tsx
│   ├── components/
│   │   ├── ui/
│   │   ├── forms/
│   │   └── layouts/
│   ├── lib/
│   │   ├── auth.ts
│   │   ├── db.ts
│   │   ├── stripe.ts
│   │   └── email.ts
│   └── types/
├── prisma/
│   ├── schema.prisma
│   └── seed.ts
├── package.json
└── README.md
```

## Database Schema

```prisma
model User {
  id            String    @id @default(cuid())
  email         String    @unique
  name          String?
  passwordHash  String?
  avatarUrl     String?
  emailVerified DateTime?
  role          Role      @default(USER)
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  accounts      Account[]
  subscription  Subscription?
  teamMembers   TeamMember[]
}

model Account {
  id                String  @id @default(cuid())
  userId            String
  provider          String
  providerAccountId String
  accessToken       String?
  refreshToken      String?

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@unique([provider, providerAccountId])
}

model Subscription {
  id               String   @id @default(cuid())
  userId           String   @unique
  stripeCustomerId String   @unique
  stripePriceId    String
  stripeSubId      String?  @unique
  status           SubStatus @default(ACTIVE)
  plan             Plan     @default(FREE)
  currentPeriodEnd DateTime?
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
}

model Team {
  id        String       @id @default(cuid())
  name      String
  createdAt DateTime     @default(now())
  members   TeamMember[]
}

model TeamMember {
  id     String   @id @default(cuid())
  userId String
  teamId String
  role   TeamRole @default(MEMBER)

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  team Team @relation(fields: [teamId], references: [id], onDelete: Cascade)
  @@unique([userId, teamId])
}

enum Role {
  USER
  ADMIN
}

enum TeamRole {
  OWNER
  ADMIN
  MEMBER
}

enum Plan {
  FREE
  PRO
  ENTERPRISE
}

enum SubStatus {
  ACTIVE
  CANCELED
  PAST_DUE
  TRIALING
}
```

## API Endpoints

### Authentication
- `POST /api/auth/signup` - Register with email/password
- `POST /api/auth/login` - Login with credentials
- `POST /api/auth/logout` - End session
- `GET /api/auth/verify?token=` - Verify email address
- `POST /api/auth/forgot-password` - Request password reset
- `POST /api/auth/reset-password` - Reset with token
- OAuth handled by NextAuth.js v5 (Auth.js) via `src/lib/auth.ts` config and `/api/auth/[...nextauth]` catch-all route

### Billing
- `POST /api/billing/checkout` - Create Stripe Checkout session
- `POST /api/billing/portal` - Create Stripe Customer Portal session
- `GET /api/billing/subscription` - Get current subscription details
- `POST /api/webhooks/stripe` - Stripe webhook handler (checkout.session.completed, invoice.paid, customer.subscription.updated, customer.subscription.deleted)

### Users
- `GET /api/users/me` - Get current user profile
- `PATCH /api/users/me` - Update profile
- `POST /api/users/me/avatar` - Upload avatar

### Admin
- `GET /api/admin/users` - List all users (paginated, searchable)
- `GET /api/admin/stats` - Revenue, signups, churn metrics
- `PATCH /api/admin/users/:id` - Update user role or status

### Teams
- `POST /api/teams` - Create team
- `GET /api/teams/:id` - Get team details
- `POST /api/teams/:id/invite` - Invite member by email
- `DELETE /api/teams/:id/members/:userId` - Remove member

## Requirements
- TypeScript throughout
- Server-side rendering for auth-gated pages
- Middleware-based route protection (auth + role checks)
- Stripe webhook signature verification
- CSRF protection on all mutations
- Rate limiting on auth endpoints
- Input validation on all API routes (zod)
- Responsive design (mobile-first)
- Dark mode support

## Testing
- Unit tests: Prisma queries, utility functions (Vitest)
- API tests: Auth flow, billing webhooks, CRUD operations (Vitest + MSW)
- E2E tests: Signup -> subscribe -> access feature -> cancel flow (Playwright)
- Stripe: Use test mode keys and Stripe CLI for webhook testing

## Out of Scope
- Multi-tenancy with data isolation
- Usage-based billing (metered)
- Two-factor authentication (2FA)
- Internationalization (i18n)
- Mobile native apps
- CI/CD pipeline configuration
- Production deployment (Vercel, AWS, etc.)

## Success Criteria
- User can sign up, verify email, and log in
- OAuth login works with Google and GitHub
- User can subscribe to a paid plan via Stripe Checkout
- Billing portal allows plan changes and cancellation
- Admin dashboard shows user list and revenue metrics
- Role-based access control enforced on all routes
- All tests pass
- No console errors or unhandled promise rejections

---

**Purpose:** Tests Loki Mode's ability to scaffold a production-grade SaaS application with complex auth flows, third-party integrations (Stripe, OAuth), and role-based access control. Expect ~60-90 minutes for full execution.
