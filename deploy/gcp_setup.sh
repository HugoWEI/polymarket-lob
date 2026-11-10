#!/usr/bin/env bash
# One-time setup of the recorder on Google Cloud: a public-read bucket plus a
# small always-on VM running recorder.py under systemd.
#
#   PROJECT=my-project BUCKET=my-polymarket-lob ./deploy/gcp_setup.sh
#
# Optional: ZONE (default us-central1-a, where e2-micro is in the free tier),
#           MARKETS (default "top"; space-separated: top:3, long:3, a slug, or a token id)
set -euo pipefail
: "${PROJECT:?set PROJECT}" "${BUCKET:?set BUCKET}"
ZONE="${ZONE:-us-central1-a}"
REGION="${ZONE%-*}"
MARKETS="${MARKETS:-top}"
VM=polymarket-recorder
SA="lob-recorder@${PROJECT}.iam.gserviceaccount.com"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

gcloud config set project "$PROJECT"
gcloud services enable compute.googleapis.com storage.googleapis.com

# Bucket: readable by anyone (it only holds public market data), CORS open for the dashboard.
gcloud storage buckets create "gs://${BUCKET}" --location="$REGION" --uniform-bucket-level-access || true
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" --member=allUsers --role=roles/storage.objectViewer
printf '[{"origin":["*"],"method":["GET","HEAD"],"responseHeader":["Content-Type","Content-Encoding"],"maxAgeSeconds":300}]' > /tmp/lob-cors.json
gcloud storage buckets update "gs://${BUCKET}" --cors-file=/tmp/lob-cors.json

# Service account that may write only to this bucket.
gcloud iam service-accounts create lob-recorder --display-name="Polymarket recorder" || true
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" --member="serviceAccount:${SA}" --role=roles/storage.objectAdmin

gcloud compute instances create "$VM" --zone="$ZONE" --machine-type=e2-micro \
  --image-family=debian-12 --image-project=debian-cloud --boot-disk-size=30GB \
  --service-account="$SA" --scopes=cloud-platform || true

echo "Waiting for SSH…"; sleep 40
gcloud compute scp --zone="$ZONE" --recurse "$HERE/recorder" "$VM":~/
MARKET_ARGS=""; for m in $MARKETS; do MARKET_ARGS+=" --market $m"; done
gcloud compute ssh "$VM" --zone="$ZONE" --command "
set -e
sudo apt-get update -qq && sudo apt-get install -y -qq python3-venv
sudo mkdir -p /opt/lob && sudo cp -r ~/recorder/* /opt/lob/ && sudo chown -R \$USER /opt/lob
python3 -m venv /opt/lob/venv && /opt/lob/venv/bin/pip -q install -r /opt/lob/requirements.txt
/opt/lob/venv/bin/python /opt/lob/recorder.py --check ${MARKET_ARGS}
sudo tee /etc/systemd/system/lob-recorder.service >/dev/null <<UNIT
[Unit]
Description=Polymarket order book recorder
After=network-online.target
Wants=network-online.target
[Service]
User=\$USER
WorkingDirectory=/opt/lob
ExecStart=/opt/lob/venv/bin/python /opt/lob/recorder.py ${MARKET_ARGS} --out /opt/lob/data --bucket ${BUCKET}
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload && sudo systemctl enable lob-recorder && sudo systemctl restart lob-recorder
sleep 5 && sudo systemctl --no-pager status lob-recorder | head -12
"
echo
echo "Recorder running. In the dashboard, set Data source to:"
echo "  https://storage.googleapis.com/${BUCKET}"
