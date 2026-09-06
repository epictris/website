#!/usr/bin/env bash
# Host configuration the deploy applies on every run, as root. Idempotent: it
# creates what is missing and rewrites what it owns, and nothing here needs a
# person on the VM (see rope/plans/playtest-recording.md).
#
#   OCI_OS_NAMESPACE   the tenancy's Object Storage namespace (terraform output
#                      `object_storage_namespace`); when unset, the backup cron
#                      is not configured and this says so.
set -euo pipefail

PLAYTESTS=/opt/website/playtests
BUCKET=playtests

# The rope container runs as uid 1000 (the image's `bun` user) and writes here.
install -d -o 1000 -g 1000 -m 750 "$PLAYTESTS"

if [ -z "${OCI_OS_NAMESPACE:-}" ]; then
  echo "host-setup: OCI_OS_NAMESPACE unset; playtest backup not configured"
  exit 0
fi

# Unattended upgrades run apt on their own schedule and hold its lock for
# minutes at a time; the first deploy landed on one. Wait for the lock rather
# than fail the deploy over it.
if ! command -v rclone >/dev/null 2>&1; then
  apt-get -o DPkg::Lock::Timeout=600 update -qq
  DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 install -y -qq rclone
fi

# The instance knows its own compartment and region; rclone authenticates as
# the instance itself (instance principal), so no key is stored anywhere.
meta=$(curl -sf -H "Authorization: Bearer Oracle" http://169.254.169.254/opc/v2/instance/)
compartment=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["compartmentId"])' <<<"$meta")
region=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["canonicalRegionName"])' <<<"$meta")

install -d -m 700 /root/.config/rclone
cat > /root/.config/rclone/rclone.conf <<EOF
[oci]
type = oracleobjectstorage
provider = instance_principal_auth
namespace = ${OCI_OS_NAMESPACE}
compartment = ${compartment}
region = ${region}
EOF
chmod 600 /root/.config/rclone/rclone.conf

# `copy`, never `sync`: the store expires runs after 90 days and that must not
# reach the backup. Nightly, logged, with the log rotated by size.
cat > /etc/cron.d/playtest-backup <<EOF
17 3 * * * root rclone copy ${PLAYTESTS} oci:${BUCKET} --exclude 'sessions/**' --log-file /var/log/playtest-backup.log --log-level INFO
EOF
chmod 644 /etc/cron.d/playtest-backup
cat > /etc/logrotate.d/playtest-backup <<EOF
/var/log/playtest-backup.log {
  size 1M
  rotate 3
  compress
  missingok
  notifempty
}
EOF

echo "host-setup: playtest backup -> oci:${BUCKET} (${region}, namespace ${OCI_OS_NAMESPACE})"
