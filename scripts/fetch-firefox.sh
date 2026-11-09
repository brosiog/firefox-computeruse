#!/usr/bin/env bash
# Downloads a pinned Firefox release for Linux x86_64 into e2e/.cache/firefox (where pnpm e2e / e2e:bridge / bench
# look by default) and verifies it against Mozilla's published SHA256SUMS.
#
#   scripts/fetch-firefox.sh [version]     (default: $FIREFOX_VERSION, else the version pinned below)
set -euo pipefail

version="${1:-${FIREFOX_VERSION:-159.0.1}}"
root="$(cd "$(dirname "$0")/.." && pwd)"
dest="$root/e2e/.cache"
base="https://archive.mozilla.org/pub/firefox/releases/$version"
file="firefox-$version.tar.xz"
rel="linux-x86_64/en-US/$file"

if [ -x "$dest/firefox/firefox" ] && "$dest/firefox/firefox" --version 2>/dev/null | grep -qF " $version"; then
  echo "Firefox $version already in $dest/firefox"
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
echo "Downloading Firefox $version"
curl -fsSL --retry 3 --retry-delay 5 -o "$tmp/$file" "$base/$rel"
curl -fsSL --retry 3 --retry-delay 5 -o "$tmp/SHA256SUMS" "$base/SHA256SUMS"
want="$(awk -v f="$rel" '$2 == f { print $1 }' "$tmp/SHA256SUMS")"
[ -n "$want" ] || { echo "no checksum for $rel in SHA256SUMS" >&2; exit 1; }
echo "$want  $tmp/$file" | sha256sum -c -

rm -rf "$dest/firefox"
mkdir -p "$dest"
tar -xJf "$tmp/$file" -C "$dest"
"$dest/firefox/firefox" --version
