#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
xcodebuild -version
derived_data="${FREEWRITE_DERIVED_DATA:-DerivedData}"
simulator_id=$(xcrun simctl list devices available --json | python3 -c '
import json, sys
runtimes = json.load(sys.stdin)["devices"]
for runtime in sorted(runtimes, reverse=True):
    if "iOS-26" not in runtime and "iOS-27" not in runtime:
        continue
    for device in runtimes[runtime]:
        if device.get("isAvailable") and device["name"].startswith("iPhone"):
            print(device["udid"])
            sys.exit(0)
sys.exit("Install an iOS 26 or newer simulator runtime in Xcode Settings > Components.")
')
# Keep ad-hoc simulator signing enabled: Keychain needs the generated application identity.
# This uses no Apple account or provisioning profile.
xcodebuild -project Freewrite.xcodeproj -scheme Freewrite -destination 'generic/platform=iOS Simulator' -derivedDataPath "$derived_data" CODE_SIGN_IDENTITY=- build
xcodebuild -project Freewrite.xcodeproj -scheme Freewrite -destination 'generic/platform=iOS' -configuration Release -derivedDataPath "$derived_data" CODE_SIGNING_ALLOWED=NO build
xcrun simctl bootstatus "$simulator_id" -b
xcodebuild -project Freewrite.xcodeproj -scheme Freewrite -parallel-testing-enabled NO -destination "platform=iOS Simulator,id=$simulator_id" -derivedDataPath "$derived_data" -resultBundlePath "TestResults-$(date +%Y%m%d-%H%M%S).xcresult" CODE_SIGN_IDENTITY=- test
