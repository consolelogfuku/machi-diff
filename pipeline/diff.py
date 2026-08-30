"""2年度分の建物データを突き合わせ、街の変化を5分類して GeoJSON(ndjson) に出す。

建物IDは年度をまたいで安定していない（実測で「消えたID」の41.5%が
新年度に同じ形で存在する＝IDの振り直し）。そのため ID join だけでは
偽の解体/新築が大量に出る。ID で照合できなかった建物どうしを
フットプリントの重なり(IoU)で突き合わせ直すのがこのスクリプトの主眼。

分類:
    unchanged  変化なし（ID一致で属性も同じ／ID振り直しだが同じ形）
    extended   増改築（同一建物で階数か高さが変わった）
    rebuilt    建て替え（同じ敷地に違う形の建物、1対1）
    split      分割（1棟が2棟以上になった。敷地の細分化）
    merge      統合（2棟以上が1棟になった）
    redevelop  再開発（複数棟が複数棟に組み替わった）
    demolished 解体（新年度に対応する建物がない）
    new        新築（旧年度に対応する建物がない）

使い方:
    uv run pipeline/diff.py data/build/2023.parquet data/build/2025.parquet \
        -o data/build/diff.geojsonl
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

import pyarrow.parquet as pq
from shapely import STRtree, from_wkt
from shapely.geometry import mapping

# 出力は3つに畳む。棟数の数え方で建て替え/分割/統合を呼び分けても、
# 元データからは物理的に何が起きたか判定できないため、
# 「消えた・あらわれた・変わった」という観測だけを表に出す
SIMPLE = {
    "demolished": "gone",
    "new": "appeared",
    "rebuilt": "changed",
    "split": "changed",
    "merge": "changed",
    "redevelop": "changed",
    "extended": "changed",
    "unchanged": "unchanged",
}

KEEP_ATTRS = (
    "usage",
    "detailed_usage",
    "measured_height",
    "storeys_above_ground",
    "fireproof_structure_type",
    "flood_depth",
    "flood_rank",
    "town",
)
# 新旧を比べたい属性。旧年度の値を *_old として持たせる
PAIRED_ATTRS = ("usage", "detailed_usage", "fireproof_structure_type")


def load(path: Path, city: str | None) -> list[dict]:
    t = pq.read_table(path)
    cols = {n: t.column(n).to_pylist() for n in t.column_names}
    rows = []
    for i in range(t.num_rows):
        if city and cols["city"][i] != city:
            continue
        if not cols["building_id"][i] or not cols["footprint_wkt"][i]:
            continue
        rows.append({k: cols[k][i] for k in cols})
    return rows


def iou(a, b) -> float:
    inter = a.intersection(b).area
    if inter == 0:
        return 0.0
    union = a.area + b.area - inter
    return inter / union if union else 0.0


def is_extended(old: dict, new: dict, height_tol: float) -> bool:
    """同一建物とみなせるペアで、実際に増改築があったか。

    片方が欠測(None)のケースは「変化」に数えない。データの有無が
    年度で変わっただけで建物は動いていないため。
    """
    so, sn = old["storeys_above_ground"], new["storeys_above_ground"]
    if so is not None and sn is not None and so != sn:
        return True
    ho, hn = old["measured_height"], new["measured_height"]
    if ho is not None and hn is not None and abs(hn - ho) > height_tol:
        return True
    return False


def feature(geom, status: str, old: dict | None, new: dict | None, score: float | None) -> dict:
    src = new or old
    props: dict[str, object] = {
        "status": SIMPLE[status],
        "building_id": src["building_id"],
    }
    for k in KEEP_ATTRS:
        props[k] = src[k]
    if old and new:
        for k in PAIRED_ATTRS:
            if old[k] != new[k]:
                props[f"{k}_old"] = old[k]
        props["height_old"] = old["measured_height"]
        props["height_new"] = new["measured_height"]
        props["storeys_old"] = old["storeys_above_ground"]
        props["storeys_new"] = new["storeys_above_ground"]
    if score is not None:
        props["iou"] = round(score, 3)
    return {"type": "Feature", "geometry": mapping(geom), "properties": props}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("old_parquet", type=Path)
    ap.add_argument("new_parquet", type=Path)
    ap.add_argument("-o", "--output", type=Path, required=True)
    ap.add_argument("--city", default="13112", help="対象自治体コード。all で絞らない")
    ap.add_argument(
        "--iou-same",
        type=float,
        default=0.5,
        help="これ以上重なれば同一建物（IDの振り直し）とみなす",
    )
    ap.add_argument(
        "--iou-rebuild",
        type=float,
        default=0.1,
        help="これ以上 iou-same 未満なら同じ敷地の建て替えとみなす",
    )
    ap.add_argument(
        "--height-tol", type=float, default=1.0, help="増改築とみなす高さ差(m)"
    )
    ap.add_argument(
        "--link-ratio",
        type=float,
        default=0.5,
        help="重なりが小さい側の面積のこの割合を超えたら同一敷地として連結する",
    )
    ap.add_argument(
        "--output-3d",
        type=Path,
        default=None,
        help="両年度の輪郭を year 付きで出力する（3D表示用）",
    )
    ap.add_argument(
        "--round-corners",
        type=float,
        default=0.0,
        help="3D出力のフットプリントの角を丸める半径(m)。0で無効",
    )
    ap.add_argument(
        "--all-buildings",
        action="store_true",
        help="3D出力に変化のない建物も含める（街として見せるために必要）",
    )
    ap.add_argument(
        "--include-unchanged",
        action="store_true",
        help="変化なしの建物も出力する（背景表示用。タイルは大きくなる）",
    )
    args = ap.parse_args()

    city = None if args.city == "all" else args.city
    old_rows = load(args.old_parquet, city)
    new_rows = load(args.new_parquet, city)
    print(f"旧年度 {len(old_rows):,} 棟 / 新年度 {len(new_rows):,} 棟 (city={args.city})")

    for rows in (old_rows, new_rows):
        for r in rows:
            r["geom"] = from_wkt(r["footprint_wkt"])

    new_by_id = {r["building_id"]: r for r in new_rows}
    old_by_id = {r["building_id"]: r for r in old_rows}

    features: list[dict] = []
    stats: Counter[str] = Counter()
    # 3D表示用。変化に関与した建物を年度別に集める
    involved_old: dict[str, str] = {}
    involved_new: dict[str, str] = {}

    def mark(status: str, olds: list[dict], news: list[dict]) -> None:
        if status == "unchanged":
            return
        for r in olds:
            involved_old[r["building_id"]] = status
        for r in news:
            involved_new[r["building_id"]] = status

    def emit(geom, status, old, new, score=None):
        stats[status] += 1
        if status == "unchanged" and not args.include_unchanged:
            return
        features.append(feature(geom, status, old, new, score))

    # 1) ID が一致した建物
    for bid, new in new_by_id.items():
        old = old_by_id.get(bid)
        if old is None:
            continue
        status = "extended" if is_extended(old, new, args.height_tol) else "unchanged"
        mark(status, [old], [new])
        emit(new["geom"], status, old, new)

    # 2) ID で照合できなかった建物どうしを IoU で突き合わせる
    only_old = [r for r in old_rows if r["building_id"] not in new_by_id]
    only_new = [r for r in new_rows if r["building_id"] not in old_by_id]
    print(f"ID未照合: 旧 {len(only_old):,} 棟 / 新 {len(only_new):,} 棟 → IoUで再照合")

    new_geoms = [r["geom"] for r in only_new]
    tree = STRtree(new_geoms)

    # 旧と新を「同じ敷地」で連結する。IoU ではなく小さい側の面積に対する
    # 被覆率で判定する。1棟が2棟に分割されると IoU は 0.3 程度まで落ちるが、
    # 新しい各棟は旧棟にほぼ収まるため被覆率なら拾える
    links: list[tuple[int, int, float]] = []
    for i, o in enumerate(only_old):
        for j in tree.query(o["geom"]):
            j = int(j)
            inter = o["geom"].intersection(new_geoms[j]).area
            if inter == 0:
                continue
            smaller = min(o["geom"].area, new_geoms[j].area)
            if smaller and inter / smaller >= args.link_ratio:
                links.append((i, j, iou(o["geom"], new_geoms[j])))

    # 連結成分を求める（Union-Find）。旧は i、新は len(only_old)+j で表す
    parent = list(range(len(only_old) + len(only_new)))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    offset = len(only_old)
    for i, j, _ in links:
        union(i, offset + j)

    groups: dict[int, tuple[list[int], list[int]]] = {}
    for i in range(len(only_old)):
        groups.setdefault(find(i), ([], []))[0].append(i)
    for j in range(len(only_new)):
        groups.setdefault(find(offset + j), ([], []))[1].append(j)

    iou_by_pair = {(i, j): v for i, j, v in links}

    for olds, news in groups.values():
        if not news:
            mark("demolished", [only_old[i] for i in olds], [])
            for i in olds:
                emit(only_old[i]["geom"], "demolished", only_old[i], None)
            continue
        if not olds:
            mark("new", [], [only_new[j] for j in news])
            for j in news:
                emit(only_new[j]["geom"], "new", None, only_new[j])
            continue
        if len(olds) == 1 and len(news) == 1:
            o, n = only_old[olds[0]], only_new[news[0]]
            score = iou_by_pair.get((olds[0], news[0]), 0.0)
            if score >= args.iou_same:
                status = (
                    "extended" if is_extended(o, n, args.height_tol) else "unchanged"
                )
            else:
                status = "rebuilt"
            mark(status, [o], [n])
            emit(n["geom"], status, o, n, score)
            continue
        # 複数棟が絡むケース
        if len(olds) == 1:
            status = "split"
        elif len(news) == 1:
            status = "merge"
        else:
            status = "redevelop"
        mark(status, [only_old[i] for i in olds], [only_new[j] for j in news])
        for j in news:
            emit(only_new[j]["geom"], status, only_old[olds[0]], only_new[j])

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w") as fh:
        for f in features:
            fh.write(json.dumps(f, ensure_ascii=False, separators=(",", ":")) + "\n")

    if args.output_3d:
        # 角を丸める。負のバッファで縮めてから同じだけ膨らませると
        # 出隅が丸くなる。真四角が並ぶと硬く見えるのを和らげるため
        radius_deg = args.round_corners / 100000.0 if args.round_corners else 0.0

        # 測量由来の微細な頂点を落としてから丸める。
        # 数十cmのギザギザが残っていると、角を丸めても輪郭は荒いまま
        simplify_deg = radius_deg * 0.6

        def soften(g):
            if not radius_deg:
                return g
            base = g.simplify(simplify_deg, preserve_topology=True)
            if base.is_empty or base.geom_type != "Polygon":
                base = g
            r = base.buffer(-radius_deg, quad_segs=3, join_style=1)
            if r.is_empty:
                return base
            r = r.buffer(radius_deg, quad_segs=3, join_style=1)
            return r if not r.is_empty and r.geom_type == "Polygon" else base

        rows3d = []
        for src, involved, year in (
            (old_rows, involved_old, 2023),
            (new_rows, involved_new, 2025),
        ):
            for r in src:
                status = involved.get(r["building_id"])
                if not status:
                    if not args.all_buildings:
                        continue
                    status = "unchanged"
                rows3d.append(
                    {
                        "type": "Feature",
                        "geometry": mapping(soften(r["geom"])),
                        "properties": {
                            "year": year,
                            "status": SIMPLE[status],
                            # 高さ欠測の建物は LOD1 の既定値として 3m 相当を与える。
                            # 押し出し高さ 0 だと地図から消えてしまうため
                            "height": r["measured_height"] or 3.0,
                            "usage": r["usage"],
                            "town": r["town"],
                            "storeys": r["storeys_above_ground"],
                        },
                    }
                )
        args.output_3d.parent.mkdir(parents=True, exist_ok=True)
        with args.output_3d.open("w") as fh:
            for f in rows3d:
                fh.write(json.dumps(f, ensure_ascii=False, separators=(",", ":")) + "\n")
        n23 = sum(1 for r in rows3d if r["properties"]["year"] == 2023)
        print(
            f"3D出力: {args.output_3d} "
            f"({len(rows3d):,} features / 2023年 {n23:,} + 2025年 {len(rows3d) - n23:,})"
        )

    total = sum(stats.values())
    print(f"\n{'分類':12} {'棟数':>9} {'割合':>7}")
    print("-" * 32)
    for k in (
        "unchanged",
        "extended",
        "rebuilt",
        "split",
        "merge",
        "redevelop",
        "demolished",
        "new",
    ):
        print(f"{k:12} {stats[k]:>9,} {stats[k] / total:>6.1%}")
    print("-" * 32)
    print(f"{'合計':12} {total:>9,}")
    size_mb = args.output.stat().st_size / 1024 / 1024
    print(f"\n出力: {args.output} ({len(features):,} features, {size_mb:.1f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
