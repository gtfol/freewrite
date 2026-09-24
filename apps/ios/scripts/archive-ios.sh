#!/bin/bash
set -euo pipefail

if [[ $# -gt 1 || (${1:-} != "" && ${1:-} != "--upload") ]]; then
  echo "Usage: scripts/archive-ios.sh [--upload]" >&2
  exit 2
fi

freewrite_root="$(cd "$(dirname "$0")/.." && pwd)"
freewrite_release="${FREEWRITE_RELEASE_DIR:-${TMPDIR:-/tmp}/freewrite-release}"
freewrite_team="${FREEWRITE_TEAM_ID:-J59ZSG67SJ}"
mkdir -p "$freewrite_release"

xcodebuild -project "$freewrite_root/Freewrite.xcodeproj" -scheme Freewrite \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$freewrite_release/Freewrite.xcarchive" \
  -derivedDataPath "$freewrite_release/DerivedData" \
  DEVELOPMENT_TEAM="$freewrite_team" -allowProvisioningUpdates archive

if [[ ${1:-} == "--upload" ]]; then
  python3 - "$freewrite_release/ExportOptions.plist" "$freewrite_team" <<'PY'
import plistlib
import sys
with open(sys.argv[1], "wb") as output:
    plistlib.dump({
        "method": "app-store-connect",
        "destination": "upload",
        "signingStyle": "automatic",
        "teamID": sys.argv[2],
        "manageAppVersionAndBuildNumber": False,
        "uploadSymbols": True,
        "testFlightInternalTestingOnly": True,
    }, output)
PY
  xcodebuild -exportArchive -archivePath "$freewrite_release/Freewrite.xcarchive" \
    -exportOptionsPlist "$freewrite_release/ExportOptions.plist" \
    -exportPath "$freewrite_release/Export" -allowProvisioningUpdates
fi
