data "oci_identity_availability_domains" "ads" {
  compartment_id = var.tenancy_ocid
}

data "oci_core_images" "ubuntu_arm" {
  compartment_id           = var.compartment_ocid
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = "VM.Standard.A1.Flex"
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

resource "oci_core_public_ip" "website" {
  compartment_id = var.compartment_ocid
  lifetime       = "RESERVED"
  display_name   = "website-ip"
  private_ip_id  = data.oci_core_private_ips.website.private_ips[0].id
}

data "oci_core_vnic_attachments" "website" {
  compartment_id = var.compartment_ocid
  instance_id    = oci_core_instance.website.id
}

data "oci_core_private_ips" "website" {
  vnic_id = data.oci_core_vnic_attachments.website.vnic_attachments[0].vnic_id
}

resource "oci_core_instance" "website" {
  compartment_id      = var.compartment_ocid
  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[var.availability_domain_index].name
  display_name        = var.instance_name
  shape               = "VM.Standard.A1.Flex"

  shape_config {
    ocpus         = var.ocpus
    memory_in_gbs = var.memory_gb
  }

  source_details {
    source_type = "image"
    source_id   = data.oci_core_images.ubuntu_arm.images[0].id
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.public.id
    assign_public_ip = false
  }

  metadata = {
    ssh_authorized_keys = file(var.deploy_ssh_public_key_path)
    user_data           = base64encode(file("${path.module}/cloud-init.yaml"))
  }

  lifecycle {
    # Keys are set at creation; ignore drift so re-applies never rebuild the box.
    # `source_details` too: the image data source picks the newest Ubuntu build
    # on every run, and once Canonical publishes one Terraform wants to swap
    # the boot image in place, which on OCI replaces the boot volume and wipes
    # the VM. The data source still picks the image for a NEW instance; an
    # existing one keeps the disk it has (2026-09-07: an apply tried exactly
    # this and was stopped only by the 47 GB boot volume being under the API's
    # 50 GB minimum).
    ignore_changes = [metadata["ssh_authorized_keys"], source_details]
  }
}
