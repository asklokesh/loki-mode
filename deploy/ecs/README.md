# ECS example: Loki Control Plane

`control-plane-task.json` is an example Fargate task definition. Replace the
placeholders (ACCOUNT_ID, REGION, the EFS file system id and the Secrets
Manager ARNs) before use. No secret values live in the file; ECS injects them
from Secrets Manager at start.

1. Build and push the image from `Dockerfile.control-plane` to ECR.
2. Create the secrets and an EFS file system (the SQLite database lives in
   `/data`; run exactly one task, as the database is single-writer).
3. Register the task: `aws ecs register-task-definition --cli-input-json file://deploy/ecs/control-plane-task.json`
4. Create a service with desired count 1 and put it behind a private load
   balancer or an authenticating proxy. The server has no authentication of its own.

Docs: `docs/control-plane-container.md`.
