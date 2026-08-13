"""缓存治理 CI 钩子：白名单 vs 代码事实对照（BLF-665 子 #1）。

设计 §7.3：

- **hard fail**：白名单腐烂（声明的 module.function 在代码中不存在）→ exit 1
- **soft warn**：未登记写端点（代码有了但白名单无）→ log warning + exit 0

用法：``python -m backend.scripts.check_cache_decorator_coverage``（仓库根）
或 ``python scripts/check_cache_decorator_coverage.py``（backend/ 下）。
"""

from __future__ import annotations

import ast
import importlib.util
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
APP_ROOT = BACKEND_ROOT / "app"

# 直接以文件方式加载白名单模块，避免触发 app 包 __init__（settings/DB 依赖）
_WL_PATH = BACKEND_ROOT / "app" / "services" / "infra" / "cache_write_endpoints.py"
_wl_spec = importlib.util.spec_from_file_location("cache_write_endpoints", _WL_PATH)
_wl_mod = importlib.util.module_from_spec(_wl_spec)
assert _wl_spec.loader is not None
sys.modules["cache_write_endpoints"] = _wl_mod  # dataclass 需要模块注册
_wl_spec.loader.exec_module(_wl_mod)

ALL_WRITE_ENDPOINTS = _wl_mod.ALL_WRITE_ENDPOINTS
L0_WRITE_ENDPOINTS = _wl_mod.L0_WRITE_ENDPOINTS
L1_WRITE_ENDPOINTS = _wl_mod.L1_WRITE_ENDPOINTS
L2_WRITE_ENDPOINTS = _wl_mod.L2_WRITE_ENDPOINTS
WriteEndpointSpec = _wl_mod.WriteEndpointSpec

# 扫描范围：FastAPI 路由 + Celery 任务
WRITE_METHODS = {"post", "put", "patch", "delete"}

ENDPOINT_DIRS = [
    APP_ROOT / "api" / "v1" / "endpoints",
    APP_ROOT / "celery_tasks",
]

# 命中任一即视为「缓存相关模块」，soft warn 只在该类模块上扫描
_CACHE_IMPORT_MARKERS = (
    "from app.services.infra",
    "import app.services.infra",
    "from app.services import infra",
)


def _module_uses_cache_infra(source: str) -> bool:
    """模块是否引用了缓存基础设施（cache / inventory_cache / product_cache 等）。"""
    return any(marker in source for marker in _CACHE_IMPORT_MARKERS)


def _module_to_path(module: str) -> Path:
    """dotted path → 源文件路径。模块可能以 ``app.`` 开头或裸路径。"""
    if module.startswith("app."):
        rel = module[len("app.") :]
    else:
        rel = module
    return APP_ROOT / Path(*rel.split(".")).with_suffix(".py")


def scan_write_functions(module_path: Path, module_name: str) -> set[tuple[str, str]]:
    """扫描模块中的写函数：返回 {(function_name, decorator_hint)}。

    - FastAPI：@router.post/put/patch/delete 装饰的函数
    - Celery：@shared_task / @app.task / @celery.task 装饰的函数
    """
    if not module_path.exists():
        return set()
    try:
        tree = ast.parse(
            module_path.read_text(encoding="utf-8"), filename=str(module_path)
        )
    except SyntaxError:
        return set()

    found: set[tuple[str, str]] = set()
    for node in tree.body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for dec in node.decorator_list:
            base = dec.func if isinstance(dec, ast.Call) else dec
            if isinstance(base, ast.Attribute) and base.attr in WRITE_METHODS:
                # @router.post(...) 形态
                found.add((node.name, base.attr))
            elif isinstance(base, ast.Name) and base.id in WRITE_METHODS:
                # @post(...) 形态
                found.add((node.name, base.id))
    return found


def scan_celery_tasks(module_path: Path) -> set[str]:
    """扫描模块中的 Celery 任务函数名（@shared_task / @app.task / @celery.task）。"""
    if not module_path.exists():
        return set()
    try:
        tree = ast.parse(
            module_path.read_text(encoding="utf-8"), filename=str(module_path)
        )
    except SyntaxError:
        return set()

    celery_names = {
        "shared_task",
        "task",
        "celery",
        "app",  # @app.task 形态
    }
    tasks: set[str] = set()
    for node in tree.body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for dec in node.decorator_list:
            base = dec.func if isinstance(dec, ast.Call) else dec
            if (
                isinstance(base, ast.Attribute)
                and base.attr == "task"
                and isinstance(base.value, ast.Name)
                and base.value.id in ("app", "celery")
            ):
                tasks.add(node.name)
            elif isinstance(base, ast.Name) and base.id in (
                "shared_task",
                "celery",
                "task",
            ):
                tasks.add(node.name)
    return tasks


def main() -> int:
    hard_fails: list[str] = []
    soft_warns: list[str] = []
    ok_count = 0

    # 白名单腐烂检查（hard fail）
    for spec in ALL_WRITE_ENDPOINTS():
        path = _module_to_path(spec.module)
        if not path.exists():
            hard_fails.append(
                f"WHITELIST_ROT 模块不存在: {spec.module}（声明 {spec.function}）—— "
                "删除白名单条目或恢复代码"
            )
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        exists = any(
            isinstance(node, ast.FunctionDef) and node.name == spec.function
            for node in tree.body
        )
        if not exists:
            hard_fails.append(
                f"WHITELIST_ROT 函数不存在: {spec.module}.{spec.function}—— "
                "删除白名单条目或恢复代码"
            )
        else:
            ok_count += 1

    # 未登记写端点检查（soft warn）
    for module_name in ("app.api.v1.endpoints", "app.celery_tasks"):
        base = APP_ROOT / Path(*module_name.split(".")[1:])
        if not base.exists():
            continue
        for path in sorted(base.rglob("*.py")):
            if path.name.startswith("__"):
                continue
            rel = path.relative_to(APP_ROOT)
            module_dotted = "app." + ".".join(rel.with_suffix("").parts)
            source = path.read_text(encoding="utf-8")

            # 仅缓存相关模块做未登记检查（避免全仓噪音）
            if not _module_uses_cache_infra(source):
                continue

            # FastAPI 写端点
            write_fns = scan_write_functions(path, module_dotted)
            for fn_name, method in write_fns:
                declared = any(
                    s.module == module_dotted and s.function == fn_name
                    for s in ALL_WRITE_ENDPOINTS()
                )
                if not declared:
                    soft_warns.append(
                        f"SOFT_WARN 未登记写端点: {module_dotted}.{fn_name} ({method.upper()})—— "
                        "如涉及缓存域，请加入 cache_write_endpoints.py 白名单"
                    )

            # Celery 任务（写任务候选）
            celery_tasks = scan_celery_tasks(path)
            for task_name in celery_tasks:
                declared = any(
                    s.module == module_dotted and s.function == task_name
                    for s in ALL_WRITE_ENDPOINTS()
                )
                if not declared:
                    soft_warns.append(
                        f"SOFT_WARN 未登记 Celery 任务: {module_dotted}.{task_name}—— "
                        "如含写路径且涉及缓存域，请登记白名单"
                    )

    print("=== cache decorator coverage ===")
    print(
        f"L0: {len(L0_WRITE_ENDPOINTS)} | L1: {len(L1_WRITE_ENDPOINTS)} | L2: {len(L2_WRITE_ENDPOINTS)}"
    )
    print(f"白名单校验通过: {ok_count}")

    for fail in hard_fails:
        print(f"[HARD FAIL] {fail}")
    for warn in soft_warns:
        print(f"[SOFT WARN] {warn}")

    if hard_fails:
        print(f"\n结果: FAIL（{len(hard_fails)} 个 hard fail）")
        return 1
    print(f"\n结果: PASS（hard fail = 0，soft warn = {len(soft_warns)}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
