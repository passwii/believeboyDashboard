"""check_alembic.py 单元测试（BLF-492）

纯逻辑测试：用临时目录构造假迁移文件，验证单链 / 双 head / 重复 id /
命名违规 / 孤儿 的判定。不依赖数据库与 alembic 环境。
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]  # backend/
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.check_alembic import check  # noqa: E402


def _write(versions: Path, name: str, rev: str, down) -> Path:
    if isinstance(down, tuple):
        down_s = "(" + ", ".join(f"'{d}'" for d in down) + ")"
    elif down is None:
        down_s = "None"
    else:
        down_s = f"'{down}'"
    f = versions / name
    f.write_text(
        f"from typing import Sequence, Union\n"
        f"\n"
        f"revision: str = {rev!r}\n"
        f"down_revision: Union[str, None] = {down_s}\n"
        f"branch_labels: Union[str, Sequence[str], None] = None\n"
        f"\n"
        f"def upgrade() -> None:\n"
        f"    pass\n",
        encoding="utf-8",
    )
    return f


def _versions(tmp_path: Path) -> Path:
    v = tmp_path / "versions"
    v.mkdir()
    return v


def test_single_chain_passes(tmp_path):
    v = _versions(tmp_path)
    _write(v, "20260101_001_a.py", "1", None)
    _write(v, "20260101_002_b.py", "2", "1")
    assert check(v) == []


def test_merge_chain_passes(tmp_path):
    """合并迁移（tuple down_revision）应合法。"""
    v = _versions(tmp_path)
    _write(v, "20260101_001_a.py", "1", None)
    _write(v, "20260101_002_b.py", "2", "1")
    _write(v, "20260101_003_c.py", "3", "1")
    _write(v, "20260102_004_merge.py", "4", ("2", "3"))
    assert check(v) == []


def test_two_heads_fails(tmp_path):
    v = _versions(tmp_path)
    _write(v, "20260101_001_a.py", "1", None)
    _write(v, "20260101_002_b.py", "2", "1")
    _write(v, "20260101_003_c.py", "3", "1")  # 与 b 同挂 1 → 双 head
    errs = check(v)
    assert any("head" in e for e in errs)


def test_duplicate_revision_id_fails(tmp_path):
    v = _versions(tmp_path)
    _write(v, "20260101_001_a.py", "1", None)
    _write(v, "20260101_002_b.py", "2", "1")
    _write(v, "20260101_003_c.py", "2", "1")  # 重复 id
    errs = check(v)
    assert any("重复" in e for e in errs)


def test_naming_violation_fails(tmp_path):
    v = _versions(tmp_path)
    _write(v, "20260101_001_a.py", "1", None)
    _write(v, "bad_hash_add_xxx.py", "2", "1")  # 文件名不合规
    _write(v, "20260101_003_c.py", "a5571a96e542", "2")  # 随机 hash id
    errs = check(v)
    assert any("文件名不符合约定" in e for e in errs)
    assert any("严禁随机 hash" in e for e in errs)


def test_legacy_exceptions_allowed(tmp_path):
    v = _versions(tmp_path)
    _write(v, "20260101_001_a.py", "1", None)
    _write(v, "84d78e2677ee_add_auto_report_upload_logs.py", "84d78e2677ee", "1")
    _write(v, "236_add_business_scope_to_agent_api_keys.py", "236", "84d78e2677ee")
    # 历史遗留文件放行，但若引入新违规（如新 head）仍会报
    errs = check(v)
    assert not any("文件名不符合约定" in e for e in errs)
    assert not any("严禁随机 hash" in e for e in errs)


def test_dangling_down_revision_fails(tmp_path):
    v = _versions(tmp_path)
    _write(v, "20260101_001_a.py", "1", None)
    _write(v, "20260101_002_b.py", "2", "999")  # down_revision 不存在
    errs = check(v)
    assert any("不存在" in e and "999" in e for e in errs)


def test_orphan_cycle_fails(tmp_path):
    """单 head 下仍有无法从 head 到达的 revision（成环）→ 孤儿。"""
    v = _versions(tmp_path)
    _write(v, "20260101_001_a.py", "1", "2")  # 1↔2 成环，脱离 head 链
    _write(v, "20260101_002_b.py", "2", "1")
    _write(v, "20260101_003_c.py", "3", None)  # 唯一 head
    errs = check(v)
    assert any("孤儿" in e for e in errs)
