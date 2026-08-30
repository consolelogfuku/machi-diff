#!/usr/bin/env bash
# 世田谷区の PLATEAU CityGML を2年度分ダウンロードする。
# curl -C - で再開可能。スリープ等で接続が切れてもストールを検知して自動再試行する。
set -euo pipefail

DEST="$(cd "$(dirname "$0")/.." && pwd)/data/raw"
mkdir -p "$DEST"

# 2023年度版 (v4, 983MB) / 2025年度版 (v5, 997MB)
URLS=(
  "https://assets.cms.plateau.reearth.io/assets/12/0da84e-e494-47c9-bb61-0f21892f4118/13112_setagaya-ku_pref_2023_citygml_2_op.zip"
  "https://assets.cms.plateau.reearth.io/assets/4d/e9ecc6-42d0-47ad-84a7-93d07c7766a8/13112_setagaya-ku_pref_2025_citygml_1_op.zip"
)

for url in "${URLS[@]}"; do
  echo "==> $(basename "$url")"
  curl -fL -C - \
    --retry 20 --retry-delay 5 --retry-all-errors \
    --speed-limit 10240 --speed-time 30 \
    --connect-timeout 30 \
    -o "$DEST/$(basename "$url")" "$url"
done

echo "==> 完了"
ls -lh "$DEST"
