# ECS example: Loki Control Plane

`control-plane-task.json` is an example Fargate task definition. Replace the
placeholders (ACCOUNT_ID, REGION, the EFS file system id and the Secrets
Manager ARNs) before use. No secret values live in the file; ECS injects them
from Secrets Manager at start.

1. Build and push the image from `docker/Dockerfile.control-plane` to ECR.
2. Create the secrets and an EFS file system (the SQLite database lives in
   `/data`; run exactly one task, as the database is single-writer).
3. Register the task: `aws ecs register-task-definition --cli-input-json file://deploy/ecs/control-plane-task.json`
4. Create a service with desired count 1 and put it behind a private load
   balancer. The task maps `LOKI_CONTROL_TOKEN` from Secrets Manager (`loki/control-token`);
   the server exits 2 on its 0.0.0.0 bind without it, so create that secret first.

Docs: `docs/control-plane-container.md`.
