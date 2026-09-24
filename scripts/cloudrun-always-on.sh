#!/usr/bin/env bash
# Makes the Cloud Run service that runs Nexus Desk (e.g. the one AI Studio
# deployed) run around the clock, so the scanner and the position guardian
# keep working with the app closed:
#
#   - exactly one instance, always running (min = max = 1): one scanner, one
#     guardian, never two copies acting on the same positions
#   - CPU always allocated, so timers run between requests
#   - a Cloud Storage bucket mounted at /data for the state the server saves
#     (guardian positions, live-order records, desk settings, tracked setups)
#
# Usage:  scripts/cloudrun-always-on.sh SERVICE REGION [BUCKET]
# Needs:  gcloud, logged in (gcloud auth login) with the service's project
#         selected (gcloud config set project PROJECT_ID).
# Safe to run again, e.g. after AI Studio redeploys the app.

set -euo pipefail

SERVICE="${1:?Usage: $0 SERVICE REGION [BUCKET]}"
REGION="${2:?Usage: $0 SERVICE REGION [BUCKET]}"
PROJECT="$(gcloud config get-value project 2>/dev/null)"
[ -n "$PROJECT" ] || { echo "Select the project first: gcloud config set project PROJECT_ID" >&2; exit 1; }
BUCKET="${3:-${PROJECT}-nexus-desk-data}"
VOLUME="nexus-data"

echo "Project $PROJECT · service $SERVICE ($REGION) · bucket gs://$BUCKET"

# 1. The bucket for saved state.
if ! gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://$BUCKET" --location="$REGION" --uniform-bucket-level-access
fi

# 2. Let the service's runtime account read and write it.
SA="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(spec.template.spec.serviceAccountName)')"
if [ -z "$SA" ]; then
  SA="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')-compute@developer.gserviceaccount.com"
fi
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member="serviceAccount:$SA" --role=roles/storage.objectUser >/dev/null

# 3. Mount it at /data, unless it's already mounted.
VOLUME_FLAGS=()
if ! gcloud run services describe "$SERVICE" --region "$REGION" \
  --format='value(spec.template.spec.volumes[].name)' | tr ';,' '\n\n' | grep -qx "$VOLUME"; then
  VOLUME_FLAGS=(
    --add-volume="name=$VOLUME,type=cloud-storage,bucket=$BUCKET"
    --add-volume-mount="volume=$VOLUME,mount-path=/data"
  )
fi

# 4. One always-running instance with its CPU always on.
#    (Cloud Storage volumes need the second-generation environment; WebSocket
#    connections last up to the 60-minute request timeout, then reconnect.)
gcloud run services update "$SERVICE" --region "$REGION" \
  --min-instances=1 --max-instances=1 \
  --no-cpu-throttling --cpu=1 --memory=1Gi --cpu-boost \
  --execution-environment=gen2 --timeout=3600 \
  --update-env-vars=NEXUS_DATA_DIR=/data \
  ${VOLUME_FLAGS[@]+"${VOLUME_FLAGS[@]}"}

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
echo
echo "Done. Check: curl $URL/api/health"
echo "In the app: Settings → Server should show 'Saved state: Kept' and 'Running for' keep growing."
