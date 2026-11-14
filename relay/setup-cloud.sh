#!/usr/bin/env bash
# One-time setup so GitHub can deploy the STARK platform to Firebase by itself.
set -euo pipefail
cd "$(dirname "$0")"
PID="stark-91dfe"
FB="npx -y firebase-tools@13.29.1"
GC="$(command -v gcloud || echo "$HOME/google-cloud-sdk/bin/gcloud")"
[ -x "$GC" ] || { echo "Google Cloud CLI (gcloud) not found. Install it from https://cloud.google.com/sdk/docs/install and run this again."; exit 1; }
SA="stark-deployer@$PID.iam.gserviceaccount.com"

echo "== 1/5  Sign in =="
$FB login
if ! "$GC" auth list --filter=status:ACTIVE --format="value(account)" | grep -q .; then "$GC" auth login; fi
"$GC" config set project "$PID" >/dev/null

echo "== 2/5  Turn on Firestore and sign-in services =="
"$GC" services enable firestore.googleapis.com identitytoolkit.googleapis.com firebasehosting.googleapis.com firebaserules.googleapis.com iam.googleapis.com --project "$PID"
"$GC" firestore databases describe --database="(default)" --project "$PID" >/dev/null 2>&1 \
  || "$GC" firestore databases create --location=eur3 --type=firestore-native --project "$PID"

echo "== 3/5  Web app settings for the platform =="
$FB hosting:sites:get "$PID" --project "$PID" >/dev/null 2>&1 || $FB hosting:sites:create "$PID" --project "$PID" || true
APP_ID="$($FB apps:list WEB --project "$PID" --json | python3 -c 'import sys,json;a=[x for x in json.load(sys.stdin).get("result",[])];print(a[0]["appId"] if a else "")')"
if [ -z "$APP_ID" ]; then
  $FB apps:create WEB "STARK Platform" --project "$PID" >/dev/null
  APP_ID="$($FB apps:list WEB --project "$PID" --json | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"][0]["appId"])')"
fi
$FB apps:sdkconfig WEB "$APP_ID" --project "$PID" --json \
  | python3 -c 'import sys,json;r=json.load(sys.stdin)["result"];c=r.get("sdkConfig",r);print("window.STARK_FB = "+json.dumps({k:c[k] for k in ["apiKey","authDomain","projectId","storageBucket","messagingSenderId","appId"] if k in c},indent=2)+";")' > firebase-config.js
echo "Saved firebase-config.js"

echo "== 4/5  Deploy account for GitHub =="
"$GC" iam service-accounts describe "$SA" --project "$PID" >/dev/null 2>&1 \
  || "$GC" iam service-accounts create stark-deployer --display-name="STARK GitHub deploy" --project "$PID"
for R in roles/firebase.admin roles/iam.serviceAccountUser roles/cloudfunctions.admin roles/run.admin \
         roles/secretmanager.admin roles/cloudbuild.builds.editor roles/artifactregistry.admin roles/serviceusage.serviceUsageConsumer; do
  "$GC" projects add-iam-policy-binding "$PID" --member="serviceAccount:$SA" --role="$R" --condition=None >/dev/null
done
KEY="$(mktemp)"
"$GC" iam service-accounts keys create "$KEY" --iam-account="$SA" --project "$PID"
pbcopy < "$KEY"; rm -f "$KEY"

echo "== 5/5  Two clicks left =="
cat <<MSG

 A) The deploy key is now in your clipboard.
    GitHub opens: name it  FIREBASE_SERVICE_ACCOUNT , paste with Cmd+V, then "Add secret".

 B) Firebase opens: click "Google", switch it on, choose your support email, Save.

MSG
open "https://github.com/tonkology/stark/settings/secrets/actions/new"
sleep 2
open "https://console.firebase.google.com/project/$PID/authentication/providers"
echo "Done. Tell Claude when A and B are finished."
