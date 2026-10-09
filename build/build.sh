#!/usr/bin/env bash
# Regenerate data/ from the City of Winter DSL corpus and prove the round trip.
#
#   bash build/build.sh [<path to titterpig-dsl-city-of-winter/0.5>]
#
# parse (every token of every file consumed, or the parser raises) → build → verify both
# directions → node --check every data file. Any failure exits non-zero.
set -euo pipefail
cd "$(dirname "$0")/.."
CORPUS="${1:-$HOME/Sortilege/Campaigns/2026 Journey to the Winter City/city-of-winter/titterpig-dsl-city-of-winter/0.5}"

echo "--- build ($CORPUS)"
python3 build/build_data.py "$CORPUS"
echo "--- verify"
python3 build/verify_data.py "$CORPUS"
echo "--- syntax"
for f in data/*.js; do node --check "$f"; done
echo "build.sh: OK"
