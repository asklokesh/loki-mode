// Pinned to match modules/aws so an operator running both does not hit a
// provider-version conflict inside one Terraform run.
terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}
