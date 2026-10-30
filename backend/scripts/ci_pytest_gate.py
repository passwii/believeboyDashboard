#!/usr/bin/env python3
"""pytest 全量门禁：只对**新增**失败报错，既有失败不误报为回归。

背景（AGENTS.md §测试规则「失败集对账」）：
仓库全量 pytest 里存在**少量既有失败**（环境 / 存量数据依赖导致，例如
「测试库应至少有一个 is_active=False 的项目」——那条断言依赖 BLF_test 里
从生产克隆下来的存量行；CI 的全新库没有这些行）。
按约定：**PR 与 main 出现相同失败 → 记录为既有失败，不误报为本次回归**。

所以门禁逻辑是「**基线对账**」而不是「必须全绿」：
1. 跑全量 pytest，收集失败的 nodeid 集合；
2. 与基线文件 `backend/tests/ci_known_failures.txt` 比对；
3. **出现基线之外的新失败 → 退出码 1（阻断）**；
4. 只有基线里的既有失败 → 退出码 0（放行，但在输出里列出来）。

基线文件每行一个 nodeid，`#` 开头是注释。新增失败时**不要**直接把它加进基线
——那是掩盖回归；先查清根因、真修好了再更新基线。

用法：
    python scripts/ci_pytest_gate.py            # 跑全量 + 对账
    python scripts/ci_pytest_gate.py --update   # 只把当前失败写回基线（人工确认后用）
    python scripts/ci_pytest_gate.py -- tests/api/agent  # 只对指定 pytest 子集对账
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASELINE_FILE = ROOT / "tests" / "ci_known_failures.txt"

# pytest 短摘要里的失败行：`FAILED path::test_name` / `ERROR path::test_name`
_FAILED_RE = re.compile(r"^(?:FAILED|ERROR)\s+(\S+)")
# pytest 用 ASCII 转义打印非 ASCII 的参数化 id（如 `已在最顶部` → `已\u5728\u6700\u9876\u90e8`），
# 基线文件要人可读，所以两边都还原成真 unicode 再比对。
_UNICODE_ESCAPE_RE = re.compile(r"\\u([0-9a-fA-F]{4})")


def _unescape(nodeid: str) -> str:
    return _UNICODE_ESCAPE_RE.sub(lambda m: chr(int(m.group(1), 16)), nodeid)


def read_baseline() -> set[str]:
    if not BASELINE_FILE.exists():
        return set()
    out = set()
    for raw in BASELINE_FILE.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        out.add(line)
    return out


def write_baseline(nodeids: set[str]) -> None:
    lines = [
        "# CI 全量 pytest 的**既有失败**基线（对账用）。",
        "#",
        "# 语义：基线内的失败 = 已知问题，不阻断 CI；基线之外的新失败 = 回归，阻断。",
        "# 维护约定：真修好了才把条目删掉；发现新失败先查根因，别直接加进来。",
        "#",
        "# 每行一个 pytest nodeid。",
        "",
    ]
    lines.extend(sorted(nodeids))
    BASELINE_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")


def run_pytest(pytest_args: list[str] | None = None) -> tuple[int, str]:
    """跑 pytest，实时转发输出，同时保留文本供解析失败清单。"""
    extra_args = list(pytest_args or [])
    if extra_args[:1] == ["--"]:
        extra_args = extra_args[1:]
    args = [
        sys.executable,
        "-m",
        "pytest",
        "-v",
        "--durations=50",
        "--durations-min=1",
        *extra_args,
    ]
    proc = subprocess.Popen(
        args,
        cwd=str(ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )
    assert proc.stdout is not None
    chunks: list[str] = []
    for line in proc.stdout:
        print(line, end="", flush=True)
        chunks.append(line)
    return proc.wait(), "".join(chunks)


def parse_failures(output: str) -> set[str]:
    """从 pytest 短摘要里取失败的 nodeid。

    只认「行首就是 FAILED/ERROR」的行，避免误抓 traceback 里出现的同名字符串。
    """
    found: set[str] = set()
    for line in output.splitlines():
        # Keep the original indentation: traceback prose sometimes starts with
        # "FAILED ..." after indentation, and those must not become nodeids.
        m = _FAILED_RE.match(line)
        if m:
            found.add(_unescape(m.group(1)))
    return found


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--update", action="store_true", help="只把当前失败写回基线")
    parser.add_argument(
        "pytest_args",
        nargs=argparse.REMAINDER,
        help="传给 pytest 的额外参数；路径前建议加 --，例如 -- tests/api/agent",
    )
    args = parser.parse_args()

    print("→ 跑 pytest（全量可能几分钟）...", flush=True)
    code, output = run_pytest(args.pytest_args)

    current = parse_failures(output)

    if args.update:
        write_baseline(current)
        print(f"基线已更新：{len(current)} 条 → {BASELINE_FILE}")
        return 0

    baseline = read_baseline()
    new_failures = sorted(current - baseline)
    known_failures = sorted(current & baseline)

    if known_failures:
        print(f"\n已知既有失败（{len(known_failures)} 条，不阻断）：")
        for nodeid in known_failures:
            print(f"  · {nodeid}")

    if new_failures:
        print(f"\n❌ 新增失败（{len(new_failures)} 条，阻断）：", file=sys.stderr)
        for nodeid in new_failures:
            print(f"  · {nodeid}", file=sys.stderr)
        print(
            "\n这些不在基线里 = 本次回归。若确认是既有问题（与 main 相同），"
            "再更新基线；否则先修根因。",
            file=sys.stderr,
        )
        return 1

    print("\n✅ pytest 无新增失败。")
    return 0 if code in (0, 1) else code


if __name__ == "__main__":
    raise SystemExit(main())
