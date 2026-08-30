"""国勢調査の町丁・字等別境界データから、対象自治体の境界線を切り出す。

3Dマップ上で「どこからどこまでが何丁目か」を示すために使う。
建物の分布から推定するのではなく、統計局の公式境界を使う。

出典: 令和2年国勢調査 町丁・字等別境界データ（総務省統計局）

使い方:
    uv run pipeline/extract_boundary.py data/raw/estat_town_boundary_13.zip \
        -o data/build/towns.geojsonl --city 13112
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import geopandas as gpd


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("zip_path", type=Path)
    ap.add_argument("-o", "--output", type=Path, required=True)
    ap.add_argument("--city", default="13112", help="5桁の自治体コード")
    args = ap.parse_args()

    gdf = gpd.read_file(f"zip://{args.zip_path}")
    print(f"読み込み: {len(gdf):,} 件 / CRS={gdf.crs}")

    # KEY_CODE の先頭5桁が自治体コード
    key = "KEY_CODE" if "KEY_CODE" in gdf.columns else gdf.columns[0]
    sub = gdf[gdf[key].astype(str).str.startswith(args.city)].copy()
    print(f"{args.city} の小地域: {len(sub):,} 件")

    # 建物データと同じ WGS84 に揃える
    if sub.crs and sub.crs.to_epsg() != 4326:
        sub = sub.to_crs(4326)

    # 同じ町丁目が基本単位区に分かれているので束ねる
    name_col = "S_NAME" if "S_NAME" in sub.columns else None
    if name_col:
        sub = sub.dissolve(by=name_col, as_index=False)

    # 隣接する町丁目が同じ色にならないように彩色する。
    # 線を引くより塗り分けたほうが領域の広がりが読み取れる
    sub = sub.reset_index(drop=True)
    geoms = list(sub.geometry)
    neighbors: list[set[int]] = [set() for _ in geoms]
    sindex = sub.sindex
    for i, g in enumerate(geoms):
        if g is None or g.is_empty:
            continue
        for j in sindex.query(g.buffer(0.00002)):
            j = int(j)
            if j != i and geoms[j] is not None and g.buffer(0.00002).intersects(geoms[j]):
                neighbors[i].add(j)
                neighbors[j].add(i)

    # 次数の大きい順に貪欲彩色（Welsh-Powell）。多くても6色で収まる
    palette_size = 6
    color_of: dict[int, int] = {}
    for i in sorted(range(len(geoms)), key=lambda k: -len(neighbors[k])):
        used = {color_of[j] for j in neighbors[i] if j in color_of}
        color_of[i] = next(
            (c for c in range(palette_size) if c not in used), 0
        )
    print(f"彩色: {len(set(color_of.values()))} 色")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    with args.output.open("w") as fh:
        for idx, row in sub.iterrows():
            geom = row.geometry
            if geom is None or geom.is_empty:
                continue
            # 頂点が細かすぎるとタイルが重くなる。約1m相当で間引く
            geom = geom.simplify(0.00001, preserve_topology=True)
            fh.write(
                json.dumps(
                    {
                        "type": "Feature",
                        "geometry": json.loads(gpd.GeoSeries([geom]).to_json())[
                            "features"
                        ][0]["geometry"],
                        "properties": {
                            "town": row.get(name_col) if name_col else "",
                            "c": color_of.get(int(idx), 0),
                        },
                    },
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
                + "\n"
            )
            written += 1
    print(f"出力: {args.output} ({written:,} 町丁目)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
