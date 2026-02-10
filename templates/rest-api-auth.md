# PRD: REST API with JWT Authentication

## Overview
A production-ready REST API with JWT-based authentication, user registration, login, token refresh, protected routes, rate limiting, and input validation. Serves as a backend starter for any application requiring secure user authentication.

## Target Users
- Backend developers building authenticated APIs
- Teams needing a secure auth starter with best practices
- Developers learning JWT authentication patterns

## Features

### MVP Features
1. **User Registration** - Email/password signup with validation
2. **User Login** - Authenticate and receive JWT access + refresh tokens
3. **Token Refresh** - Exchange refresh token for new access token
4. **Protected Routes** - Middleware-guarded endpoints requiring valid JWT
5. **User Profile** - Get and update authenticated user profile
6. **Password Management** - Change password (authenticated), forgot/reset password flow
7. **Rate Limiting** - Per-IP and per-user rate limits on auth endpoints
8. **Input Validation** - Schema-based request validation on all endpoints

### User Flow
1. User registers via POST /api/auth/register with email and password
2. Server validates input, hashes password, stores user, returns tokens
3. User includes access token in Authorization header for protected routes
4. When access token expires, user calls POST /api/auth/refresh with refresh token
5. User can update profile, change password via protected endpoints
6. Forgot password sends reset token via email (or logs to console in dev)

## Tech Stack

### Option A: Node.js (Express)
- Runtime: Node.js 20+
- Framework: Express.js
- Database: PostgreSQL with Prisma ORM
- Validation: zod
- Auth: jsonwebtoken, bcrypt
- Rate Limiting: express-rate-limit
- Testing: Jest + supertest

### Option B: Python (FastAPI)
- Runtime: Python 3.11+
- Framework: FastAPI
- Database: PostgreSQL with SQLAlchemy
- Validation: Pydantic (built into FastAPI)
- Auth: python-jose, passlib[bcrypt]
- Rate Limiting: slowapi
- Testing: pytest + httpx

Choose whichever framework the agent determines is most appropriate, or default to Express.js.

### Project Structure (Express)
```
/
├── src/
│   ├── app.js                  # Express app setup
│   ├── server.js               # Entry point
│   ├── config/
│   │   └── index.js            # Environment config
│   ├── middleware/
│   │   ├── auth.js             # JWT verification middleware
│   │   ├── validate.js         # Request validation middleware
│   │   └── rateLimiter.js      # Rate limiting middleware
│   ├── routes/
│   │   ├── auth.js             # Auth routes (register, login, refresh, forgot, reset)
│   │   └── users.js            # User routes (profile, update, change password)
│   ├── controllers/
│   │   ├── authController.js   # Auth business logic
│   │   └── userController.js   # User business logic
│   ├── services/
│   │   ├── authService.js      # Token generation, password hashing
│   │   └── emailService.js     # Email sending (console in dev)
│   └── utils/
│       └── errors.js           # Custom error classes
├── prisma/
│   ├── schema.prisma           # Database schema
│   └── seed.js                 # Seed data
├── tests/
│   ├── auth.test.js            # Auth endpoint tests
│   ├── users.test.js           # User endpoint tests
│   └── middleware.test.js      # Middleware tests
├── .env.example                # Environment variable template
├── package.json
└── README.md
```

## Database Schema

```sql
CREATE TABLE users (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email       VARCHAR(255) UNIQUE NOT NULL,
    password    VARCHAR(255) NOT NULL,
    name        VARCHAR(100),
    role        VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    is_active   BOOLEAN DEFAULT true,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE refresh_tokens (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token       VARCHAR(500) NOT NULL,
    expires_at  TIMESTAMP NOT NULL,
    revoked     BOOLEAN DEFAULT false,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE password_resets (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token       VARCHAR(255) UNIQUE NOT NULL,
    expires_at  TIMESTAMP NOT NULL,
    used        BOOLEAN DEFAULT false,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## API Endpoints

### Authentication

#### POST /api/auth/register
- Body: `{ email, password, name? }`
- Validation: email format, password min 8 chars with complexity
- Response: `201 { user: { id, email, name, role }, accessToken, refreshToken }`
- Error: `400` validation, `409` email already exists

#### POST /api/auth/login
- Body: `{ email, password }`
- Response: `200 { user: { id, email, name, role }, accessToken, refreshToken }`
- Error: `401` invalid credentials
- Rate limit: 5 attempts per 15 minutes per IP

#### POST /api/auth/refresh
- Body: `{ refreshToken }`
- Response: `200 { accessToken, refreshToken }`
- Error: `401` invalid/expired/revoked token

#### POST /api/auth/logout
- Headers: `Authorization: Bearer <accessToken>`
- Body: `{ refreshToken }`
- Revokes the refresh token
- Response: `200 { message: "Logged out" }`

#### POST /api/auth/forgot-password
- Body: `{ email }`
- Sends password reset token (logs to console in dev)
- Response: `200 { message: "Reset email sent" }` (always, even if email not found)

#### POST /api/auth/reset-password
- Body: `{ token, newPassword }`
- Response: `200 { message: "Password reset successful" }`
- Error: `400` invalid/expired token

### Users (Protected)

#### GET /api/users/me
- Headers: `Authorization: Bearer <accessToken>`
- Response: `200 { id, email, name, role, createdAt }`

#### PATCH /api/users/me
- Headers: `Authorization: Bearer <accessToken>`
- Body: `{ name?, email? }`
- Response: `200 { id, email, name, role, updatedAt }`

#### POST /api/users/me/change-password
- Headers: `Authorization: Bearer <accessToken>`
- Body: `{ currentPassword, newPassword }`
- Response: `200 { message: "Password changed" }`
- Error: `400` current password incorrect

### Health Check

#### GET /health
- Response: `200 { status: "ok", timestamp, version }`

## Requirements

### Security
- Passwords hashed with bcrypt (cost factor 12)
- JWT access tokens expire in 15 minutes
- JWT refresh tokens expire in 7 days, stored in database, revocable
- Password reset tokens expire in 1 hour
- No password or token values in response bodies (except at login/register)
- CORS configured for allowed origins
- Helmet.js (Express) or equivalent security headers

### Validation
- Email: valid format, lowercase, trimmed
- Password: minimum 8 characters, at least one uppercase, one lowercase, one number
- Name: 1-100 characters, trimmed
- All request bodies validated before processing

### Rate Limiting
- Auth endpoints (login, register): 5 requests per 15 minutes per IP
- Password reset: 3 requests per hour per IP
- General API: 100 requests per 15 minutes per user
- Returns `429 Too Many Requests` with `Retry-After` header

### Error Handling
- Consistent error format: `{ error: { code, message, details? } }`
- No stack traces in production
- Proper HTTP status codes (400, 401, 403, 404, 409, 429, 500)

## Testing

### Unit Tests
- Password hashing and comparison
- JWT generation and verification
- Input validation schemas
- Rate limiter behavior

### Integration Tests
- Full registration flow
- Login with valid and invalid credentials
- Token refresh with valid, expired, and revoked tokens
- Protected route access with and without tokens
- Password change flow
- Forgot/reset password flow
- Rate limit enforcement

### Test Coverage
- Target: 90%+ line coverage
- All error paths tested
- All validation rules tested

## Out of Scope
- OAuth/social login (Google, GitHub, etc.)
- Two-factor authentication (2FA)
- Email verification on registration
- Role-based access control beyond user/admin
- API documentation (OpenAPI/Swagger)
- WebSocket connections
- File uploads
- Deployment configuration
- Frontend/UI

## Success Criteria
- User can register, login, and access protected routes
- Tokens refresh correctly and expired tokens are rejected
- Rate limiting prevents brute force attempts
- All input is validated before processing
- Password reset flow works end to end
- All tests pass with 90%+ coverage
- No security vulnerabilities in auth flow

---

**Purpose:** Tests Loki Mode's ability to build a secure authentication system with JWT tokens, middleware patterns, database schema design, and comprehensive test coverage. Exercises backend agent, security agent, and QA agent. Expect ~30-45 minutes for full execution.
