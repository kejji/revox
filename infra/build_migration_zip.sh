#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/migration"

# Install production dependencies
npm install --omit=dev

# Create the zip archive
zip -r ../migration.zip . -x "*.env" "node_modules/.cache/*"
