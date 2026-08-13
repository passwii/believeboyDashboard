#!/usr/bin/env python3
"""
check_cache_decorator_coverage.py — 缓存写端点白名单覆盖守护（BLF-666）

多 Agent 并行开发缓存治理时，写端点新增/改名容易漏登记白名单，导致
"写后失效"靠手工纪律（BLF-633 根因）。本脚本把"协调错误"变成"可检测错误"：

  ① hard fail：白名单腐烂——登记表声明了端点，但代码里不存在 → exit 1
  ② soft warn：未登记写端点——代码有 @router.POST/PUT/PATCH/DELETE，
     但白名单没有 → warning + exit 0（提示补登记，不阻断）
  ③ dataclass 对照：L0/L2 登记项必须声明 L0/L2 装饰器、L1 必须声明 L1
     装饰器（层约定一致）；decorator_applied=True 时 AST 校验装饰器真实存在

纯 AST 解析，不 import app 包 / 不连数据库 / 不需要环境变量（与
check_alembic.py 同策略），可安全跑在任何环境（本地、CI、VPS 部署前）。

用法:
    cd backend && python scripts/check_cache_decorator_coverage.py
    cd backend && python -m scripts.check_cache_decorator_coverage

退出码: 0 = 通过（可含 soft warn）；1 = 未通过（hard fail，stderr 给修复提示）
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

# ── 路径定位 ──────────────────────────────────────────────────────────

# scripts/ 的父目录 = backend/
_BACKEND_ROOT = Path(__file__).resolve().parents[1]

# 白名单源文件（AST 解析，不 import）
_WHITELIST_FILE = (
    _BACKEND_ROOT / "app" / "services" / "infra" / "cache_write_endpoints.py"
)

# 端点扫描目录
_ENDPOINT_DIRS = (
    _BACKEND_ROOT / "app" / "api" / "v1" / "endpoints",
    _BACKEND_ROOT / "app" / "api" / "v1" / "endpoints" / "agent",
    _BACKEND_ROOT / "app" / "api" / "v1" / "endpoints" / "system_management",
)

# 写方法（白名单治理范围）
_WRITE_METHODS = {"post", "put", "patch", "delete"}

# 层 → 允许的装饰器名（治理约定）
_LAYER_DECORATORS = {
    "L0": {"invalidate_cache_on_commit", "invalidate_cache_on_commit_celery"},
    "L1": {"invalidate_cache_on_commit_l1", "invalidate_cache_on_commit_celery"},
    "L2": {"invalidate_cache_on_commit", "invalidate_cache_on_commit_celery"},
}


# ── AST 解析：白名单 ──────────────────────────────────────────────────


def parse_whitelist(source: str) -> list[dict]:
    """从 cache_write_endpoints.py 源码提取 WriteEndpointSpec 登记项。

    纯 AST 求值（只允许字面量 / 模块内常量引用），返回 dict 列表。
    """
    tree = ast.parse(source)
    consts: dict[str, object] = {}

    def resolve(node: ast.AST) -> object:
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, ast.Name):
            return consts.get(node.id)
        if isinstance(node, ast.Tuple):
            return tuple(resolve(e) for e in node.elts)
        if isinstance(node, ast.List):
            return [resolve(e) for e in node.elts]
        raise ValueError(f"无法静态求值的节点: {ast.dump(node)}")

    # 第一遍：收集模块级常量（DECORATOR_*）
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            if isinstance(node.targets[0], ast.Name):
                try:
                    consts[node.targets[0].id] = resolve(node.value)
                except ValueError:
                    pass

    entries: list[dict] = []
    for name in ("L0_WRITE_ENDPOINTS", "L1_WRITE_ENDPOINTS", "L2_WRITE_ENDPOINTS"):
        for node in tree.body:
            # 兼容 `X = (...)` (Assign) 与 `X: Type = (...)` (AnnAssign)
            target = None
            if isinstance(node, ast.Assign) and len(node.targets) == 1:
                target = node.targets[0]
            elif isinstance(node, ast.AnnAssign):
                target = node.target
            if not (isinstance(target, ast.Name) and target.id == name):
                continue
            layer = name.split("_")[0]
            value = node.value if isinstance(node, ast.Assign) else node.value
            if value is None or not isinstance(value, ast.Tuple):
                continue
            for item in value.elts:
                kwargs = {}
                for kw in item.keywords:
                    kwargs[kw.arg] = resolve(kw.value)
                kwargs["layer"] = layer
                entries.append(kwargs)
    return entries


def load_whitelist(whitelist_file: Path | None = None) -> list[dict]:
    """读取并解析白名单源文件。"""
    path = whitelist_file or _WHITELIST_FILE
    return parse_whitelist(path.read_text(encoding="utf-8"))


# ── AST 解析：代码中的写端点 ──────────────────────────────────────────


def scan_write_endpoints(root: Path | None = None) -> dict[tuple[str, str], dict]:
    """扫描 endpoints 目录下所有 @router.<METHOD>（POST/PUT/PATCH/DELETE）。

    返回 {(module_dotted, function_name): {"method": ..., "path": ...}}。
    兼容 ``@router.xxx`` 与 ``@<name>_router.xxx`` 两种装饰器形态。
    """
    root = root or _BACKEND_ROOT
    found: dict[tuple[str, str], dict] = {}

    def _walk(directory: Path):
        if not directory.exists():
            return
        for py in directory.rglob("*.py"):
            if py.name.startswith("_"):
                continue
            rel = py.relative_to(root)
            module = ".".join(rel.with_suffix("").parts)
            try:
                tree = ast.parse(py.read_text(encoding="utf-8"))
            except (SyntaxError, UnicodeDecodeError):
                continue
            for node in tree.body:
                if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    continue
                for deco in node.decorator_list:
                    method, path = _parse_router_decorator(deco)
                    if method and method in _WRITE_METHODS:
                        found[(module, node.name)] = {"method": method, "path": path}
                        break

    for d in _ENDPOINT_DIRS:
        _walk(d)
    return found


def _parse_router_decorator(deco: ast.AST) -> tuple[str | None, str | None]:
    """解析 ``@router.post("/x")`` / ``@xxx_router.put(...)`` 装饰器。

    返回 (method_lowercase, path)；非 router 装饰器返回 (None, None)。
    """
    if not isinstance(deco, ast.Call):
        return None, None
    func = deco.func
    if not isinstance(func, ast.Attribute):
        return None, None
    method = func.attr
    if method not in _WRITE_METHODS:
        return None, None
    obj = func.value
    if not (
        isinstance(obj, ast.Name) and (obj.id == "router" or obj.id.endswith("_router"))
    ):
        return None, None
    path = None
    if deco.args and isinstance(deco.args[0], ast.Constant):
        path = str(deco.args[0].value)
    return method, path


def scan_function_decorators(root: Path | None, module: str, function: str) -> set[str]:
    """读取某模块某函数的装饰器名集合（AST）。

    用于 B1/B2 的 decorator_applied=True 校验——确认代码里装饰器真实存在。
    """
    root = root or _BACKEND_ROOT
    rel = Path(*module.split(".")).with_suffix(".py")
    py = root / rel
    if not py.exists():
        return set()
    try:
        tree = ast.parse(py.read_text(encoding="utf-8"))
    except (SyntaxError, UnicodeDecodeError):
        return set()
    for node in tree.body:
        if (
            isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and node.name == function
        ):
            names = set()
            for deco in node.decorator_list:
                if isinstance(deco, ast.Call):
                    target = deco.func
                else:
                    target = deco
                if isinstance(target, ast.Name):
                    names.add(target.id)
                elif isinstance(target, ast.Attribute):
                    names.add(target.attr)
            return names
    return set()


# ── 检查逻辑 ──────────────────────────────────────────────────────────


def check(
    root: Path | None = None,
    whitelist_file: Path | None = None,
) -> dict:
    """执行白名单覆盖检查。

    Returns:
        {
          "hard_failures": [str, ...],   # 非空 → exit 1
          "soft_warnings": [str, ...],   # 非空 → warning（exit 0）
          "endpoints": {...},            # 代码扫描结果
          "whitelist": [...],            # 白名单解析结果
        }
    """
    root = root or _BACKEND_ROOT
    whitelist = load_whitelist(whitelist_file)
    endpoints = scan_write_endpoints(root)

    hard_failures: list[str] = []
    soft_warnings: list[str] = []
    endpoints_by_sig = {(e["module"], e["function"]): e for e in whitelist}

    # ① hard fail：白名单腐烂（声明但代码不存在）
    for entry in whitelist:
        sig = (entry["module"], entry["function"])
        if sig not in endpoints:
            hard_failures.append(
                f"白名单腐烂: {entry['layer']} 域 {entry['domain']!r} "
                f"声明端点 {sig[0]}.{sig[1]} 在代码中不存在"
            )

    # ② soft warn：未登记写端点（代码有但白名单无）
    for (module, function), meta in endpoints.items():
        if (module, function) not in endpoints_by_sig:
            soft_warnings.append(
                f"未登记写端点: {module}.{function} "
                f"({meta['method']} {meta['path']})——请补登记到 cache_write_endpoints.py"
            )

    # ③ dataclass 对照：层 → 装饰器约定 + decorator_applied 真实存在
    for entry in whitelist:
        layer = entry["layer"]
        required = entry.get("required_decorator", "")
        allowed = _LAYER_DECORATORS.get(layer, set())
        if required not in allowed:
            hard_failures.append(
                f"层约定不符: {layer} 域 {entry['domain']!r} 声明装饰器 "
                f"{required!r}，应为 {sorted(allowed)} 之一"
            )
        if entry.get("decorator_applied") is True:
            sig = (entry["module"], entry["function"])
            actual = scan_function_decorators(root, sig[0], sig[1])
            if required not in actual:
                hard_failures.append(
                    f"装饰器缺失: {sig[0]}.{sig[1]} 声明已应用 {required!r}，"
                    f"但代码装饰器为 {sorted(actual) or '无'}"
                )

    return {
        "hard_failures": hard_failures,
        "soft_warnings": soft_warnings,
        "endpoints": endpoints,
        "whitelist": whitelist,
    }


def main() -> int:
    result = check()
    hard = result["hard_failures"]
    soft = result["soft_warnings"]

    for msg in soft:
        print(f"[warn] {msg}", file=sys.stderr)
    for msg in hard:
        print(f"[FAIL] {msg}", file=sys.stderr)

    if hard:
        print(
            f"\ncheck_cache_decorator_coverage: {len(hard)} hard failure(s) —— "
            "缓存治理阻断。修复提示：白名单声明了代码中不存在的端点时，"
            "删除或修正登记项；层约定不符时改用对应层装饰器名。",
            file=sys.stderr,
        )
        return 1

    print(
        f"check_cache_decorator_coverage: OK "
        f"（白名单 {len(result['whitelist'])} 项 / "
        f"写端点 {len(result['endpoints'])} 个 / "
        f"soft warn {len(soft)} 条）"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
