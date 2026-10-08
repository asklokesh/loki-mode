# Run the Control Plane in a container

The Control Plane (run ingest API plus UI) ships as its own small image built
from `docker/Dockerfile.control-plane`. It serves on port 47821, stores its SQLite
database under `/data`, runs as a non-root user and contains no secrets.

The image binds 0.0.0.0, so `LOKI_CONTROL_TOKEN` is required at run time. Without
it the server exits 2 before listening. Every `/v1/*` call then needs
`Authorization: Bearer <token>`. The token is never baked into the image. Set
`LOKI_CONTROL_ALLOW_INSECURE_BIND=1` only on a trusted private network; the
server prints a warning when you do.

## Docker

```bash
docker build -f docker/Dockerfile.control-plane -t loki-control-plane .
docker run -d -p 47821:47821 -e LOKI_CONTROL_TOKEN="$(openssl rand -hex 32)" -v loki-control:/data loki-control-plane
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
| `LOKI_CONTROL_TOKEN` | none (required) | bearer token for `/v1/*`; required on a non-loopback bind |
| `LOKI_CONTROL_ALLOW_INSECURE_BIND` | unset | `1` accepts a tokenless non-loopback bind (not recommended) |
| `LOKI_CONTROL_DB` | /data/control.db | SQLite path |
