#!/bin/bash
# Fetch the latest w1euj.js from GitHub and deploy it
# Usage: sudo ./update-w1euj.sh [branch]

set -euo pipefail

REPO="ringof/ka9q-web"
BRANCH="${1:-main}"
DEST="/usr/local/share/ka9q-web/html/w1euj.js"
URL="https://raw.githubusercontent.com/${REPO}/${BRANCH}/w1euj.js"

# Fetch to a temp file first so a failed download doesn't clobber the existing copy
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

echo "Fetching w1euj.js from ${REPO}@${BRANCH}..."
if ! curl -fsSL -o "$tmp" "$URL"; then
    echo "Error: failed to download from $URL" >&2
    exit 1
fi

# Show what version we got
new_ver=$(grep -oP '@version\s+\K\S+' "$tmp" || echo "unknown")

if [ -f "$DEST" ]; then
    old_ver=$(grep -oP '@version\s+\K\S+' "$DEST" || echo "unknown")
    echo "Installed: v${old_ver} -> v${new_ver}"
else
    echo "Installing: v${new_ver} (new)"
fi

install -m 644 "$tmp" "$DEST"
echo "Deployed to $DEST"
