"""建物IDの非一致が「実際の建て替え」か「IDの振り直し」かを空間的に判定する。

compare_ids.py は ID の集合演算しかしないため、旧年度にしか無いIDを
すべて「解体」と数えてしまう。しかし同じ建物にIDが振り直されただけなら、
同じ場所に同じ形のフットプリントが新年度にも存在するはずである。
ここではそれをフットプリントの重なり(IoU)で確かめる。

使い方:
    uv run pipeline/verify_churn.py data/build/2023.parquet data/build/2025.parquet
"""

from __future__ import annotations

import argparse
import random
from pathlib import Path

import pyarrow.parquet as pq
from shapely import STRtree, from_wkt


def load(path: Path, city: str | None):
    t = pq.read_table(path)
    cols = {n: t.column(n).to_pylist() for n in t.column_names}
    rows = []
    for i in range(t.num_rows):
        if city and cols["city"][i] != city:
            continue
        if not cols["building_id"][i] or not cols["footprint_wkt"][i]:
            continue
        rows.append(
            {
                "building_id": cols["building_id"][i],
                "wkt": cols["footprint_wkt"][i],
                "measured_height": cols["measured_height"][i],
                "storeys_above_ground": cols["storeys_above_ground"][i],
            }
        )
    return rows


def iou(a, b) -> float:
    inter = a.intersection(b).area
    if inter == 0:
        return 0.0
    union = a.area + b.area - inter
    return inter / union if union else 0.0


def probe(sample, tree, targets, label: str) -> None:
    """sample の各建物について、相手年度で最も重なるフットプリントの IoU を測る。"""
    buckets = {"0.9以上": 0, "0.5-0.9": 0, "0.1-0.5": 0, "0.1未満": 0, "重なりなし": 0}
    for geom in sample:
        idx = tree.query(geom)
        if len(idx) == 0:
            buckets["重なりなし"] += 1
            continue
        best = max(iou(geom, targets[j]) for j in idx)
        if best >= 0.9:
            buckets["0.9以上"] += 1
        elif best >= 0.5:
            buckets["0.5-0.9"] += 1
        elif best >= 0.1:
            buckets["0.1-0.5"] += 1
        elif best > 0:
            buckets["0.1未満"] += 1
        else:
            buckets["重なりなし"] += 1

    n = len(sample)
    print(f"\n--- {label} (n={n:,}) ---")
    for k, v in buckets.items():
        bar = "#" * int(40 * v / n) if n else ""
        print(f"  IoU {k:10} {v:>6,} {v / n:>6.1%} {bar}")
    same = buckets["0.9以上"] + buckets["0.5-0.9"]
    print(f"  => 同一建物とみなせる (IoU>=0.5): {same:,} / {n:,} = {same / n:.1%}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("old_parquet", type=Path)
    ap.add_argument("new_parquet", type=Path)
    ap.add_argument("--city", default="13112")
    ap.add_argument("--sample", type=int, default=3000)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    city = None if args.city == "all" else args.city
    old_rows = load(args.old_parquet, city)
    new_rows = load(args.new_parquet, city)
    print(f"旧年度 {len(old_rows):,} 棟 / 新年度 {len(new_rows):,} 棟 (city={args.city})")

    old_ids = {r["building_id"] for r in old_rows}
    new_ids = {r["building_id"] for r in new_rows}
    only_old = [r for r in old_rows if r["building_id"] not in new_ids]
    only_new = [r for r in new_rows if r["building_id"] not in old_ids]
    print(f"旧のみ {len(only_old):,} 棟 / 新のみ {len(only_new):,} 棟")

    old_geoms = [from_wkt(r["wkt"]) for r in old_rows]
    new_geoms = [from_wkt(r["wkt"]) for r in new_rows]
    old_tree, new_tree = STRtree(old_geoms), STRtree(new_geoms)

    rng = random.Random(args.seed)
    s_old = rng.sample(only_old, min(args.sample, len(only_old)))
    s_new = rng.sample(only_new, min(args.sample, len(only_new)))

    probe([from_wkt(r["wkt"]) for r in s_old], new_tree, new_geoms,
          "旧のみのID → 新年度に同じ形があるか（あれば解体ではなくID振り直し）")
    probe([from_wkt(r["wkt"]) for r in s_new], old_tree, old_geoms,
          "新のみのID → 旧年度に同じ形があるか（あれば新築ではなくID振り直し）")

    # ID が一致した建物の高さ変化が実変化か測量差か
    old_by_id = {r["building_id"]: r for r in old_rows}
    deltas = []
    for r in new_rows:
        o = old_by_id.get(r["building_id"])
        if o and o["measured_height"] and r["measured_height"]:
            deltas.append(abs(r["measured_height"] - o["measured_height"]))
    if deltas:
        deltas.sort()
        n = len(deltas)
        print(f"\n--- ID一致した建物の高さ差の分布 (n={n:,}) ---")
        for thr in (0.0, 0.1, 0.5, 1.0, 3.0, 5.0):
            over = sum(1 for d in deltas if d > thr)
            print(f"  {thr:>4.1f}m 超の差       : {over:>7,} ({over / n:>5.1%})")
        print(f"  中央値 {deltas[n // 2]:.2f}m / 95%点 {deltas[int(n * 0.95)]:.2f}m")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
