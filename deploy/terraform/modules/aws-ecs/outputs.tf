output "cluster_name" {
  description = "ECS cluster name."
  value       = aws_ecs_cluster.this.name
}

output "service_name" {
  description = "ECS service name, for `aws ecs describe-services` and rollbacks."
  value       = aws_ecs_service.controlplane.name
}

output "task_definition_arn" {
  description = "Task definition ARN. Pin this when rolling back: the family alone resolves to :latest."
  value       = aws_ecs_task_definition.controlplane.arn
}

output "security_group_id" {
  description = "Security group for the tasks. Attach your ingress rule or load balancer here; the module deliberately defines no inbound rule."
  value       = aws_security_group.task.id
}

output "log_group_name" {
  description = "CloudWatch log group. First place to look when a task will not start."
  value       = aws_cloudwatch_log_group.this.name
}
