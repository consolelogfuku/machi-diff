"""差分結果を集計してテキストレポートを出す。

A: 浸水想定区域での建て替え / D: 町丁目別の変化率
E: 用途の変化        / C: 防火構造の変化（不燃化）

使い方:
    uv run pipeline/report.py data/build/diff.geojsonl \
        --citygml data/raw/13112_setagaya-ku_pref_2025_citygml_1_op.zip
"""

from __future__ import annotations

import argparse
import json
import re
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

import pyarrow.parquet as pq
from shapely import from_wkt

ENTRY = re.compile(
    r"<gml:description>([^<]*)</gml:description>\s*<gml:name>([^<]*)</gml:name>"
)


def load_codelist(zip_path: Path, filename: str) -> dict[str, str]:
    """PLATEAU のコードリスト(gml:Dictionary)を コード -> 名称 の辞書にする。"""
    with zipfile.ZipFile(zip_path) as zf:
        hits = [n for n in zf.namelist() if n.endswith(filename)]
        if not hits:
            return {}
        text = zf.read(hits[0]).decode("utf-8", "replace")
    return {code: desc for desc, code in ENTRY.findall(text)}


def bar(n: int, total: int, width: int = 28) -> str:
    return "#" * int(width * n / total) if total else ""


def section(title: str) -> None:
    print(f"\n{'=' * 64}\n{title}\n{'=' * 64}")


def report_flood(rows: list[dict]) -> None:
    section("A. 浸水想定区域での建て替え")
    bands = [
        ("浸水なし", lambda d: d is None or d < 0.5),
        ("0.5-2m", lambda d: d is not None and 0.5 <= d < 2),
        ("2-3m", lambda d: d is not None and 2 <= d < 3),
        ("3m以上", lambda d: d is not None and d >= 3),
    ]
    print(f"{'浸水深':10} {'新築':>8} {'建て替え':>9} {'解体':>8} {'増改築':>8} {'計':>9}")
    print("-" * 64)
    for label, pred in bands:
        sub = [r for r in rows if pred(r.get("flood_depth"))]
        c = Counter(r["status"] for r in sub)
        print(
            f"{label:10} {c['new']:>8,} {c['rebuilt']:>9,} "
            f"{c['demolished']:>8,} {c['extended']:>8,} {len(sub):>9,}"
        )
    print("\n※ 浸水深は建物ごとの洪水浸水想定（最大値）。値が無い建物は「浸水なし」に含む")


def town_totals(parquet: Path, city: str) -> tuple[Counter, dict[str, list[float]]]:
    """町丁目ごとの総建物数（変化率の分母）と、代表点の座標。"""
    t = pq.read_table(parquet)
    towns = t.column("town").to_pylist()
    cities = t.column("city").to_pylist()
    wkts = t.column("footprint_wkt").to_pylist()

    totals: Counter = Counter()
    acc: dict[str, list[float]] = {}
    for i in range(t.num_rows):
        town = towns[i]
        if cities[i] != city or not town:
            continue
        totals[town] += 1
        if wkts[i]:
            c = from_wkt(wkts[i]).centroid
            a = acc.setdefault(town, [0.0, 0.0, 0.0])
            a[0] += c.x
            a[1] += c.y
            a[2] += 1
    centers = {k: [v[0] / v[2], v[1] / v[2]] for k, v in acc.items() if v[2]}
    return totals, centers


def rank_towns(rows: list[dict], totals: Counter, floor: int) -> list[dict]:
    """町丁目ごとの変化率ランキングを作る。"""
    tally: dict[str, Counter] = defaultdict(Counter)
    for r in rows:
        if r.get("town"):
            tally[r["town"]][r["status"]] += 1
    out = []
    for town, c in tally.items():
        total = totals.get(town, 0)
        if total < floor:
            continue
        changed = c["new"] + c["rebuilt"] + c["split"] + c["merge"]
        out.append(
            {
                "town": town.replace("東京都世田谷区", ""),
                "rate": round(changed / total * 100, 1),
                "total": total,
                **{k: c[k] for k in ("new", "rebuilt", "split", "merge", "demolished")},
            }
        )
    out.sort(key=lambda r: -r["rate"])
    return out


def report_towns(ranked: list[dict], top: int = 12) -> None:
    section(f"D. 町丁目別の変化率（上位{top}）")
    if not ranked:
        print("  対象がありません")
        return
    print(f"{'町丁目':16} {'変化率':>7} {'総棟数':>7} {'新築':>6} {'建替':>6} {'分割':>6}")
    print("-" * 68)
    for r in ranked[:top]:
        print(
            f"{r['town']:16} {r['rate']:>6.1f}% {r['total']:>7,} {r['new']:>6,} "
            f"{r['rebuilt']:>6,} {r['split']:>6,} "
            f"{bar(int(r['rate'] * 10), int(ranked[0]['rate'] * 10))}"
        )
    print("\n※ 変化率 = (新築+建替+分割+統合) ÷ 町丁目の総建物数")


def report_transition(
    rows: list[dict], field: str, codes: dict[str, str], title: str, top: int = 12
) -> None:
    section(title)
    trans = Counter()
    for r in rows:
        old = r.get(f"{field}_old")
        new = r.get(field)
        if old is not None and new is not None and old != new:
            trans[(str(old), str(new))] += 1
    if not trans:
        print("  変化した建物がありません")
        return
    total = sum(trans.values())
    print(f"変化した建物: {total:,} 棟\n")
    for (o, n), c in trans.most_common(top):
        lo = codes.get(o, f"コード{o}")
        ln = codes.get(n, f"コード{n}")
        print(f"  {lo:>16} → {ln:<16} {c:>6,} {bar(c, trans.most_common(1)[0][1])}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("diff_geojsonl", type=Path)
    ap.add_argument("--citygml", type=Path, required=True, help="コードリスト取得元のzip")
    ap.add_argument("--parquet", type=Path, required=True, help="新年度のParquet（分母用）")
    ap.add_argument("--city", default="13112")
    ap.add_argument("--floor", type=int, default=300, help="集計対象とする最小建物数")
    ap.add_argument("--json", type=Path, default=None, help="ランキングのJSON出力先")
    args = ap.parse_args()

    rows = []
    with args.diff_geojsonl.open() as fh:
        for line in fh:
            rows.append(json.loads(line)["properties"])
    print(f"読み込み: {len(rows):,} features（変化のあった建物のみ）")

    usage = load_codelist(args.citygml, "Building_usage.xml")
    fire = load_codelist(
        args.citygml, "BuildingDetailAttribute_fireproofStructureType.xml"
    )

    totals, centers = town_totals(args.parquet, args.city)
    ranked = rank_towns(rows, totals, args.floor)

    report_flood(rows)
    report_towns(ranked)

    if args.json:
        payload = [
            {**r, "center": centers.get("東京都世田谷区" + r["town"])} for r in ranked
        ]
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        )
        print(f"\nJSON出力: {args.json} ({len(payload)} 町丁目)")
    # E(用途変化)・C(防火構造変化) は実測の結果ほぼ「不明→実値」の
    # データ補完でしかなく、街の変化として意味を成さないため出力しない
    del usage, fire
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
