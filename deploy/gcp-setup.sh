#!/usr/bin/env bash
# Run on your computer with gcloud logged in. Idempotent: firewall and static IP. (Backups = GCP disk snapshots; the closing lines print the commands.)
#   HK_PROJECT=budgetapp-1202 HK_VM=hearthkeeper HK_ZONE=us-west1-b bash deploy/gcp-setup.sh
# UNTESTED against a real project (written without gcloud credentials); read the commands before the first run.
set -euo pipefail
: "${HK_PROJECT:?}"; : "${HK_VM:?}"; : "${HK_ZONE:?}"
G=(gcloud --project "$HK_PROJECT")
REGION=${HK_ZONE%-*}

echo "==> firewall: allow tcp:80,443 to VMs tagged hearthkeeper (80 is needed for the certificate challenge)"
"${G[@]}" compute firewall-rules describe hearthkeeper-web >/dev/null 2>&1 || \
  "${G[@]}" compute firewall-rules create hearthkeeper-web --allow tcp:80,tcp:443 --target-tags hearthkeeper --description "HearthKeeper web"
"${G[@]}" compute instances add-tags "$HK_VM" --zone "$HK_ZONE" --tags hearthkeeper

echo "==> static address: make sure the VM's external IP does not change"
IP=$("${G[@]}" compute instances describe "$HK_VM" --zone "$HK_ZONE" --format='get(networkInterfaces[0].accessConfigs[0].natIP)')
"${G[@]}" compute addresses describe hearthkeeper-ip --region "$REGION" >/dev/null 2>&1 || \
  "${G[@]}" compute addresses create hearthkeeper-ip --region "$REGION" --addresses "$IP"
echo "    $IP (point hearthkeeper.com's A record here)"

echo "Done. Backups: attach a snapshot schedule to the VM disk, e.g."
echo "  gcloud compute resource-policies create snapshot-schedule hearthkeeper-daily --region $REGION --max-retention-days 14 --daily-schedule --start-time 11:00"
echo "  gcloud compute disks add-resource-policies <disk-name> --zone $HK_ZONE --resource-policies hearthkeeper-daily"
