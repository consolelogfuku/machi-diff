"""PLATEAU の土地利用モデル(luse)から、地面の彩色に使う区分を抽出する。

ゲーム的な見た目にするための下地。公園・緑地・樹林地・水面などを
色分けして敷くことで、建物だけが浮いている状態を避ける。

使い方:
    uv run pipeline/extract_landuse.py data/raw/xxx_citygml.zip -o data/build/landuse.geojsonl
"""

from __future__ import annotations

import argparse
import json
import re
import zipfile
from collections import Counter
from pathlib import Path

from lxml import etree

from extract import localname, parse_poslist, ring_to_wkt  # noqa: F401

# 地面の色分けに使う区分だけ残す。市街地(211等)は建物で埋まるので不要
KEEP = {
    "201": "paddy",     # 田
    "202": "farm",      # 畑・樹園地
    "203": "forest",    # 山林・樹林地
    "204": "water",     # 水面
    "205": "nature",    # その他自然地
    "217": "park",      # 公園・緑地・広場・運動場・墓園
    "224": "vacant",    # 低未利用土地（空地）
}


def ring_coords(node: etree._Element) -> list[list[float]] | None:
    for child in node.iter():
        if localname(child.tag) == "posList" and child.text:
            pts = parse_poslist(child.text)
            if len(pts) >= 4:
                if pts[0] != pts[-1]:
                    pts = [*pts, pts[0]]
                return [[round(x, 7), round(y, 7)] for x, y in pts]
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("zip_path", type=Path)
    ap.add_argument("-o", "--output", type=Path, required=True)
    args = ap.parse_args()

    rows: list[dict] = []
    stats: Counter[str] = Counter()

    with zipfile.ZipFile(args.zip_path) as zf:
        members = sorted(
            n for n in zf.namelist() if re.search(r"(^|/)udx/luse/.*\.gml$", n, re.I)
        )
        print(f"対象 gml: {len(members)} ファイル")
        for i, name in enumerate(members, 1):
            before = len(rows)
            with zf.open(name) as fh:
                ctx = etree.iterparse(fh, events=("end",), huge_tree=True, recover=True)
                for _, elem in ctx:
                    if localname(elem.tag) != "LandUse":
                        continue
                    code = None
                    for child in elem.iter():
                        if localname(child.tag) == "class" and child.text:
                            code = child.text.strip()
                            break
                    kind = KEEP.get(code or "")
                    if kind:
                        coords = ring_coords(elem)
                        if coords:
                            stats[kind] += 1
                            rows.append(
                                {
                                    "type": "Feature",
                                    "geometry": {
                                        "type": "Polygon",
                                        "coordinates": [coords],
                                    },
                                    "properties": {"kind": kind},
                                }
                            )
                    elem.clear()
                    parent = elem.getparent()
                    if parent is not None:
                        while elem.getprevious() is not None:
                            del parent[0]
            print(f"  [{i}/{len(members)}] {Path(name).name}: +{len(rows) - before}", flush=True)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w") as fh:
        for r in rows:
            fh.write(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(f"\n出力: {args.output} ({len(rows):,} features)")
    for k, v in stats.most_common():
        print(f"  {k:8} {v:,}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
