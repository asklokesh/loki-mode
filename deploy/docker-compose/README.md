# Autonomi Enterprise - Docker Compose Evaluation

Single-node deployment for evaluating Autonomi (Loki Mode) with optional
observability and enterprise integrations.

## Prerequisites

- Docker Engine 24+ and Docker Compose v2+
- At least one LLM provider API key (Anthropic, OpenAI, or Google)
- 2 GB free RAM (4 GB recommended with observability profile)

## Quickstart

```bash
cp .env.example .env
# Edit .env and add at least one API key (ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_API_KEY)

docker compose up -d
```

The Control Plane UI and API are available at **http://localhost:57374** (loopback only by default; set `LOKI_BIND_ADDRESS` to change). `LOKI_CONTROL_TOKEN` is required in `.env` and compose refuses to start without it (upgrade note: earlier compose files started with an empty token, now `docker compose up` fails closed with "set LOKI_CONTROL_TOKEN in .env" until you set one); open the UI with `#token=<token>` appended to the URL. The database lives under `/workspace/.loki/control` on the `projects` volume. `LOKI_DASHBOARD_ALLOWED_HOSTS` no longer has any effect.

## Observability Mode

Enable the bundled OpenTelemetry Collector and Jaeger for distributed tracing:

```bash
# Add the OTEL endpoint to your .env
echo 'LOKI_OTEL_ENDPOINT=http://otel-collector:4318' >> .env

docker compose --profile observability up -d
```

| Service        | URL                       | Purpose                  |
|----------------|---------------------------|--------------------------|
| Dashboard      | http://localhost:57374     | Control Plane UI and API |
| Jaeger UI      | http://localhost:16686     | Trace visualization      |
| OTLP (gRPC)   | localhost:4317             | Trace ingestion (gRPC)   |
| OTLP (HTTP)    | localhost:4318             | Trace ingestion (HTTP)   |

## Enterprise Features

All enterprise features are opt-in via environment variables in `.env`.

### Authentication (OIDC)

```
LOKI_ENTERPRISE_AUTH=true
LOKI_OIDC_ISSUER=https://accounts.google.com
LOKI_OIDC_CLIENT_ID=your-client-id
```

### Slack Integration

```
LOKI_SLACK_BOT_TOKEN=xoxb-your-token
LOKI_SLACK_SIGNING_SECRET=your-signing-secret
```

### Microsoft Teams Integration

```
LOKI_TEAMS_WEBHOOK_URL=https://outlook.office.com/webhook/...
LOKI_TEAMS_WEBHOOK_SECRET=your-webhook-secret
```

### Jira Integration

```
LOKI_JIRA_URL=https://mycompany.atlassian.net
LOKI_JIRA_TOKEN=your-api-token
```

Known issue on main: `src/integrations/sync-subscriber.js` constructs `JiraApiClient`
without the `email` and `apiToken` it requires, so Jira auto-sync from these
variables does not start. Construct `JiraApiClient({ baseUrl, email, apiToken })`
in code until that is fixed.

## Persistent Data

Data is stored in Docker named volumes and survives `docker compose down`:

| Volume        | Container Path       | Contents                     |
|---------------|----------------------|------------------------------|
| `checkpoints` | `/app/.loki/state`   | Agent state and checkpoints  |
| `audit`       | `/app/.loki/audit`   | Audit logs                   |
| `projects`    | `/workspace`         | Project workspaces           |

To fully reset all data:

```bash
docker compose down -v
```

## Building from Source

To build the image locally instead of pulling from Docker Hub:

```bash
docker compose build
docker compose up -d
```

The build context points to the repository root (`../..`) and uses the
top-level `Dockerfile`.

## Troubleshooting

### Dashboard not loading

Check that the container is healthy:

```bash
docker compose ps
docker compose logs autonomi
```

The health check hits `http://localhost:47821/health` inside the container. If the container shows
as `unhealthy`, inspect the logs for startup errors.

### Port conflict

If port 57374 is already in use, change it in `.env`:

```
LOKI_DASHBOARD_PORT=8080
```

### No LLM provider configured

The autonomi service requires at least one API key. Verify your `.env` has a
valid key set for `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GOOGLE_API_KEY`.

### Observability services not starting

The OTEL collector and Jaeger only start when the `observability` profile is
active. Make sure you include the profile flag:

```bash
docker compose --profile observability up -d
```

### Viewing logs

```bash
# All services
docker compose logs -f

# Single service
docker compose logs -f autonomi
docker compose logs -f otel-collector
docker compose logs -f jaeger
```

### Resetting everything

```bash
docker compose --profile observability down -v
```

This stops all containers and removes all named volumes (data will be lost).
