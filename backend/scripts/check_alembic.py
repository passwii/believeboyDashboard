#!/usr/bin/env python3
"""
check_alembic.py — Alembic 迁移图守护（BEL-492 / BLF-492，2026-08-07）

多 Agent 并行开发时迁移冲突的机械防线（把"协调错误"变成"可检测错误"）。
在 pre-push / git deploy / VPS 部署（alembic upgrade head 之前）运行：

  ① 全图必须只有一个 head（多 head → `alembic upgrade head` 会在 VPS 失败）
  ② 文件名必须匹配 ^YYYYMMDD_NNN_description.py$ 且 revision id 为纯数字短 ID
     （防裸跑 `alembic revision -m` 生成随机 hash；历史教训 790a004efd39 等）
  ③ 全图无重复 revision id（并行 Agent 算"下一序号"的竞态会产生重复 id；
     历史教训：重复 114）
  ④ 所有 revision 必须从 head 可达（无孤儿分支）；down_revision 必须存在

纯 AST 解析，不依赖 alembic / 数据库 / 环境变量，可安全跑在任何环境
（本地、CI、VPS 部署前）。

用法:
    cd backend && python scripts/check_alembic.py

退出码: 0 = 通过；1 = 未通过（stderr 给出修复提示）
约定权威来源: 仓库 docs/REFERENCE.md §数据库与迁移 / AGENTS.md §关键约定
"""

import ast
import re
import sys
from pathlib import Path

# 约定：文件名 YYYYMMDD_NNN_description.py；revision id 用纯数字短 ID（如 '215'）
# 或历史日期风格（如 '20260718_214'）；严禁随机 hash / 自定义 slug
FILE_NAME_RE = re.compile(r"^\d{8}_\d+_")
REVISION_ID_RE = re.compile(r"^\d+$")
DATE_STYLE_ID_RE = re.compile(r"^\d{8}_\d+$")

# 约定落地前（2026-07-22 双 head 事件 / 迁移命名统一前）的历史遗留违规文件。
# 只减不增——新迁移严禁加入此名单，否则命名检查会直接拦住。
LEGACY_EXCEPTIONS = {
    "84d78e2677ee_add_auto_report_upload_logs.py",  # 随机 hash 文件名+id
    "a5571a96e542_add_digital_employee_tables.py",  # 随机 hash 文件名+id
    "790a004efd39_add_digital_employee_playback.py",  # 随机 hash（2026-07-22 双 head 事件）
    "236_add_business_scope_to_agent_api_keys.py",  # 缺日期前缀
    "reconciliation_records_v1.py",  # 无约定命名
    "20260405_082_add_token_stats_to_ai_conversation.py",  # id='add_token_stats_conv'
    "20260415_096_backfill_is_active_true.py",  # id='20260415_095b'（历史 b 后缀教训）
    "20260424_105_add_fbm_fields_to_pricing_calculation_runs.py",  # id='4bc3ae3b753b'
    "20260715_001_add_vat_enabled_and_vat_tables.py",  # id='a1b2c3d4e5f6'
    "20260717_213_sales_row_upsert_key.py",  # id='b2c3d4e5f6a7'
}


def _assign_literal(node: ast.AST):
    """从 Assign/AnnAssign 的 value（或 Constant 节点本身）取字面量 str/tuple。"""
    value = node if isinstance(node, ast.Constant) else getattr(node, "value", None)
    if isinstance(value, ast.Constant):
        return value.value
    if isinstance(value, ast.Tuple):
        return tuple(_assign_literal(e) for e in value.elts)
    return None


def _parse_rev_ids(filepath: Path) -> tuple:
    """返回 (revision, down_revision)；解析失败抛 ValueError。"""
    tree = ast.parse(filepath.read_text(encoding="utf-8"))
    revision = down_revision = None
    for node in tree.body:
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            target = node.target if isinstance(node, ast.AnnAssign) else node.targets[0]
            if not isinstance(target, ast.Name):
                continue
            if target.id == "revision":
                revision = _assign_literal(node)
            elif target.id == "down_revision":
                down_revision = _assign_literal(node)
    return revision, down_revision


def check(versions_dir: Path) -> list:
    """检查迁移目录，返回违规信息列表；空列表 = 通过。"""
    errors: list = []
    if not versions_dir.is_dir():
        return [f"找不到迁移目录: {versions_dir}"]

    files = sorted(versions_dir.glob("*.py"))
    if not files:
        return [f"迁移目录为空: {versions_dir}"]

    # 全文件解析：id -> (down, filename)
    revs: dict = {}  # revision id -> (down_revision, filename)
    by_file: dict = {}  # filename -> revision id
    for f in files:
        try:
            rev, down = _parse_rev_ids(f)
        except (SyntaxError, ValueError) as e:
            errors.append(f"{f.name}: 解析失败（{e}）——Alembic 大概率也跑不起来")
            continue
        if rev is None:
            errors.append(f"{f.name}: 未解析到 revision id")
            continue
        if rev in revs:
            errors.append(f"重复的 revision id: '{rev}'（{revs[rev][1]} 与 {f.name}）")
        revs[rev] = (down, f.name)
        by_file[f.name] = rev

    # ② 命名规范（文件名 + revision id；合并迁移同样要求）
    for f in files:
        if f.name in LEGACY_EXCEPTIONS:
            continue
        if not FILE_NAME_RE.match(f.name):
            errors.append(
                f"文件名不符合约定 ^YYYYMMDD_NNN_...：{f.name}"
                '（建迁移用 `alembic revision --rev-id <下一序号> -m "说明"`）'
            )
        rev = by_file.get(f.name)
        if rev is not None and not (
            REVISION_ID_RE.match(rev) or DATE_STYLE_ID_RE.match(rev)
        ):
            errors.append(
                f"revision id 应为纯数字短 ID（如 '215'）或日期风格（如 '20260718_214'），"
                f"严禁随机 hash：{f.name} -> '{rev}'"
            )

    if not revs:
        return errors

    # ③ down_revision 必须存在
    for rev, (down, fname) in revs.items():
        for d in down if isinstance(down, tuple) else (down,):
            if d is not None and d not in revs:
                errors.append(
                    f"{fname}: down_revision '{d}' 不存在（指向了不存在的版本）"
                )

    # ① 单 head：从未被任何 down_revision 引用，且自身是已定义 revision
    referenced = {
        d
        for _, (down, _) in revs.items()
        for d in (down if isinstance(down, tuple) else (down,))
        if d is not None
    }
    heads = [rev for rev in revs if rev not in referenced]
    if len(heads) != 1:
        errors.append(
            f"检测到 {len(heads)} 个 head（{', '.join(sorted(heads)) or '无'}）——"
            "多 Agent 并行撞车了。在 main 侧用 "
            '`alembic merge heads --rev-id <下一序号> -m "merge xxx"` 合回单链后再 push。'
        )

    # ④ 从唯一 head 可达（无孤儿）
    if len(heads) == 1:
        reachable = _reachable(revs, heads[0])
        orphans = [rev for rev in revs if rev not in reachable]
        if orphans:
            errors.append(f"存在未挂到 head 链上的孤儿 revision：{sorted(orphans)}")

    return errors


def _reachable(revs: dict, head: str) -> set:
    seen = set()
    stack = [head]
    while stack:
        cur = stack.pop()
        if cur in seen:
            continue
        seen.add(cur)
        down, _ = revs.get(cur, (None, None))
        for d in down if isinstance(down, tuple) else (down,):
            if d is not None:
                stack.append(d)
    return seen


def main() -> int:
    here = Path(__file__).resolve().parent
    # 脚本位于 backend/scripts/ → versions 在 backend/alembic/versions
    versions = here.parent / "alembic" / "versions"
    if not versions.is_dir():
        # 兜底：脚本与 versions 同级时
        versions = here / "versions"
    if not versions.is_dir():
        print(f"✗ 找不到 alembic/versions 目录（{versions}）", file=sys.stderr)
        return 1

    errors = check(versions)
    if errors:
        print("✗ Alembic 迁移图检查未通过：", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        print("", file=sys.stderr)
        print(
            '修复提示：多 head 用 `alembic merge heads --rev-id <下一序号> -m "merge xxx"`；',
            file=sys.stderr,
        )
        print(
            "命名 / revision id 规范见 docs/REFERENCE.md §数据库与迁移。",
            file=sys.stderr,
        )
        return 1
    print("✓ Alembic 迁移图检查通过（单 head、命名合规、无重复 / 孤儿）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
