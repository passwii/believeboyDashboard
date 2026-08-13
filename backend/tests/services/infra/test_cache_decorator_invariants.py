"""B 类不变量测试：应失效但未装饰的 4 个场景（BLF-665 子 #1）。

设计 §7.2：

| # | 场景 | 防护 |
|---|---|---|
| B1 | L0/L2 白名单端点必须有装饰器 | AST 扫描 + dataclass 对照 |
| B2 | L1 白名单端点必须有 L1 装饰器 | 同上 |
| B3 | cascade 域必须同层或更高（不允许 L1 cascade 进 L0） | 层约束 |
| B4 | 白名单腐烂（声明的端点代码不存在）→ hard fail | 维护纪律 |

B1/B2 使用 AST 静态扫描 ``app/`` 下的真实源码，对照 ``cache_write_endpoints.py``
白名单——不依赖运行时的函数是否被调用，只校验「声明即事实」。
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

from app.services.infra import cache_decorator as cd
from app.services.infra.cache_write_endpoints import (
    ALL_WRITE_ENDPOINTS,
    L0_WRITE_ENDPOINTS,
    L1_WRITE_ENDPOINTS,
    L2_WRITE_ENDPOINTS,
    WriteEndpointSpec,
)

BACKEND_ROOT = Path(__file__).resolve().parents[3]  # backend/
APP_ROOT = BACKEND_ROOT / "app"

# 允许的装饰器集合
DECORATOR_L0_L2 = {"invalidate_cache_on_commit"}
DECORATOR_L1 = {"invalidate_cache_on_commit_l1", "invalidate_cache_on_commit_celery"}


def _module_to_path(module: str) -> Path:
    """dotted path → 源文件路径（app/ 下）。"""
    return APP_ROOT / Path(*module.split(".")[1:]).with_suffix(".py")


def _function_decorators(module: str, function: str) -> set[str]:
    """AST 扫描：返回某函数上的装饰器名集合（含 @router.* 的 router 前缀剥离）。"""
    path = _module_to_path(module)
    if not path.exists():
        return set()
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for node in tree.body:
        if (
            isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and node.name == function
        ):
            names: set[str] = set()
            for dec in node.decorator_list:
                if isinstance(dec, ast.Call):
                    base = dec.func
                else:
                    base = dec
                # 支持 @foo.bar 与 @bar 两种形态
                if isinstance(base, ast.Attribute):
                    names.add(base.attr)
                elif isinstance(base, ast.Name):
                    names.add(base.id)
            return names
    return set()


def _specs_with_decorator(specs) -> list[WriteEndpointSpec]:
    return [s for s in specs if s.decorator]


class TestB1L0L2EndpointsMustHaveDecorator:
    """B1：L0/L2 白名单端点必须有装饰器（AST 扫描 + dataclass 对照）。

    首版白名单 decorator 字段为空（待子 #2/#4 改造），parametrize 为空；
    子 issue 落地后此测试自动变为非空并开始强制校验。扫描机制由
    ``test_scanner_detects_decorator`` 显式验证，防止 B1 空转。
    """

    @pytest.mark.parametrize(
        "spec",
        _specs_with_decorator(L0_WRITE_ENDPOINTS + L2_WRITE_ENDPOINTS),
        ids=lambda s: f"{s.module}.{s.function}",
    )
    def test_l0_l2_spec_decorator_matches_code(self, spec):
        decorators = _function_decorators(spec.module, spec.function)
        assert decorators, (
            f"白名单声明 {spec.module}.{spec.function} 应有装饰器 {spec.decorator}，"
            "但源码中找不到该函数"
        )
        assert spec.decorator in decorators, (
            f"{spec.module}.{spec.function} 应有 {spec.decorator}，实际装饰器: {decorators}"
        )

    def test_scanner_detects_decorator(self):
        """机制自检：AST 扫描能识别装饰器（防止 B1/B2 首版空转）。"""
        sample = (
            "from app.services.infra.cache_decorator import invalidate_cache_on_commit\n"
            "@invalidate_cache_on_commit(domains=['x'])\n"
            "def _sample(): pass\n"
        )
        tree = ast.parse(sample)
        got = set()
        for node in tree.body:
            if isinstance(node, ast.FunctionDef):
                for dec in node.decorator_list:
                    if isinstance(dec, ast.Call):
                        base = dec.func
                    else:
                        base = dec
                    if isinstance(base, ast.Attribute):
                        got.add(base.attr)
                    elif isinstance(base, ast.Name):
                        got.add(base.id)
        assert "invalidate_cache_on_commit" in got, "扫描器应识别装饰器名"

    def test_scanner_detects_function_in_real_module(self):
        """扫描器在真实模块上工作：能找到白名单中的函数定义。"""
        assert _function_exists(
            "app.api.v1.endpoints.inventory_replenishment",
            "update_inventory_replenishment_setting",
        ), "扫描器应能在真实端点模块中找到白名单函数"


class TestB2L1EndpointsMustHaveL1Decorator:
    """B2：L1 白名单端点必须有 L1 装饰器。"""

    @pytest.mark.parametrize(
        "spec",
        _specs_with_decorator(L1_WRITE_ENDPOINTS),
        ids=lambda s: f"{s.module}.{s.function}",
    )
    def test_l1_spec_decorator_matches_code(self, spec):
        decorators = _function_decorators(spec.module, spec.function)
        assert decorators, (
            f"白名单声明 {spec.module}.{spec.function} 应有 L1 装饰器，"
            "但源码中找不到该函数"
        )
        assert spec.decorator in DECORATOR_L1, (
            f"{spec.module}.{spec.function} 的装饰器 {spec.decorator} 不是 L1 装饰器"
        )
        assert spec.decorator in decorators, (
            f"{spec.module}.{spec.function} 应有 {spec.decorator}，实际装饰器: {decorators}"
        )


class TestB3CascadeLayerConsistency:
    """B3：cascade 域必须同层或更高（不允许 L1 cascade 进 L0）。"""

    def test_whitelist_cascade_no_l1_to_l0(self):
        """白名单中所有 cascade 声明不得让弱层（L1）级联进强层（L0）。"""
        for spec in ALL_WRITE_ENDPOINTS():
            if not spec.cascade:
                continue
            source_strength = cd._LAYER_STRENGTH[spec.domain]
            for target in spec.cascade:
                assert cd._LAYER_STRENGTH[target] <= source_strength, (
                    f"{spec.domain} cascade → {target} 违反层约束（B3）"
                )

    def test_decorator_rejects_l1_cascade_to_l0(self):
        """装饰器启动期校验拒绝 L1 域 cascade 进 L0 域。"""
        with pytest.raises(ValueError, match="cascade"):

            @cd.invalidate_cache_on_commit(
                domains=["shipment_schedules"],  # L1
                cascade=["inventory_replenishment"],  # L0 —— 不允许
            )
            def endpoint():
                return "ok"


class TestB4WhitelistRotHardFail:
    """B4：白名单腐烂（声明的端点代码不存在）→ hard fail。"""

    @pytest.mark.parametrize(
        "spec", ALL_WRITE_ENDPOINTS(), ids=lambda s: f"{s.module}.{s.function}"
    )
    def test_spec_target_exists_in_code(self, spec):
        path = _module_to_path(spec.module)
        assert path.exists(), (
            f"白名单腐烂: 模块 {spec.module} 不存在（{path}）—— 删除白名单条目或恢复代码"
        )
        assert _function_exists(spec.module, spec.function), (
            f"白名单腐烂: 函数 {spec.module}.{spec.function} 不存在 —— 删除白名单条目或恢复代码"
        )


def _function_exists(module: str, function: str) -> bool:
    """AST 扫描：函数定义是否存在。"""
    path = _module_to_path(module)
    if not path.exists():
        return False
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    return any(
        isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name == function
        for node in tree.body
    )


class TestWhitelistBasics:
    """白名单自身一致性。"""

    def test_domain_registered(self):
        for spec in ALL_WRITE_ENDPOINTS():
            assert spec.domain in cd.REGISTERED_DOMAINS, (
                f"白名单域 {spec.domain} 未在 REGISTERED_DOMAINS 注册"
            )

    def test_l0_decorator_on_error_consistent(self):
        for spec in L0_WRITE_ENDPOINTS:
            assert spec.on_error != "log", "L0 不允许 on_error=log（与 A5 一致）"

    def test_l1_decorator_on_error_consistent(self):
        for spec in _specs_with_decorator(L1_WRITE_ENDPOINTS):
            assert spec.on_error == "log", "L1 必须 on_error=log（best_effort）"
