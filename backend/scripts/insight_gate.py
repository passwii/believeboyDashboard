"""Insight 观测期质量/成本门禁（BLF-1018，Stage 5）。

一个命令给出「canonical Insight 链路能否进入 legacy 退役流程」的全部证据：

1. 指标（``gate_report``）：按 run/capability 聚合的首字时延、时长、token、
   重连率、取消成功率、Stream 帧数/内存、错误类型、fallback 比例，以及阈值判定；
2. 并发/成本桶上限（``bucket_caps``）：``insights`` 与 legacy ``ai_summary``
   物理分桶，互不顶占；
3. 退役判定（按 target）：静态调用方扫描 —— 只有「调用方清零」的 target 才允许
   退役，且必须同时满足指标达标 + 场景矩阵通过 + 回滚演练通过；
4. CodeGraph 调用方证据：有 ``codegraph`` 二进制时现场复跑，否则打印复现命令
   （静态调用图看不见 ``.delay()`` 动态派发，这一限制随证据一起输出）；
5. 场景矩阵：success / failure / cancel / retry / reconnect / permission /
   cost anomaly / rollback drill，逐条 PASS/FAIL。

用法（在 backend 目录，依赖 ``DATABASE_URL`` 指向被观测的库）：
    python scripts/insight_gate.py
    python scripts/insight_gate.py --window-days 14 --skip-scenarios
    python scripts/insight_gate.py --json /tmp/insight-gate.json

退出码：0 = canonical 退役门禁通过；1 = 未通过（原因逐条列出）；2 = 环境不可用。
本脚本**只读**：不写库、不动开关、不删任何东西。
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]  # backend/
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

APP_DIR = ROOT / "app"
SCENARIO_MODULE = "tests/insight/test_quality_gate_scenarios.py"

#: 静态调用方证据要覆盖的符号（legacy 写路径 + 新链路入口）。
CODEGRAPH_SYMBOLS = (
    "generate_insight",
    "run_insight_generation",
    "retry_insight",
    "update_insight",
    "delete_insight",
    "create_insight_schedule",
    "run_insight_schedule_now",
)

#: 回滚开关：清空该 CSV = 回退到 legacy 写路径（canonical 端点 409）。
ROLLBACK_SWITCH = "INSIGHT_CANONICAL_DOMAINS"
ROLLBACK_PROCEDURE = (
    "置空 INSIGHT_CANONICAL_DOMAINS（或移除对应域）→ 重启 believeboy-api / "
    "worker → legacy 写端点立即恢复；canonical /insight/runs 对未启用域返回 "
    "409 DOMAIN_SWITCH_NOT_READY"
)

#: 切换时间窗：先冻结 legacy 写、保留旧 URL 与历史只读，观察期满再谈物理删除。
SWITCH_WINDOW = (
    "冻结 legacy 写（旧 URL 保留、历史只读可用）→ 观察 "
    "INSIGHT_OBSERVATION_WINDOW_DAYS 天 → 门禁通过且三票齐备 → 才允许删除"
)


@dataclass(frozen=True)
class LegacyTarget:
    """一个待退役的 legacy 写入面 + 它的 canonical 替代者。"""

    key: str
    title: str
    capability: str
    canonical_replacement: str | None
    #: 精确调用 token（避免 ``generate_insight_stream`` 这类前缀误命中）。
    tokens: tuple[str, ...]
    #: 这些文件属于**退役集合本身**，出现在这里不算外部调用方。
    owned_by: tuple[str, ...]
    note: str = ""


LEGACY_TARGETS: tuple[LegacyTarget, ...] = (
    LegacyTarget(
        key="legacy_insight_write",
        title="legacy /ai-insights 写端点 + 调度扇出（celery_generate_insight）",
        capability="insight",
        canonical_replacement="POST /api/v1/insight/runs（canonical executor）",
        tokens=(
            "celery_generate_insight.delay(",
            "generate_insight.delay(",
            "run_insight_generation(",
        ),
        owned_by=(
            "app/api/v1/endpoints/ai_insight.py",
            "app/services/insight_schedule_service.py",
            "app/celery_tasks/insights/generate.py",
            "app/services/ai_insight_runtime_service.py",
        ),
        note=(
            "同批退役：缓存写端点登记表 app/services/infra/cache_write_endpoints.py "
            "中的 ai_insight 条目（BLF-669）"
        ),
    ),
    LegacyTarget(
        key="legacy_ai_summary_write",
        title="旧 AI 摘要写入（定时报表 / 库存台账 / 货件摘要）",
        capability="ai_summary",
        canonical_replacement=None,
        tokens=(
            "regenerate_scheduled_report_ai_summary(",
            "regenerate_ledger_ai_summary_async(",
            "generate_ai_summary_for_delivery_log(",
        ),
        owned_by=(
            "app/api/v1/endpoints/scheduled_reports.py",
            "app/services/scheduled_report/ledger_service.py",
            "app/services/scheduled_report/__init__.py",
            "app/celery_tasks/ai_summary.py",
        ),
        note=(
            "**本阶段不退役**：canonical 链路尚未承接这三个业务面，"
            "强行冻结会直接打断定时报表/台账摘要（非目标：不改变未迁移业务的降级行为）"
        ),
    ),
)


@dataclass(frozen=True)
class CallerHit:
    path: str
    line: int
    text: str


def _scan_callers(target: LegacyTarget) -> tuple[list[CallerHit], list[CallerHit]]:
    """扫出 target 的调用点，按「退役集合内 / 外部」分类。

    静态扫源码（不走 CodeGraph）是刻意的：它可在无 codegraph 的环境（CI/VPS）
    复现，且 token 精确到调用形状，不会把 ``generate_insight_stream`` 这类
    同前缀符号算成调用方。
    """

    owned = {name for name in target.owned_by}
    internal: list[CallerHit] = []
    external: list[CallerHit] = []
    for path in sorted(APP_DIR.rglob("*.py")):
        rel = path.relative_to(ROOT).as_posix()
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeDecodeError):
            continue
        for lineno, text in enumerate(lines, start=1):
            if not any(token in text for token in target.tokens):
                continue
            hit = CallerHit(rel, lineno, text.strip())
            (internal if rel in owned else external).append(hit)
    return internal, external


def _section(title: str) -> None:
    print(f"\n== {title} " + "=" * max(0, 60 - len(title)))


def _codegraph_evidence() -> tuple[bool, dict[str, Any]]:
    """现场复跑 CodeGraph 调用方查询；无二进制时返回复现命令。"""

    binary = shutil.which("codegraph")
    commands = [f"codegraph callers {symbol}" for symbol in CODEGRAPH_SYMBOLS]
    if binary is None:
        return False, {"available": False, "commands": commands}
    out: dict[str, str] = {}
    for symbol in CODEGRAPH_SYMBOLS:
        try:
            proc = subprocess.run(
                [binary, "callers", symbol],
                cwd=ROOT,
                capture_output=True,
                text=True,
                timeout=120,
                check=False,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            out[symbol] = f"<codegraph 执行失败: {type(exc).__name__}>"
            continue
        out[symbol] = (proc.stdout or proc.stderr).strip()
    return True, {"available": True, "commands": commands, "results": out}


def _run_scenarios() -> tuple[bool, list[dict[str, str]]]:
    """跑场景矩阵；返回 (全绿?, 每场景 PASS/FAIL)。"""

    proc = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            SCENARIO_MODULE,
            "-v",
            "--no-header",
            "-p",
            "no:cacheprovider",
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    rows: list[dict[str, str]] = []
    for raw in (proc.stdout or "").splitlines():
        line = raw.strip()
        if "::" not in line:
            continue
        node, _, verdict_word = line.partition("::")[2].partition(" ")
        name = verdict_word.strip().split(" ")[0]
        if name not in {"PASSED", "FAILED", "ERROR", "SKIPPED"}:
            continue
        rows.append({"test": node.strip(), "result": name})
    ok = proc.returncode == 0 and bool(rows)
    rows.append({"test": "<pytest summary>", "result": "PASS" if ok else "FAIL"})
    return ok, rows


def _print_thresholds(settings: Any) -> None:
    _section("阈值（anchor = 仓库里已存在的硬数字，不是拍脑袋）")
    rows = (
        ("insight_observation_enabled", settings.insight_observation_enabled, "观测总开关"),
        ("insight_observation_window_days", settings.insight_observation_window_days, "聚合窗口"),
        ("insight_gate_max_duration_ms", settings.insight_gate_max_duration_ms, "= celery soft_time_limit 300s"),
        ("insight_gate_max_first_delta_ms", settings.insight_gate_max_first_delta_ms, "= ai_chat_timeout_seconds"),
        ("insight_gate_max_stream_frames", settings.insight_gate_max_stream_frames, "= insight_stream_maxlen（保留窗口）"),
        ("insight_gate_max_fallback_ratio", settings.insight_gate_max_fallback_ratio, "0 = 不判定"),
        ("insight_gate_cost_anomaly_multiplier", settings.insight_gate_cost_anomaly_multiplier, "运维经验值（非仓库固定）"),
    )
    for name, value, note in rows:
        print(f"  {name:38s} = {value!r:>10}  # {note}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Insight 观测期质量/成本门禁（BLF-1018）")
    parser.add_argument("--window-days", type=int, default=None, help="聚合窗口天数（默认取 settings）")
    parser.add_argument("--capability", default=None, help="只看某个 capability 桶")
    parser.add_argument("--skip-scenarios", action="store_true", help="不跑场景矩阵（只读库）")
    parser.add_argument("--json", dest="json_out", default=None, help="把完整报告写到该路径")
    args = parser.parse_args()

    try:
        from app.core.config import get_settings
        from app.db.session import SessionLocal
        from app.services.insight.observation import (
            CANONICAL_CAPABILITIES,
            gate_report,
            is_retirement_eligible,
        )
        from app.services.insight_concurrency import bucket_caps
    except Exception as exc:  # noqa: BLE001 — 环境缺失要给出可读结论
        print(f"环境不可用：导入应用模块失败（{type(exc).__name__}: {exc}）", file=sys.stderr)
        return 2

    try:
        settings = get_settings()
    except Exception as exc:  # noqa: BLE001 — pydantic 校验失败=环境变量缺失
        print(f"环境不可用：Settings 校验失败（{type(exc).__name__}: {exc}）", file=sys.stderr)
        return 2

    payload: dict[str, Any] = {
        "window_days": args.window_days or settings.insight_observation_window_days,
        "canonical_capabilities": list(CANONICAL_CAPABILITIES),
        "bucket_caps": bucket_caps(),
        "switch_window": SWITCH_WINDOW,
        "rollback_switch": ROLLBACK_SWITCH,
        "rollback_procedure": ROLLBACK_PROCEDURE,
        "owner": "Damon（后端工程师）",
    }

    _print_thresholds(settings)

    db = SessionLocal()
    try:
        report = gate_report(
            db,
            settings=settings,
            window_days=args.window_days,
            capability=args.capability,
        )
    except Exception as exc:  # noqa: BLE001 — DB 不可达=环境问题，不是门禁失败
        print(f"环境不可用：读取观测表失败（{type(exc).__name__}: {exc}）", file=sys.stderr)
        return 2
    finally:
        db.close()

    metrics_ok, reasons = is_retirement_eligible(report)
    payload["gate_report"] = report.as_dict()
    payload["metrics_eligible"] = metrics_ok
    payload["metrics_reasons"] = reasons

    _section("指标门禁（按 capability 聚合）")
    for bucket in report.buckets:
        print(
            f"  [{bucket.capability}] runs={bucket.runs} completed={bucket.completed} "
            f"failed={bucket.failed} cancelled={bucket.cancelled} "
            f"error_rate={bucket.error_rate:.3f} retries={bucket.retried_runs} "
            f"fallback={bucket.fallback_events}({bucket.fallback_ratio:.3f}) "
            f"duration avg/p95/max={bucket.avg_duration_ms}/{bucket.p95_duration_ms}/"
            f"{bucket.max_duration_ms}ms "
            f"first_delta avg/max={bucket.avg_first_delta_ms}/{bucket.max_first_delta_ms}ms "
            f"reconnect={bucket.reconnect_rate:.3f} "
            f"cancel={bucket.cancel_succeeded}/{bucket.cancel_requested} "
            f"stream xlen_max={bucket.max_stream_xlen} "
            f"mem_max={bucket.max_stream_memory_bytes} "
            f"cost_anomalies={bucket.cost_anomalies}"
        )
    if not report.buckets:
        print("  （窗口内没有观测行：先让 canonical run 跑起来再判）")
    for finding in report.findings:
        print(
            f"  - [{finding.severity}] {finding.capability}.{finding.code} "
            f"metric={finding.metric} observed={finding.observed} "
            f"threshold={finding.threshold} {finding.detail}"
        )
    print(f"  指标票：{'达标' if metrics_ok else '未达标 ' + ','.join(reasons) if reasons else '未达标'}")

    _section("并发 / 成本桶上限（Insight 与 legacy ai_summary 分桶）")
    for name, cap in payload["bucket_caps"].items():
        print(f"  {name:12s} max_concurrent={cap}")
    print(f"  单次 run 等待闸门上限 insight_semaphore_wait_seconds={settings.insight_semaphore_wait_seconds}s")
    print("  饱和时 canonical run 不调用 LLM：任务重排队（run 保持 queued），不是静默降级")

    _section("退役判定（调用方清零 = 静态扫描无外部调用方）")
    targets_payload: list[dict[str, Any]] = []
    for target in LEGACY_TARGETS:
        internal, external = _scan_callers(target)
        retired_ok = target.canonical_replacement is not None and not external
        entry = {
            "key": target.key,
            "capability": target.capability,
            "canonical_replacement": target.canonical_replacement,
            "internal_calls": [f"{h.path}:{h.line}" for h in internal],
            "external_calls": [f"{h.path}:{h.line} -> {h.text}" for h in external],
            "eligible": retired_ok,
            "note": target.note,
        }
        targets_payload.append(entry)
        verdict = "可退役" if retired_ok else "不可退役"
        print(f"  [{verdict}] {target.key} — {target.title}")
        for hit in internal:
            print(f"      退役集合内: {hit.path}:{hit.line}")
        for hit in external:
            print(f"      外部调用方: {hit.path}:{hit.line} -> {hit.text}")
        if not external and target.canonical_replacement is None:
            print("      无外部调用方，但 canonical 未承接该业务面：本阶段不退役")
        if target.note:
            print(f"      备注: {target.note}")
    payload["targets"] = targets_payload

    _section("CodeGraph 调用方证据")
    available, cg = _codegraph_evidence()
    payload["codegraph"] = cg
    if available:
        for symbol, output in cg["results"].items():
            lines = [ln for ln in output.splitlines() if ln.strip()]
            print(f"  {symbol}: {lines[0] if lines else '<无输出>'}")
    else:
        print("  本机没有 codegraph 二进制，复现命令：")
        for command in cg["commands"]:
            print(f"    {command}")
    print(
        "  限制（必须随证据一起读）：generate_insight 的生产派发走 .delay() 动态派发，"
        "静态调用图看不见 —— 因此「调用方清零」= 静态 0 未知调用方 + 派发点全部在退役集合内，"
        "HTTP 调用方在浏览器仓库外，不构成阻塞项。"
    )

    if args.skip_scenarios:
        scenarios_ok = None
        payload["scenarios"] = {"skipped": True}
        print("\n== 场景矩阵 == \n  已按 --skip-scenarios 跳过（CI/发布前必须补跑）")
    else:
        scenarios_ok, rows = _run_scenarios()
        payload["scenarios"] = {"skipped": False, "ok": scenarios_ok, "rows": rows}
        _section("场景矩阵（成功/失败/取消/重试/断线恢复/权限越权/成本异常/回滚演练）")
        for row in rows:
            print(f"  [{row['result']:4s}] {row['test']}")

    _section("切换时间窗与回滚")
    print(f"  切换时间窗: {SWITCH_WINDOW}")
    print(f"  回滚开关  : {ROLLBACK_SWITCH}")
    print(f"  回滚步骤  : {ROLLBACK_PROCEDURE}")
    print("  负责人    : Damon（后端工程师）；合并把关：代码质量工程师 Tia")
    print("  保留      : 旧 URL、历史只读端点与历史表在本阶段一律不删（回滚需要它们）")

    # 调用方那一票只看**本次要退役的面**（有 canonical 替代者）；本阶段明确不退役的
    # legacy_ai_summary 留着调用方是预期状态，不该把结论算成「未清零」。
    retire_now = [e for e in targets_payload if e["canonical_replacement"]]
    callers_ok = all(not e["external_calls"] for e in retire_now)
    pending = [e["key"] for e in targets_payload if not e["canonical_replacement"]]
    gate_ok = bool(metrics_ok and callers_ok and (scenarios_ok is not False))

    _section("门禁结论")
    print(f"  指标达标            : {'是' if metrics_ok else '否 ' + ','.join(reasons)}")
    print(
        f"  调用方清零          : {'是' if callers_ok else '否（见上方外部调用方）'}"
        f"（判定面：{', '.join(e['key'] for e in retire_now)}）"
    )
    if pending:
        print(f"  本阶段不退役        : {', '.join(pending)}（canonical 未承接，留待后续阶段）")
    print(f"  场景矩阵            : {'跳过' if scenarios_ok is None else ('通过' if scenarios_ok else '未通过')}")
    print(f"  canonical 退役门禁  : {'通过 —— 可进入退役流程（仍需人工拍板切换时间窗）' if gate_ok else '未通过 —— 按上方逐条补齐'}")

    payload["gate_passed"] = gate_ok
    if args.json_out:
        Path(args.json_out).write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"\n已写出 JSON 报告：{args.json_out}")

    return 0 if gate_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
