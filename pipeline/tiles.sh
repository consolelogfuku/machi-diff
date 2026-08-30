#!/usr/bin/env bash
# 差分結果(GeoJSON ndjson)を PMTiles に焼く。
# 建物フットプリントは高ズームでないと意味を成さないので z17 まで作る。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IN="${1:-$ROOT/data/build/diff.geojsonl}"
OUT="${2:-$ROOT/data/build/diff.pmtiles}"

tippecanoe \
  --output="$OUT" --force \
  --layer=changes \
  --minimum-zoom=11 --maximum-zoom=17 \
  --drop-densest-as-needed \
  --extend-zooms-if-still-dropping \
  --no-tile-size-limit \
  "$IN"

ls -lh "$OUT"
