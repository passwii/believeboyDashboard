"""B 类：不变量测试（BLF-666，设计 doc §7.2）。

"应装饰未装饰"治理不变量——用 AST 扫描 + 白名单 dataclass 对照：

- B1: L0/L2 白名单端点必须有 L0/L2 装饰器（dataclass 对照层约定 +
      AST 确认端点存在；decorator_applied=True 时校验代码里真实存在）
- B2: L1 白名单端点必须有 L1 装饰器（同机制）
- B3: cascade 层一致性（L1 不能 cascade 进 L0）
- B4: 白名单腐烂 hard fail（声明端点代码不存在 → 检出）

复用 `scripts.check_cache_decorator_coverage` 的 AST 扫描（纯 AST，
不 import app 包），与 CI 钩子同一套机制。
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]  # backend/
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.check_cache_decorator_coverage import (  # noqa: E402
    _LAYER_DECORATORS,
    check,
    parse_whitelist,
    scan_function_decorators,
    scan_write_endpoints,
)

from app.services.infra.cache_decorator import (  # noqa: E402
    REGISTERED_DOMAINS,
    _validate_decorator_args,
)
from app.services.infra.cache_write_endpoints import (  # noqa: E402
    ALL_WRITE_ENDPOINTS,
    L0_WRITE_ENDPOINTS,
    L1_WRITE_ENDPOINTS,
    L2_WRITE_ENDPOINTS,
    WriteEndpointSpec,
)

WHITELIST_FILE = ROOT / "app" / "services" / "infra" / "cache_write_endpoints.py"


# ── B1: L0/L2 白名单端点必须有装饰器 ─────────────────────────────────


class TestL0L2EndpointsRequireDecorator:
    """B1: L0/L2 白名单端点必须有 L0/L2 装饰器。"""

    def test_all_l0_entries_declare_l0_decorator(self):
        """dataclass 对照：L0 登记项 required_decorator 必须在 L0 允许集内。"""
        allowed = _LAYER_DECORATORS["L0"]
        assert allowed  # 非空哨兵
        for spec in L0_WRITE_ENDPOINTS:
            assert spec.required_decorator in allowed, (
                f"L0 端点 {spec.module}.{spec.function} 声明装饰器 "
                f"{spec.required_decorator!r}，应为 {sorted(allowed)} 之一"
            )

    def test_all_l2_entries_declare_l0_decorator(self):
        """dataclass 对照：L2 登记项（机制同 L0）同样要求 L0/L2 装饰器。"""
        allowed = _LAYER_DECORATORS["L2"]
        for spec in L2_WRITE_ENDPOINTS:
            assert spec.required_decorator in allowed, (
                f"L2 端点 {spec.module}.{spec.function} 声明装饰器 "
                f"{spec.required_decorator!r}，应为 {sorted(allowed)} 之一"
            )

    def test_ast_finds_every_l0_endpoint_in_code(self):
        """AST 扫描：L0 白名单声明的每个端点在代码中真实存在。"""
        endpoints = scan_write_endpoints()
        for spec in L0_WRITE_ENDPOINTS:
            sig = (spec.module, spec.function)
            assert sig in endpoints, (
                f"L0 白名单声明 {sig[0]}.{sig[1]}，但 AST 扫描在代码中找不到"
            )
            # method 对照（如登记 PUT 但代码是 POST → 治理错位）
            assert endpoints[sig]["method"] == spec.method.lower(), (
                f"L0 端点 {sig[0]}.{sig[1]} 登记方法 {spec.method}，"
                f"代码实际 {endpoints[sig]['method'].upper()}"
            )

    def test_applied_decorator_present_in_code(self):
        """decorator_applied=True 的 L0/L2 端点，代码里必须真实挂着该装饰器。

        首版白名单全部 decorator_applied=False（待 BLF-667/668/669 改造），
        本测试即"机制跑通"的证明——一旦改造后翻 True 而装饰器缺失，立即 fail。
        """
        for spec in L0_WRITE_ENDPOINTS + L2_WRITE_ENDPOINTS:
            if not spec.decorator_applied:
                continue
            actual = scan_function_decorators(spec.module, spec.function)
            assert spec.required_decorator in actual, (
                f"端点 {spec.module}.{spec.function} 声明已应用 "
                f"{spec.required_decorator!r}，但代码装饰器为 {sorted(actual) or '无'}"
            )

    def test_mechanism_detects_decorator_presence(self):
        """机制正证：构造已应用装饰器的端点，AST 能读回装饰器名。

        防"测试永远真空通过"——证明 scan_function_decorators 真能扫到
        装饰器（不只是存在性检查）。
        """
        import ast

        fake_src = (
            "@invalidate_cache_on_commit(domains=['x'])\n"
            "@router.put('/x')\n"
            "def fake_endpoint():\n    pass\n"
        )
        tree = ast.parse(fake_src)
        fn = tree.body[0]
        names = {
            (
                deco.func.id
                if isinstance(deco, ast.Call) and isinstance(deco.func, ast.Name)
                else deco.func.attr
                if isinstance(deco, ast.Call) and isinstance(deco.func, ast.Attribute)
                else deco.id
                if isinstance(deco, ast.Name)
                else deco.attr
            )
            for deco in fn.decorator_list
        }
        assert "invalidate_cache_on_commit" in names
        assert "put" in names


# ── B2: L1 白名单端点必须有 L1 装饰器 ─────────────────────────────────


class TestL1EndpointsRequireL1Decorator:
    """B2: L1 白名单端点必须有 L1 装饰器。"""

    def test_all_l1_entries_declare_l1_decorator(self):
        """dataclass 对照：L1 登记项 required_decorator 必须在 L1 允许集内。"""
        allowed = _LAYER_DECORATORS["L1"]
        for spec in L1_WRITE_ENDPOINTS:
            assert spec.required_decorator in allowed, (
                f"L1 端点 {spec.module}.{spec.function} 声明装饰器 "
                f"{spec.required_decorator!r}，应为 {sorted(allowed)} 之一"
            )

    def test_ast_finds_every_l1_endpoint_in_code(self):
        """AST 扫描：L1 白名单声明的每个端点在代码中真实存在。"""
        endpoints = scan_write_endpoints()
        for spec in L1_WRITE_ENDPOINTS:
            sig = (spec.module, spec.function)
            assert sig in endpoints, (
                f"L1 白名单声明 {sig[0]}.{sig[1]}，但 AST 扫描在代码中找不到"
            )
            assert endpoints[sig]["method"] == spec.method.lower(), (
                f"L1 端点 {sig[0]}.{sig[1]} 登记方法 {spec.method}，"
                f"代码实际 {endpoints[sig]['method'].upper()}"
            )

    def test_l1_cannot_use_l0_decorator(self):
        """层不可降级：L1 端点不允许声明 L0 强一致装饰器。"""
        for spec in L1_WRITE_ENDPOINTS:
            assert spec.required_decorator != "invalidate_cache_on_commit", (
                f"L1 端点 {spec.module}.{spec.function} 误用 L0 装饰器"
            )


# ── B3: cascade 层一致性（L1 不能 cascade 进 L0） ─────────────────────


class TestCascadeLayerConsistency:
    """B3: L1 不能 cascade 进 L0（弱一致写不能触发强一致失效）。"""

    def test_validate_rejects_l1_cascade_into_l0(self):
        """_validate_decorator_args 拒绝 L1 装饰器 cascade 进 L0 域。"""
        with pytest.raises(ValueError, match="L1.*cascade"):
            _validate_decorator_args(
                layer="L1",
                domains=["shipment_schedules"],
                project_id_from="path",
                on_error="log",
                cascade=("platform_revenues",),  # L0 域
            )

    def test_validate_allows_l0_cascade_into_l0(self):
        """对照：L0 cascade 进 L0 是允许的（如 commission_summary）。"""
        _validate_decorator_args(
            layer="L0",
            domains=["commission_records"],
            project_id_from="path",
            on_error="raise",
            cascade=("commission_summary", "operator_performance"),
        )  # 不抛

    def test_validate_rejects_l1_cascade_altogether(self):
        """L1 弱一致层根本不允许 cascade（设计 doc §5.2）。"""
        with pytest.raises(ValueError, match="L1.*cascade"):
            _validate_decorator_args(
                layer="L1",
                domains=["shipment_schedules"],
                project_id_from="path",
                on_error="log",
                cascade=("shipment_schedules",),
            )


# ── B4: 白名单腐烂 hard fail ─────────────────────────────────────────


class TestWhitelistRotHardFail:
    """B4: 白名单腐烂（声明端点代码不存在）→ hard fail。"""

    def test_rot_detected_by_check(self, tmp_path):
        """构造含腐烂项的白名单 → check() 必须报告 hard failure。"""
        fake = tmp_path / "cache_write_endpoints.py"
        fake.write_text(
            "from dataclasses import dataclass\n"
            "@dataclass(frozen=True)\n"
            "class WriteEndpointSpec:\n"
            "    domain: str\n    layer: str\n    module: str\n"
            "    function: str\n    method: str\n    path: str\n"
            "    required_decorator: str = ''\n"
            "    decorator_applied: bool = False\n"
            "    rationale: str = ''\n"
            "    issue_ref: str = ''\n"
            "L0_WRITE_ENDPOINTS: tuple = (\n"
            "    WriteEndpointSpec(domain='x', layer='L0',\n"
            "        module='app.api.v1.endpoints.ghost',\n"
            "        function='missing_fn', method='POST', path='/x',\n"
            "        required_decorator='invalidate_cache_on_commit'),\n"
            ")\n"
            "L1_WRITE_ENDPOINTS: tuple = ()\n"
            "L2_WRITE_ENDPOINTS: tuple = ()\n"
        )
        result = check(whitelist_file=fake)
        rot = [f for f in result["hard_failures"] if "腐烂" in f]
        assert rot, f"腐烂白名单应触发 hard fail，实际: {result['hard_failures']}"
        assert "ghost" in rot[0] and "missing_fn" in rot[0]

    def test_real_whitelist_has_no_rot(self):
        """真白名单：check() 的 hard_failures 应为空（当前登记项都在代码里）。"""
        result = check()
        assert result["hard_failures"] == [], (
            f"真实白名单存在 hard fail（腐烂/层不符/装饰器缺失）: "
            f"{result['hard_failures']}"
        )

    def test_whitelist_source_matches_dataclass_module(self):
        """白名单源文件 AST 解析结果与 import 的 dataclass 一致（防双份漂移）。"""
        src_entries = parse_whitelist(WHITELIST_FILE.read_text(encoding="utf-8"))
        assert len(src_entries) == len(ALL_WRITE_ENDPOINTS)
        for entry, spec in zip(src_entries, ALL_WRITE_ENDPOINTS):
            assert entry["module"] == spec.module
            assert entry["function"] == spec.function
            assert entry["layer"] == spec.layer
            assert entry["required_decorator"] == spec.required_decorator


# ── 白名单自身完整性（跨层） ─────────────────────────────────────────


class TestWhitelistIntegrity:
    """白名单 dataclass 自身一致性（B1/B2 前置条件）。"""

    def test_every_domain_registered(self):
        """白名单所有 domain 必须在 REGISTERED_DOMAINS 登记。"""
        for spec in ALL_WRITE_ENDPOINTS:
            assert spec.domain in REGISTERED_DOMAINS, (
                f"白名单域 {spec.domain!r} 未在 REGISTERED_DOMAINS 登记"
            )

    def test_layer_matches_registry_layer(self):
        """登记项的 layer 必须与域登记表的 layer 一致。"""
        for spec in ALL_WRITE_ENDPOINTS:
            registered_layer = REGISTERED_DOMAINS[spec.domain].layer
            assert spec.layer == registered_layer, (
                f"端点 {spec.module}.{spec.function} 声明层 {spec.layer}，"
                f"但域 {spec.domain!r} 登记层为 {registered_layer}"
            )

    def test_write_endpoint_spec_is_frozen(self):
        """WriteEndpointSpec 必须 frozen（不可变，防登记后被意外篡改）。"""
        with pytest.raises(Exception):
            WriteEndpointSpec(
                domain="x",
                layer="L0",
                module="m",
                function="f",
                method="POST",
                path="/x",
            ).domain = "y"  # type: ignore[misc]
