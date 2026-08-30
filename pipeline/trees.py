"""公園・樹林地の中に樹木を散布し、3Dで押し出すための樹冠ポリゴンを作る。

MapLibre には3Dモデルを置く機能が無いので、小さな多角形を樹冠に見立てて
fill-extrusion で持ち上げる。上から見ると緑の粒、斜めから見ると
こんもりした塊として読める。

使い方:
    uv run pipeline/trees.py data/build/landuse.geojsonl -o data/build/trees.geojsonl
"""

from __future__ import annotations

import argparse
import json
import math
import random
from pathlib import Path

from shapely.geometry import shape
from shapely.prepared import prep

# 区分ごとの散布密度(㎡あたり1本)と樹高の目安
PROFILE = {
    "forest": (110, 11.0, 5.4),  # 樹林地: 密で高い
    "park": (200, 9.0, 4.8),     # 公園: ほどほど
    "nature": (260, 6.5, 4.0),   # その他自然地: まばら
}
MAX_PER_POLYGON = 80
# 緯度35.65 付近での 1度あたりの距離(m)
DEG_LAT, DEG_LON = 111132.0, 90800.0


def canopy(lon: float, lat: float, radius_m: float, sides: int = 6) -> list[list[float]]:
    """樹冠に見立てた小さな正多角形。"""
    rx, ry = radius_m / DEG_LON, radius_m / DEG_LAT
    pts = [
        [
            round(lon + rx * math.cos(2 * math.pi * i / sides), 7),
            round(lat + ry * math.sin(2 * math.pi * i / sides), 7),
        ]
        for i in range(sides)
    ]
    return [*pts, pts[0]]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("landuse_geojsonl", type=Path)
    ap.add_argument("-o", "--output", type=Path, required=True)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    out: list[dict] = []

    with args.landuse_geojsonl.open() as fh:
        for line in fh:
            f = json.loads(line)
            kind = f["properties"]["kind"]
            prof = PROFILE.get(kind)
            if not prof:
                continue
            per_m2, height, radius = prof

            geom = shape(f["geometry"])
            if geom.is_empty or not geom.is_valid:
                geom = geom.buffer(0)
            area_m2 = geom.area * DEG_LAT * DEG_LON
            n = min(int(area_m2 / per_m2), MAX_PER_POLYGON)
            if n < 1:
                continue

            minx, miny, maxx, maxy = geom.bounds
            pg = prep(geom)
            placed = 0
            # 棄却サンプリング。細長い公園だと当たりにくいので試行回数を上限で切る
            for _ in range(n * 12):
                if placed >= n:
                    break
                x = rng.uniform(minx, maxx)
                y = rng.uniform(miny, maxy)
                from shapely.geometry import Point

                if not pg.contains(Point(x, y)):
                    continue
                placed += 1
                # 高さと色に揺らぎを与えて単調さを避ける
                h = round(height * rng.uniform(0.7, 1.3), 1)
                tone = rng.randint(0, 2)
                # 幹と樹冠を別フィーチャで出す。MapLibre は1レイヤに
                # 1つの押し出し高さしか持てないため、パーツごとに分ける
                out.append(
                    {
                        "type": "Feature",
                        "geometry": {
                            "type": "Polygon",
                            "coordinates": [canopy(x, y, radius * 0.42, sides=5)],
                        },
                        "properties": {"kind": kind, "part": "trunk", "h": h, "t": tone},
                    }
                )
                out.append(
                    {
                        "type": "Feature",
                        "geometry": {
                            "type": "Polygon",
                            "coordinates": [canopy(x, y, radius, sides=7)],
                        },
                        "properties": {"kind": kind, "part": "canopy", "h": h, "t": tone},
                    }
                )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w") as fh:
        for f in out:
            fh.write(json.dumps(f, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"出力: {args.output} ({len(out):,} 本)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
