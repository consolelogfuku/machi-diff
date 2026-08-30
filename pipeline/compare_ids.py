"""2年度分の抽出結果を突き合わせ、建物IDが年度をまたいで安定しているか検証する。

このプロジェクトの成否を決める前提の確認用。
建物IDの一致率が高ければ ID join で差分が取れる。低ければ
フットプリントの空間的な重なり(IoU)による突合にフォールバックする必要がある。

使い方:
    uv run pipeline/compare_ids.py data/build/2023.parquet data/build/2025.parquet
"""

from __future__ import annotations

import argparse
from pathlib import Path

import pyarrow.parquet as pq


def load(path: Path, city: str | None) -> dict:
    """建物ID -> 属性 の辞書。

    メッシュタイルが区境をまたぐため、世田谷区のデータセットには隣接自治体の
    建物が約25%含まれる。年度で収録範囲がずれると区境沿いに偽の新築/解体が
    並ぶので、uro:city で対象自治体だけに絞る。
    """
    table = pq.read_table(path)
    cols = {name: table.column(name).to_pylist() for name in table.column_names}
    raw_total = table.num_rows

    by_id: dict[str, dict] = {}
    duplicates = 0
    total = 0
    for i in range(raw_total):
        if city and cols["city"][i] != city:
            continue
        total += 1
        bid = cols["building_id"][i]
        if not bid:
            continue
        if bid in by_id:
            duplicates += 1
            continue
        by_id[bid] = {k: cols[k][i] for k in cols}
    return {
        "by_id": by_id,
        "total": total,
        "raw_total": raw_total,
        "duplicates": duplicates,
    }


def pct(n: int, d: int) -> str:
    return f"{n / d:.1%}" if d else "n/a"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("old_parquet", type=Path, help="古い年度")
    ap.add_argument("new_parquet", type=Path, help="新しい年度")
    ap.add_argument(
        "--city",
        default="13112",
        help="対象自治体コード (uro:city)。既定は世田谷区。all で絞り込みなし",
    )
    args = ap.parse_args()

    city = None if args.city == "all" else args.city
    old = load(args.old_parquet, city)
    new = load(args.new_parquet, city)
    print(f"対象自治体: {args.city}")

    old_ids, new_ids = set(old["by_id"]), set(new["by_id"])
    both = old_ids & new_ids
    only_old = old_ids - new_ids
    only_new = new_ids - old_ids

    print("=" * 60)
    print("建物ID の年度間一致検証")
    print("=" * 60)
    for label, d in (("旧年度", old), ("新年度", new)):
        print(
            f"{label}: 収録 {d['raw_total']:,} 棟 → 対象 {d['total']:,} 棟 / "
            f"ID保有 {len(d['by_id']):,} ({pct(len(d['by_id']), d['total'])}) / "
            f"ID重複 {d['duplicates']:,}"
        )

    print("-" * 60)
    denom = min(len(old_ids), len(new_ids))
    print(f"両年度に存在  : {len(both):,}  (小さい方に対して {pct(len(both), denom)})")
    print(f"旧のみ(解体?) : {len(only_old):,}")
    print(f"新のみ(新築?) : {len(only_new):,}")

    # 一致した建物のうち、実際に属性が変化したもの
    changed_height = changed_storeys = 0
    for bid in both:
        o, n = old["by_id"][bid], new["by_id"][bid]
        if o["measured_height"] != n["measured_height"]:
            changed_height += 1
        if o["storeys_above_ground"] != n["storeys_above_ground"]:
            changed_storeys += 1

    print("-" * 60)
    print(f"高さが変化    : {changed_height:,}  ({pct(changed_height, len(both))})")
    print(f"階数が変化    : {changed_storeys:,}  ({pct(changed_storeys, len(both))})")

    print("=" * 60)
    rate = len(both) / denom if denom else 0
    if rate >= 0.9:
        print("判定: 建物IDは安定している。ID join で差分エンジンを実装できる。")
    elif rate >= 0.5:
        print("判定: 部分的に安定。ID join を主軸に、非一致分を IoU で補完する。")
    else:
        print("判定: 建物IDは年度間で安定していない。IoU による空間突合が必要。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
