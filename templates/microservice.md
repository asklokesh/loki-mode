# PRD: Microservice

## Overview
A containerized microservice with health checks, structured logging, graceful shutdown, and observability. Follows twelve-factor app principles for cloud-native deployment.

## Target Users
- Backend engineers building distributed systems
- Teams decomposing monoliths into microservices
- DevOps engineers designing cloud-native architectures

## Core Features
1. **HTTP API** - RESTful endpoints with request validation, error handling, and content negotiation
2. **Health Checks** - Liveness and readiness probe endpoints for container orchestration
3. **Structured Logging** - JSON-formatted logs with correlation IDs, log levels, and context fields
4. **Graceful Shutdown** - Handle SIGTERM/SIGINT with connection draining and cleanup
5. **Configuration** - Environment-variable-based configuration with validation on startup
6. **Database Integration** - Connection pooling, migrations, and repository pattern for data access
7. **Observability** - Prometheus metrics endpoint with request duration, error rate, and custom counters

## Technical Requirements
- Node.js with Express and TypeScript
- Docker and docker-compose for local development
- Prisma ORM with PostgreSQL
- Prometheus client for metrics
- pino for structured logging
- Dockerfile with multi-stage build
- Health check middleware

## Quality Gates
- Unit tests for business logic and middleware
- Integration tests with test database
- Docker image builds and starts successfully
- Health check endpoints return correct status codes
- Graceful shutdown completes within timeout
- Metrics endpoint serves valid Prometheus format

## Project Structure
```
/
├── src/
│   ├── app.ts                 # Express app setup, middleware stack
│   ├── server.ts              # Entry point with graceful shutdown
│   ├── config/
│   │   └── index.ts           # Env-based config with validation
│   ├── middleware/
│   │   ├── requestId.ts       # Correlation ID injection
│   │   ├── healthCheck.ts     # Liveness and readiness probes
│   │   └── metrics.ts         # Prometheus metrics collection
│   ├── routes/
│   │   └── items.ts           # Example resource routes
│   ├── repositories/
│   │   └── itemRepo.ts        # Repository pattern data access
│   ├── logger.ts              # pino structured logger
│   └── types/
│       └── index.ts           # Shared types
├── prisma/
│   ├── schema.prisma          # Database schema
│   └── migrations/            # Database migrations
├── tests/
│   ├── items.test.ts          # API integration tests
│   └── healthCheck.test.ts    # Health probe tests
├── Dockerfile                 # Multi-stage build
├── docker-compose.yml         # Local dev with PostgreSQL
├── package.json
└── README.md
```

## Out of Scope
- Service mesh or sidecar proxy configuration
- Message queue integration (RabbitMQ, Kafka)
- API gateway or load balancer setup
- Distributed tracing (OpenTelemetry spans)
- Secret management (Vault, AWS Secrets Manager)
- Kubernetes manifests or Helm charts
- CI/CD pipeline configuration

## Acceptance Criteria
- Docker image builds with multi-stage Dockerfile under 150MB
- GET /health/live returns 200 immediately after startup
- GET /health/ready returns 200 only when database is connected
- All request logs are valid JSON containing a correlation ID
- SIGTERM triggers graceful shutdown: stops accepting new connections and drains existing ones
- GET /metrics returns valid Prometheus exposition format
- Environment variables validated on startup; missing required vars cause exit 1

## Success Metrics
- Service starts in Docker and responds to API requests
- Health probes return healthy status after startup
- Logs are valid JSON with correlation IDs across requests
- Graceful shutdown drains connections without dropping requests
- Prometheus can scrape metrics endpoint
- All tests pass

---

**Purpose:** Tests Loki Mode's ability to build a production-ready containerized service with health checks, structured logging, graceful shutdown, and observability. Expect ~30-45 minutes for full execution.
