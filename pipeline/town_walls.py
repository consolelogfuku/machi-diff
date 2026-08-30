"""町丁目の境界を、3Dで立ち上げるための細い帯ポリゴンに変換する。

地面に線を引くだけだと俯瞰視点で境目が読み取りにくいので、
境界に沿って薄い壁を立てて光らせる。MapLibre は線を押し出せないため、
線をバッファして帯状のポリゴンにしておく。

使い方:
    uv run pipeline/town_walls.py data/build/towns.geojsonl -o data/build/town-walls.geojsonl
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from shapely.geometry import mapping, shape

# 緯度35.65 付近で 1m 相当
DEG = 1 / 100000.0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("towns_geojsonl", type=Path)
    ap.add_argument("-o", "--output", type=Path, required=True)
    ap.add_argument("--width", type=float, default=1.6, help="壁の厚み(m)")
    args = ap.parse_args()

    half = args.width * DEG / 2
    out = []
    with args.towns_geojsonl.open() as fh:
        for line in fh:
            f = json.loads(line)
            geom = shape(f["geometry"])
            if geom.is_empty:
                continue
            # 外周線をバッファして帯にする。flat cap にすると角が尖るので round
            band = geom.boundary.buffer(half, cap_style=1, join_style=1)
            if band.is_empty:
                continue
            out.append(
                {
                    "type": "Feature",
                    "geometry": mapping(band),
                    "properties": {"town": f["properties"]["town"]},
                }
            )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w") as fh:
        for f in out:
            fh.write(json.dumps(f, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"出力: {args.output} ({len(out):,} 町丁目)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
