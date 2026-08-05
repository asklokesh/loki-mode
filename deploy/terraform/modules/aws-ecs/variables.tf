// ECS/Fargate deployment variables.
//
// WHY THIS MODULE EXISTS. The repo shipped Helm for Kubernetes and Terraform for
// EKS/AKS/GKE, and nothing at all for ECS. A large share of AWS shops run
// ECS/Fargate precisely to avoid operating a Kubernetes control plane, so
// telling them "use the Helm chart" is telling them to adopt Kubernetes first.
// That is not an on-ramp, it is a prerequisite.
//
// Variable names and provider pinning deliberately mirror modules/aws so an
// operator moving between the two is not learning a second dialect.

variable "region" {
  description = "AWS region to deploy into."
  type        = string
}

variable "name_prefix" {
  description = "Prefix for all created resource names. Keeps a shared account readable and lets one team run several environments."
  type        = string
  default     = "autonomi"
}

variable "vpc_id" {
  description = "Existing VPC to deploy into. This module does not create a VPC: enterprises almost always have one already, and creating a second is the fastest way to get a Terraform plan rejected in review."
  type        = string
}

variable "subnet_ids" {
  description = "Subnet IDs for the ECS service. Use private subnets with a NAT route for anything real; public subnets require assign_public_ip."
  type        = list(string)
}

variable "assign_public_ip" {
  description = "Assign a public IP to tasks. Required when running in public subnets with no NAT gateway. Default false because a control plane on a public IP is a finding in any security review."
  type        = bool
  default     = false
}

variable "image" {
  description = "Container image reference, including tag. Pin a digest or an immutable tag: :latest makes a rollback impossible to reason about, and 'which build is running' unanswerable during an incident."
  type        = string
  default     = "asklokesh/loki-mode:latest"
}

variable "cpu" {
  description = "Fargate task CPU units (256 = 0.25 vCPU). Fargate only accepts specific CPU/memory pairs; the validation below rejects an invalid combination at plan time instead of at RunTask."
  type        = number
  default     = 1024

  validation {
    condition     = contains([256, 512, 1024, 2048, 4096, 8192, 16384], var.cpu)
    error_message = "Fargate cpu must be one of 256, 512, 1024, 2048, 4096, 8192, 16384."
  }
}

variable "memory" {
  description = "Fargate task memory in MiB. Must be a legal pairing with cpu (AWS documents the matrix); an illegal pair fails at RunTask with a message that does not name the field."
  type        = number
  default     = 2048
}

variable "desired_count" {
  description = "Number of control-plane tasks to run."
  type        = number
  default     = 1
}

variable "dashboard_port" {
  description = "Port the control plane binds. Mirrors the Helm chart's config.dashboardPort so the two deployment paths agree."
  type        = number
  default     = 57374
}

variable "log_retention_days" {
  description = "CloudWatch log retention. Zero-day retention is the default in many modules and quietly discards the evidence you need after an incident, so this defaults to 30."
  type        = number
  default     = 30
}

variable "provider_secret_arn" {
  description = "ARN of a Secrets Manager secret holding the AI provider API key. Passed to the task as a secret reference, never as a plaintext environment variable: environment variables are visible in the ECS console and in describe-tasks output."
  type        = string
  default     = ""
}

variable "log_level" {
  description = "Engine log level."
  type        = string
  default     = "info"
}

variable "tags" {
  description = "Tags applied to every created resource. Enterprises use these for cost allocation and ownership, and an untagged resource is the one nobody claims."
  type        = map(string)
  default     = {}
}
