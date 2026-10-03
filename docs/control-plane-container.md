# Run the Control Plane in a container

The Control Plane (run ingest API plus UI) ships as its own small image built
from `Dockerfile.control-plane`. It serves on port 47821, stores its SQLite
database under `/data`, runs as a non-root user and contains no secrets.

The server has no authentication of its own. Keep it on a private network or
behind an authenticating proxy; do not expose it publicly.

## Docker

```bash
docker build -f Dockerfile.control-plane -t loki-control-plane .
docker run -d -p 47821:47821 -v loki-control:/data loki-control-plane
LOKI_CONTROL_URL=http://localhost:47821 loki control status
```

Health: `/health` (liveness) and `/ready` (database check).

## Helm

```bash
helm install loki-control ./deploy/helm/control-plane \
  --namespace loki --create-namespace \
  --set image.repository=<your-registry>/loki-control-plane \
  --set existingSecret=autonomi-secrets \
  --set 'secretKeys={ANTHROPIC_API_KEY}'
```

Provider keys are read from an existing Kubernetes Secret you name with
`existingSecret`; nothing is stored in values. Ingress is off by default
(`ingress.enabled=true` to turn it on). Keep `replicas: 1` (single SQLite volume).

## ECS

See `deploy/ecs/README.md` and `deploy/ecs/control-plane-task.json` (Fargate,
EFS volume, secrets from Secrets Manager ARNs).

## Configuration

| Variable | Default in image | Meaning |
| --- | --- | --- |
| `PORT` | 47821 | listen port |
| `LOKI_CONTROL_HOST` | 0.0.0.0 | bind address (outside the image: 127.0.0.1) |
| `LOKI_CONTROL_DB` | /data/control.db | SQLite path |
