// Autonomi (Loki Mode) control plane on ECS/Fargate.
//
// The container command, port and health path are taken from the Helm chart's
// deployment-controlplane.yaml so the two deployment paths cannot drift:
//   command: python3 -m uvicorn dashboard.server:app --host <host> --port <port>
//   health:  GET /health   (dashboard/server.py:1070)
// Hardcoding a different path here would give ECS a health check that passes
// while Kubernetes fails, or the reverse, and neither would be discovered until
// one of them was in production.

locals {
  name = var.name_prefix

  tags = merge(
    {
      "app.kubernetes.io/name"       = "autonomi"
      "app.kubernetes.io/component"  = "controlplane"
      "app.kubernetes.io/managed-by" = "terraform"
    },
    var.tags,
  )
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/ecs/${local.name}-controlplane"
  retention_in_days = var.log_retention_days
  tags              = local.tags
}

resource "aws_ecs_cluster" "this" {
  name = "${local.name}-cluster"

  setting {
    // Container Insights is what makes a Fargate task debuggable after the fact.
    // Off by default in AWS; an operator without it has task-level metrics only.
    name  = "containerInsights"
    value = "enabled"
  }

  tags = local.tags
}

// Execution role: what ECS itself needs to START the task (pull the image,
// write logs, read secrets). Deliberately separate from the task role below --
// collapsing them is a common shortcut that hands the application every
// permission the platform needs.
resource "aws_iam_role" "execution" {
  name = "${local.name}-ecs-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

// Reading the provider secret is granted ONLY when a secret is configured, and
// scoped to that one ARN rather than secretsmanager:* -- a wildcard here would
// let the control plane read every secret in the account.
resource "aws_iam_role_policy" "execution_secrets" {
  count = var.provider_secret_arn == "" ? 0 : 1
  name  = "${local.name}-read-provider-secret"
  role  = aws_iam_role.execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = [var.provider_secret_arn]
    }]
  })
}

// Task role: what the APPLICATION may do. Empty by default. An engine that
// needs no AWS API access should have none, and adding permissions here is a
// deliberate act rather than an inheritance.
resource "aws_iam_role" "task" {
  name = "${local.name}-ecs-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = local.tags
}

resource "aws_security_group" "task" {
  name        = "${local.name}-controlplane"
  description = "Autonomi control plane tasks"
  vpc_id      = var.vpc_id

  // No ingress rule is defined here on purpose. Attach a load balancer or an
  // explicit rule for your own CIDR. A module that opens the dashboard port to
  // 0.0.0.0/0 by default is one bad copy-paste from exposing a control plane to
  // the internet.

  egress {
    description = "All outbound. The engine calls a hosted provider API; see `loki doctor --airgap` for the exact host inventory."
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.tags
}

resource "aws_ecs_task_definition" "controlplane" {
  family                   = "${local.name}-controlplane"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name      = "controlplane"
      image     = var.image
      essential = true

      // Mirrors the Helm chart exactly. See the note at the top of this file.
      command = [
        "python3", "-m", "uvicorn", "dashboard.server:app",
        "--host", "0.0.0.0",
        "--port", tostring(var.dashboard_port),
      ]

      portMappings = [{
        containerPort = var.dashboard_port
        protocol      = "tcp"
      }]

      environment = [
        { name = "LOKI_DASHBOARD_PORT", value = tostring(var.dashboard_port) },
        { name = "LOKI_LOG_LEVEL", value = var.log_level },
      ]

      // Secrets arrive as secret references, never as plaintext environment
      // variables: environment is visible in the ECS console and in
      // describe-task-definition output to anyone with read access.
      secrets = var.provider_secret_arn == "" ? [] : [
        { name = "ANTHROPIC_API_KEY", valueFrom = var.provider_secret_arn },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.this.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "controlplane"
        }
      }

      // Same endpoint the Kubernetes readiness probe uses. startPeriod exists
      // so a slow cold start is not reported as an unhealthy task -- the same
      // reason the helm test hook retries instead of probing once.
      healthCheck = {
        command     = ["CMD-SHELL", "curl -fsS http://localhost:${var.dashboard_port}/health || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }
    }
  ])

  tags = local.tags
}

resource "aws_ecs_service" "controlplane" {
  name            = "${local.name}-controlplane"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.controlplane.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [aws_security_group.task.id]
    assign_public_ip = var.assign_public_ip
  }

  // Roll forward without dropping to zero capacity, and let a bad deployment
  // roll itself back rather than sitting broken until someone notices.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  tags = local.tags
}
