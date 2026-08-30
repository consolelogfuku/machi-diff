"""PLATEAU の CityGML(zip) から建築物モデルを抽出し Parquet に落とす。

zip を展開せずストリームで読むため、数GBの一時ファイルを作らない。
PLATEAU はバージョンごとに名前空間URIが変わる（uro/2.0, 3.0 など）ので、
名前空間を決め打ちせずローカル名で突き合わせている。

使い方:
    uv run pipeline/extract.py data/raw/xxx_citygml.zip -o data/build/2023.parquet
    uv run pipeline/extract.py data/raw/xxx_citygml.zip -o /tmp/smoke.parquet --max-files 1
"""

from __future__ import annotations

import argparse
import re
import sys
import time
import zipfile
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
from lxml import etree

# 建物1件から拾う属性。CityGML のローカル名 -> 出力カラム名
SCALAR_FIELDS = {
    # bldg:Building 直下
    "class": "building_class",
    "usage": "usage",
    "measuredHeight": "measured_height",
    "storeysAboveGround": "storeys_above_ground",
    "storeysBelowGround": "storeys_below_ground",
    "creationDate": "creation_date",
    # uro:BuildingIDAttribute
    "buildingID": "building_id",
    "prefecture": "prefecture",
    "city": "city",
    # uro:BuildingDetailAttribute
    "buildingRoofEdgeArea": "roof_edge_area",
    "detailedUsage": "detailed_usage",
    "fireproofStructureType": "fireproof_structure_type",
    "landUseType": "land_use_type",
    "surveyYear": "survey_year",
}
# 注意: yearOfConstruction / totalFloorArea / buildingStructureType は
# 世田谷区(2023年度版)のデータには存在しない。建築年は取得できない。

# フットプリントの取得元。左から順に探す
FOOTPRINT_SOURCES = ("lod0RoofEdge", "lod0FootPrint", "lod1Solid")

FLOAT_COLS = {
    "measured_height",
    "roof_edge_area",
    "flood_depth",
}
INT_COLS = {"storeys_above_ground", "storeys_below_ground"}

# PLATEAU は「不明」を数値のマジックナンバーで表す。そのまま通すと
# 高さ -9999m の建物が生まれ、年度間の差分で高さ変化を誤検出する。
SENTINELS = {-9999.0, 9999.0, -9999, 9999}
SENTINEL_STRINGS = {"0001", "-9999", "9999"}


def localname(tag: object) -> str:
    """{ns}Foo -> Foo。コメントノード等は空文字を返す。"""
    if not isinstance(tag, str):
        return ""
    return tag.rsplit("}", 1)[-1]


def parse_poslist(text: str) -> list[tuple[float, float]]:
    """gml:posList をパースして (経度, 緯度) のリストにする。

    PLATEAU の CityGML は EPSG:6697 で、posList は「緯度 経度 標高」の順。
    GeoJSON/MVT は経度が先なので、ここで入れ替える。
    """
    nums = [float(v) for v in text.split()]
    if len(nums) % 3 == 0:
        triples = zip(nums[0::3], nums[1::3])  # (lat, lon)
    elif len(nums) % 2 == 0:
        triples = zip(nums[0::2], nums[1::2])
    else:
        return []
    return [(lon, lat) for lat, lon in triples]


def ring_to_wkt(coords: list[tuple[float, float]]) -> str | None:
    if len(coords) < 4:
        return None
    if coords[0] != coords[-1]:
        coords = [*coords, coords[0]]
    body = ", ".join(f"{lon:.9f} {lat:.9f}" for lon, lat in coords)
    return f"POLYGON (({body}))"


def extract_footprint(building: etree._Element) -> str | None:
    """建物のフットプリントを WKT で返す。見つからなければ None。"""
    for source in FOOTPRINT_SOURCES:
        for child in building.iter():
            if localname(child.tag) != source:
                continue
            for node in child.iter():
                if localname(node.tag) == "posList" and node.text:
                    wkt = ring_to_wkt(parse_poslist(node.text))
                    if wkt:
                        return wkt
    return None


def extract_flood_risk(building: etree._Element) -> tuple[float | None, str | None]:
    """洪水浸水リスクのうち最も深いものを返す。

    1棟に複数の RiverFloodingRiskAttribute（計画規模・想定最大規模など）が
    ぶら下がるため、最初の1件ではなく最大浸水深を採用する。
    """
    best_depth: float | None = None
    best_rank: str | None = None
    for node in building.iter():
        if localname(node.tag) != "RiverFloodingRiskAttribute":
            continue
        depth = rank = None
        for child in node.iter():
            ln = localname(child.tag)
            if ln == "depth" and child.text:
                try:
                    depth = float(child.text)
                except ValueError:
                    depth = None
            elif ln == "rank" and child.text:
                rank = child.text.strip()
        if depth is not None and (best_depth is None or depth > best_depth):
            best_depth, best_rank = depth, rank
    return best_depth, best_rank


def extract_town(building: etree._Element) -> str | None:
    """住所の町丁目名。番地・号は元データに無い。"""
    for node in building.iter():
        if localname(node.tag) == "LocalityName" and node.text:
            return node.text.strip()
    return None


def extract_building(building: etree._Element) -> dict[str, object]:
    """建物要素から属性を1件分抜き出す。同名要素は最初に出たものを採用する。"""
    row: dict[str, object] = {
        "gml_id": building.get("{http://www.opengis.net/gml}id"),
    }
    for node in building.iter():
        col = SCALAR_FIELDS.get(localname(node.tag))
        if col and col not in row and node.text and node.text.strip():
            text = node.text.strip()
            if text not in SENTINEL_STRINGS:
                row[col] = text
    row["footprint_wkt"] = extract_footprint(building)
    row["flood_depth"], row["flood_rank"] = extract_flood_risk(building)
    row["town"] = extract_town(building)
    return row


def iter_buildings(fh):
    """建物要素をストリームで1件ずつ返し、読み終えたノードは即座に解放する。"""
    context = etree.iterparse(fh, events=("end",), huge_tree=True, recover=True)
    for _, elem in context:
        if localname(elem.tag) == "Building":
            yield elem
            elem.clear()
            # 解放済みの兄弟ノードも消さないとメモリが積み上がる
            parent = elem.getparent()
            if parent is not None:
                while elem.getprevious() is not None:
                    del parent[0]


def coerce(rows: list[dict[str, object]]) -> dict[str, list]:
    """全行のカラムを揃え、数値カラムを型変換する。"""
    columns = [
        "gml_id",
        *SCALAR_FIELDS.values(),
        "flood_depth",
        "flood_rank",
        "town",
        "footprint_wkt",
        "src_file",
    ]
    out: dict[str, list] = {c: [] for c in columns}
    for row in rows:
        for c in columns:
            value = row.get(c)
            if value is not None and c in FLOAT_COLS:
                try:
                    value = float(value)
                except ValueError:
                    value = None
                if value in SENTINELS:
                    value = None
            elif value is not None and c in INT_COLS:
                try:
                    value = int(float(value))
                except ValueError:
                    value = None
                if value in SENTINELS:
                    value = None
            out[c].append(value)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("zip_path", type=Path)
    ap.add_argument("-o", "--output", type=Path, required=True)
    ap.add_argument(
        "--max-files",
        type=int,
        default=None,
        help="処理する gml ファイル数の上限。動作確認用",
    )
    ap.add_argument(
        "--match",
        default=None,
        help="gml ファイル名の部分一致フィルタ。動作確認用",
    )
    args = ap.parse_args()

    if not args.zip_path.exists():
        print(f"エラー: {args.zip_path} がありません", file=sys.stderr)
        return 1

    started = time.monotonic()
    rows: list[dict[str, object]] = []

    with zipfile.ZipFile(args.zip_path) as zf:
        # udx/bldg 配下の建築物モデルだけを対象にする
        members = sorted(
            n
            for n in zf.namelist()
            if re.search(r"(^|/)udx/bldg/.*\.gml$", n, re.IGNORECASE)
        )
        if args.match:
            members = [n for n in members if args.match in n]
        if args.max_files:
            members = members[: args.max_files]

        if not members:
            print("エラー: udx/bldg 配下の gml が見つかりません", file=sys.stderr)
            print("zip 内の構成:", file=sys.stderr)
            for n in zf.namelist()[:30]:
                print(f"  {n}", file=sys.stderr)
            return 1

        print(f"対象 gml: {len(members)} ファイル")
        for i, name in enumerate(members, 1):
            before = len(rows)
            with zf.open(name) as fh:
                for building in iter_buildings(fh):
                    row = extract_building(building)
                    row["src_file"] = Path(name).name
                    rows.append(row)
            print(
                f"  [{i}/{len(members)}] {Path(name).name}: "
                f"{len(rows) - before} 棟 (累計 {len(rows)})",
                flush=True,
            )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.table(coerce(rows)), args.output, compression="zstd")

    elapsed = time.monotonic() - started
    size_mb = args.output.stat().st_size / 1024 / 1024
    with_id = sum(1 for r in rows if r.get("building_id"))
    with_fp = sum(1 for r in rows if r.get("footprint_wkt"))
    print(f"\n書き出し: {args.output} ({size_mb:.1f} MB, {elapsed:.1f}s)")
    print(f"  建物数         : {len(rows):,}")
    print(f"  建物ID あり    : {with_id:,} ({with_id / max(len(rows), 1):.1%})")
    print(f"  フットプリント : {with_fp:,} ({with_fp / max(len(rows), 1):.1%})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
