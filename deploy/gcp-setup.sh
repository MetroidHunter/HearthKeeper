#!/usr/bin/env bash
# Run on your computer with gcloud logged in. Idempotent: creates what is missing, leaves the rest alone.
#   HK_PROJECT=budgetapp-1202 HK_VM=hearthkeeper HK_ZONE=us-west1-b HK_BUCKET=budgetapp-1202-hearthkeeper-backups bash deploy/gcp-setup.sh [--fix-scopes]
# UNTESTED against a real project (written without gcloud credentials); read the commands before the first run.
set -euo pipefail
: "${HK_PROJECT:?}"; : "${HK_VM:?}"; : "${HK_ZONE:?}"; : "${HK_BUCKET:?}"
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

echo "==> backup bucket gs://$HK_BUCKET (30-day lifecycle, uniform access, private)"
gcloud storage buckets describe "gs://$HK_BUCKET" --project "$HK_PROJECT" >/dev/null 2>&1 || \
  gcloud storage buckets create "gs://$HK_BUCKET" --project "$HK_PROJECT" --location "$REGION" --uniform-bucket-level-access --public-access-prevention
LC=$(mktemp); echo '{"rule":[{"action":{"type":"Delete"},"condition":{"age":30}}]}' > "$LC"
gcloud storage buckets update "gs://$HK_BUCKET" --lifecycle-file="$LC" --project "$HK_PROJECT"; rm -f "$LC"

SCOPES=$("${G[@]}" compute instances describe "$HK_VM" --zone "$HK_ZONE" --format='value(serviceAccounts[0].scopes)')
if echo "$SCOPES" | grep -qE 'devstorage.read_write|cloud-platform'; then echo "==> VM scopes allow writing to the bucket"
elif [ "${1:-}" = --fix-scopes ]; then
  echo "==> VM scopes are read-only for storage; stopping the VM to widen them (a minute of downtime)"
  SA=$("${G[@]}" compute instances describe "$HK_VM" --zone "$HK_ZONE" --format='get(serviceAccounts[0].email)')
  "${G[@]}" compute instances stop "$HK_VM" --zone "$HK_ZONE"
  "${G[@]}" compute instances set-service-account "$HK_VM" --zone "$HK_ZONE" --service-account "$SA" --scopes=storage-rw,logging-write,monitoring-write
  "${G[@]}" compute instances start "$HK_VM" --zone "$HK_ZONE"
else echo "==> VM scopes are read-only for storage: backups to the bucket will fail. Re-run with --fix-scopes (stops the VM briefly)."; fi
SA=$("${G[@]}" compute instances describe "$HK_VM" --zone "$HK_ZONE" --format='get(serviceAccounts[0].email)')
gcloud storage buckets add-iam-policy-binding "gs://$HK_BUCKET" --project "$HK_PROJECT" --member "serviceAccount:$SA" --role roles/storage.objectAdmin >/dev/null
echo "Done. HK_BACKUP_BUCKET=gs://$HK_BUCKET/hearthkeeper"
