terraform {
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 6.0"
    }
  }

  # Partial config: bucket, namespace, key, region and credentials are
  # supplied at `terraform init` time via -backend-config (see backend.hcl
  # locally and the Terraform workflow for CI).
  backend "oci" {
    auth = "APIKey"
  }
}

provider "oci" {
  tenancy_ocid     = var.tenancy_ocid
  user_ocid        = var.user_ocid
  fingerprint      = var.fingerprint
  private_key_path = var.private_key_path
  region           = var.region
}
