#!/bin/sh
# Builds the release APK and publishes it to the htv server, which then offers it to
# installed apps as an update (Install update in the app's header).
#
#   ./publish.sh <ssh host> [container]      e.g. ./publish.sh mfan@zimaboard
#
# The server's data folder (htv-data/) belongs to root because Docker created it, so
# the files go in through `docker cp` rather than straight into the folder.
set -e
host="$1"
container="${2:-htv-server}"
[ -n "$host" ] || { echo "usage: $0 <ssh host> [container]" >&2; exit 1; }

cd "$(dirname "$0")"
./gradlew assembleRelease --console=plain -q
out=app/build/outputs/apk/release
tmp=$(ssh "$host" mktemp -d)
scp -q "$out/app-release.apk" "$out/output-metadata.json" "$host:$tmp/"
ssh "$host" "docker exec $container mkdir -p /data/androidtv \
  && docker cp $tmp/app-release.apk $container:/data/androidtv/ \
  && docker cp $tmp/output-metadata.json $container:/data/androidtv/ \
  && rm -r $tmp"
echo "published versionCode $(sed -n 's/.*"versionCode": *\([0-9]*\).*/\1/p' "$out/output-metadata.json")"
