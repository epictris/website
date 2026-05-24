variable "tenancy_ocid" {
  description = "OCID of your OCI tenancy"
  type        = string
}

variable "user_ocid" {
  description = "OCID of your OCI user"
  type        = string
}

variable "fingerprint" {
  description = "Fingerprint of the API key"
  type        = string
}

variable "private_key_path" {
  description = "Absolute path to the OCI API private key (no ~ expansion)"
  type        = string
}

variable "compartment_ocid" {
  description = "OCID of the compartment to deploy into"
  type        = string
}

variable "region" {
  description = "OCI region (e.g. eu-amsterdam-1)"
  type        = string
}

variable "deploy_ssh_public_key_path" {
  description = "Path to the deploy SSH public key used by GitHub Actions"
  type        = string
  default     = "~/.ssh/website_deploy.pub"
}

variable "availability_domain_index" {
  description = "Index of the availability domain to use (0, 1, or 2) — try others if out of capacity"
  type        = number
  default     = 0
}

variable "instance_name" {
  description = "Display name for the compute instance"
  type        = string
  default     = "website"
}

variable "ocpus" {
  description = "Number of OCPUs (free tier allows up to 4 total across all Ampere instances)"
  type        = number
  default     = 2
}

variable "memory_gb" {
  description = "RAM in GB (free tier allows up to 24 GB total across all Ampere instances)"
  type        = number
  default     = 12
}
