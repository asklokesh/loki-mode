# Docker Compose Requirement

Every project MUST include a docker-compose.yml file for running the application.

## Rules:
1. Always create a Dockerfile and docker-compose.yml in the project root
2. The docker-compose.yml must expose the app port (mapped to the same host port)
3. Use multi-stage builds for compiled languages
4. Include health checks in the compose file
5. Use .dockerignore to exclude node_modules, .git, etc.
6. NEVER use named volumes for node_modules (causes ENOTEMPTY errors). Use anonymous volumes: `- /app/node_modules`
7. For full-stack projects (frontend + backend), include ALL services in one docker-compose.yml
8. Frontend services MUST use anonymous volume for node_modules, NOT named volumes
9. Must work on: Docker Desktop (macOS/Windows), Linux Docker, Docker-in-Docker, Kubernetes, developer laptops
10. Use `npm ci` in Dockerfile (not `npm install`) for deterministic builds

## Template for Node.js/Next.js:
```yaml
services:
  app:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - .:/app
      - /app/node_modules
    environment:
      - NODE_ENV=development
    command: npm run dev
```

## Template for Python/FastAPI:
```yaml
services:
  app:
    build: .
    ports:
      - "8000:8000"
    volumes:
      - .:/app
    command: uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

## Template for Go:
```yaml
services:
  app:
    build: .
    ports:
      - "8080:8080"
    command: ./app
```

## Template for Full-Stack (Next.js + FastAPI + PostgreSQL):
```yaml
services:
  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile
      target: deps
    ports:
      - "3000:3000"
    depends_on:
      - backend
    volumes:
      - ./frontend:/app
      - /app/node_modules
    command: sh -c "npm install && npm run dev"

  backend:
    build:
      context: ./backend
      dockerfile: Dockerfile
    ports:
      - "8000:8000"
    depends_on:
      - postgres
      - redis
    volumes:
      - ./backend:/app
    env_file:
      - .env
    command: uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

  postgres:
    image: postgres:16-alpine
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: ${DB_USER:-app}
      POSTGRES_PASSWORD: ${DB_PASSWORD:-app}
      POSTGRES_DB: ${DB_NAME:-app}
    volumes:
      - pg_data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

volumes:
  pg_data:
```

IMPORTANT: The frontend volume MUST use `- /app/node_modules` (anonymous volume),
NEVER `- frontend_node_modules:/app/node_modules` (named volume). Named volumes
cause ENOTEMPTY errors when npm tries to rename packages inside the mounted volume.

## Template for static HTML:
```yaml
services:
  app:
    image: nginx:alpine
    ports:
      - "8000:80"
    volumes:
      - .:/usr/share/nginx/html:ro
```
