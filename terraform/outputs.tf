output "public_ip" {
  value = oci_core_public_ip.website.ip_address
}

output "ssh_command" {
  value = "ssh ubuntu@${oci_core_public_ip.website.ip_address}"
}
