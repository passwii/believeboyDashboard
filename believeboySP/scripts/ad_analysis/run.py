"""run — CLI 主入口，一键跑主题 D（D1-D5）全部子主题。

Usage:
    python -m ad_analysis.run --project 4
    python -m ad_analysis.run --project 4 --country US --period 30d
    python -m ad_analysis.run --project 4 --only d1,d5
"""
from __future__ import annotations

import argparse
import sys

from . import d1_signals, d2_associate, d3_terms, d4_targets, d5_burst
from . import a_negatives, a_budget, b_chain
from . import load_data


SUBTHEMES = {
    # 主题 D（增长）
    "d1": ("高 ROAS × 低曝光词", d1_signals.main),
    "d2": ("互补品反哺", d2_associate.main),
    "d3": ("词性 + matchType 矩阵", d3_terms.main),
    "d4": ("提价机会", d4_targets.main),
    "d5": ("爆发词识别", d5_burst.main),
    # 主题 A（降本）
    "a1": ("否定词候选（高 spend 0 单）", a_negatives.main),
    "a5": ("预算利用率 + 加/减预算", a_budget.main),
    # 主题 B（提效）
    "b3": ("搜索词 → 目标 链路 ROAS", b_chain.main),
}


def run(project: int, country: str, period: str, only: list[str] | None = None):
    """依次跑选定的 D 子主题。"""
    targets = only or list(SUBTHEMES.keys())
    print(f"项目: {project} | 国家: {country} | 周期: {period}")
    print(f"运行子主题: {targets}")
    print("=" * 80)

    for key in targets:
        if key not in SUBTHEMES:
            print(f"[SKIP] 未知子主题: {key}")
            continue
        name, fn = SUBTHEMES[key]
        print(f"\n>>> [{key.upper()}] {name}")
        print("-" * 80)
        try:
            # 各模块 main 接受不同参数；这里只把常用参数传过去
            if key == "d5":
                # D5 用 burst 周期（默认 14d），不用 period
                sys.argv = ["ad_analysis.run", "--project", str(project),
                            "--country", country, "--period", "14d"]
            else:
                sys.argv = ["ad_analysis.run", "--project", str(project),
                            "--country", country, "--period", period]
            fn()
        except SystemExit:
            pass  # argparse 退出
        except Exception as e:
            print(f"[ERROR] {key} 失败: {e}")
        print("=" * 80)


def main():
    parser = argparse.ArgumentParser(description="一键跑主题 D（D1-D5）")
    parser.add_argument("--project", type=int, default=4, help="项目 ID（默认 4）")
    parser.add_argument("--country", default="US", help="国家代码（默认 US）")
    parser.add_argument("--period", default="30d", help="时间周期（默认 30d）")
    parser.add_argument(
        "--only", default=None,
        help="只跑指定子主题，逗号分隔，如 'd1,d5'。默认全跑",
    )
    args = parser.parse_args()

    only = [s.strip() for s in args.only.split(",")] if args.only else None
    run(args.project, args.country, args.period, only)


if __name__ == "__main__":
    main()