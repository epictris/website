# Backup target for the playtest store (see rope/plans/playtest-recording.md).
# The VM copies /opt/website/playtests here nightly as itself: a dynamic group
# matching the instance, and a policy letting that group write objects into this
# one bucket. No key is issued or stored anywhere.

data "oci_objectstorage_namespace" "tenancy" {
  compartment_id = var.compartment_ocid
}

resource "oci_objectstorage_bucket" "playtests" {
  compartment_id = var.compartment_ocid
  namespace      = data.oci_objectstorage_namespace.tenancy.namespace
  name           = "playtests"
  access_type    = "NoPublicAccess"
  storage_tier   = "Standard"
  versioning     = "Disabled"
}

resource "oci_identity_dynamic_group" "website" {
  compartment_id = var.tenancy_ocid
  name           = "website-instance"
  description    = "The website VM, for instance-principal access to the playtests bucket"
  matching_rule  = "Any {instance.id = '${oci_core_instance.website.id}'}"
}

resource "oci_identity_policy" "playtests_backup" {
  compartment_id = var.compartment_ocid
  name           = "website-playtests-backup"
  description    = "Let the website VM copy playtest runs into the playtests bucket"
  statements = [
    "Allow dynamic-group ${oci_identity_dynamic_group.website.name} to read buckets in compartment id ${var.compartment_ocid} where target.bucket.name = '${oci_objectstorage_bucket.playtests.name}'",
    "Allow dynamic-group ${oci_identity_dynamic_group.website.name} to manage objects in compartment id ${var.compartment_ocid} where target.bucket.name = '${oci_objectstorage_bucket.playtests.name}'",
  ]
}

# Set this as the OCI_OS_NAMESPACE repository variable in GitHub; the deploy
# hands it to deploy/host-setup.sh, which writes the rclone config.
output "object_storage_namespace" {
  value = data.oci_objectstorage_namespace.tenancy.namespace
}
