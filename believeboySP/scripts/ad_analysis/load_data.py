"""load_data — 从 Agent API 拉数据 + 项目配置加载（BLF-459 V3）。

V3 起 ``/api/v1/external/*`` 已下线（410 Gone），统一走 ``/api/v1/agent/*``
镜像（一对一路径 + Bearer/X-Agent-Id 鉴权 + ``{ok, data}`` 壳）。本模块在
``fetch`` 层解壳，调用方拿到的仍是 external 时代的裸数据形状
（``{project_id, period, data, summary}``），无需改动下游分析逻辑。

API 文档参考：
  - ../EXTERNAL_API_GUIDE.md
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import urllib.request
import urllib.error

try:
    import yaml
except ImportError as e:  # pragma: no cover
    raise SystemExit("PyYAML is required: pip install pyyaml") from e


# ── 端点定义 ──────────────────────────────────────────────────────────
ENDPOINTS = {
    "campaigns": "/projects/{id}/ad-campaigns",
    "search_terms": "/projects/{id}/ad-search-terms",
    "search_terms_raw": "/projects/{id}/ad-search-terms-raw",
    "search_term_shares": "/projects/{id}/ad-search-term-shares",
    "budgets": "/projects/{id}/ad-budgets",
    "placements": "/projects/{id}/ad-placements",
    "targets": "/projects/{id}/ad-targets",
    "time_trends": "/projects/{id}/ad-time-trends",
    "promoted_products": "/projects/{id}/ad-promoted-products",
    "purchased_products": "/projects/{id}/ad-purchased-products",
    "invalid_traffic": "/projects/{id}/ad-invalid-traffic",
    "orders_summary": "/projects/{id}/orders/summary",
    "upload_files": "/projects/{id}/ad-upload-files",
}


def _project_root() -> Path:
    """定位 believeboySP 根目录（向上 2 级到 scripts）。"""
    return Path(__file__).resolve().parent.parent.parent


def load_config(project_id: int) -> dict[str, Any]:
    """加载项目级配置：4-yuehan.yaml + 4-yuehan-taxonomy.yaml。

    Args:
        project_id: 项目 ID（用于文件名匹配）

    Returns:
        合并后的 dict，含 project / thresholds / sampling / taxonomy 等
    """
    root = _project_root() / "project-configs"
    main_path = root / f"{project_id}-*.yaml"
    candidates = sorted(root.glob(f"{project_id}-*.yaml"))
    if not candidates:
        raise FileNotFoundError(f"No config file for project {project_id} under {root}")

    # 找主配置（无 -taxonomy 后缀）和词典（带 -taxonomy 后缀）
    main_cfg, tax_cfg = None, None
    for c in candidates:
        name = c.stem
        if name.endswith("-taxonomy"):
            tax_cfg = c
        else:
            main_cfg = c
    if main_cfg is None:
        raise FileNotFoundError(
            f"No main config (e.g. {project_id}-yuehan.yaml) under {root}"
        )

    with open(main_cfg) as f:
        cfg = yaml.safe_load(f)
    if tax_cfg:
        with open(tax_cfg) as f:
            cfg["taxonomy"] = yaml.safe_load(f)
    return cfg


def _api_base() -> str:
    """API base URL（默认生产）。可通过 AD_ANALYSIS_API_BASE 环境变量覆盖。"""
    return os.environ.get("AD_ANALYSIS_API_BASE", "https://dash-api.believeboy.com")


def _auth_headers(cfg: dict[str, Any]) -> dict[str, str]:
    """agent 鉴权头：Authorization: Bearer <key> + X-Agent-Id。"""
    key = cfg.get("api", {}).get("agent_key") or os.environ.get(
        "AD_ANALYSIS_AGENT_KEY", ""
    )
    agent_id = cfg.get("api", {}).get("agent_id") or os.environ.get(
        "AD_ANALYSIS_AGENT_ID", ""
    )
    if not key or not agent_id:
        raise SystemExit(
            "Agent API 鉴权缺失：请在 project config 的 api 段配置 "
            "agent_key / agent_id（或在 AD_ANALYSIS_AGENT_KEY / "
            "AD_ANALYSIS_AGENT_ID 环境变量配置）"
        )
    return {"Authorization": f"Bearer {key}", "X-Agent-Id": agent_id}


def _unwrap_shell(payload: dict[str, Any]) -> dict[str, Any]:
    """agent ``{ok, data}`` 壳 → 返回 data（external 时代的裸响应形状）。"""
    if payload.get("ok") is True and isinstance(payload.get("data"), dict):
        return payload["data"]
    return payload


def _get_json(cfg: dict[str, Any], url: str, timeout: int = 30) -> dict[str, Any]:
    """带鉴权头发 GET 并解壳。"""
    req = urllib.request.Request(
        url,
        headers={**{"Accept": "application/json"}, **_auth_headers(cfg)},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = json.loads(resp.read().decode("utf-8"))
    return _unwrap_shell(raw)


def fetch(
    project_id: int,
    endpoint_key: str,
    country: str = "US",
    period: str = "30d",
    use_cache: bool = True,
    **extra_params,
) -> dict[str, Any]:
    """拉单个端点数据（带本地缓存）。

    Args:
        project_id: 项目 ID
        endpoint_key: ENDPOINTS 中的 key
        country: 国家代码（默认 US）
        period: 时间周期（7d / 14d / 30d / 90d / ytd / this_month / last_month / custom）
        use_cache: True 则优先读本地缓存
        **extra_params: 额外参数，如 limit / offset / order_by / start_date / end_date

    Returns:
        API 响应的 JSON（包含 project_id / period / data / summary 等字段）
    """
    cfg = load_config(project_id)
    cache_dir = Path(cfg.get("api", {}).get("cache_dir", "/tmp/ad-analysis")) / str(
        project_id
    )
    cache_dir.mkdir(parents=True, exist_ok=True)

    # 缓存 key 含所有参数
    params_hash = f"{endpoint_key}_{country}_{period}"
    if extra_params:
        params_hash += "_" + "_".join(
            f"{k}{v}" for k, v in sorted(extra_params.items())
        )
    cache_file = cache_dir / f"{params_hash}.json"

    if use_cache and cache_file.exists():
        with open(cache_file) as f:
            return json.load(f)

    # URL 拼接
    base = cfg.get("api", {}).get("base_url", _api_base())
    path_prefix = cfg.get("api", {}).get("path_prefix", "/api/v1/agent")
    path = ENDPOINTS[endpoint_key].format(id=project_id)
    url = f"{base}{path_prefix}{path}?country={country}&period={period}"
    for k, v in extra_params.items():
        url += f"&{k}={v}"

    data = _get_json(cfg, url)

    # 写缓存
    with open(cache_file, "w") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return data


def fetch_all(
    project_id: int,
    country: str = "US",
    period: str = "30d",
    use_cache: bool = True,
    endpoints: list[str] | None = None,
) -> dict[str, dict[str, Any]]:
    """拉多个端点数据。

    Args:
        project_id: 项目 ID
        country: 国家代码
        period: 时间周期
        use_cache: 是否使用缓存
        endpoints: 要拉的端点列表（默认全部）

    Returns:
        {endpoint_key: response_json} 字典
    """
    if endpoints is None:
        endpoints = list(ENDPOINTS.keys())
    result = {}
    for key in endpoints:
        try:
            result[key] = fetch(
                project_id, key, country=country, period=period, use_cache=use_cache
            )
        except (urllib.error.HTTPError, urllib.error.URLError) as e:
            print(f"[WARN] {key} 拉取失败: {e}")
            result[key] = {"data": [], "summary": {}}
    return result


def fetch_period(
    project_id: int,
    endpoint_key: str,
    country: str,
    start_date: str,
    end_date: str,
    use_cache: bool = True,
    **extra_params,
) -> dict[str, Any]:
    """拉自定义周期数据（period=custom）。

    Args:
        project_id: 项目 ID
        endpoint_key: ENDPOINTS 中的 key
        country: 国家代码
        start_date: YYYY-MM-DD
        end_date: YYYY-MM-DD
        use_cache: 是否缓存

    Returns:
        API 响应的 JSON
    """
    cfg = load_config(project_id)
    cache_dir = Path(cfg.get("api", {}).get("cache_dir", "/tmp/ad-analysis")) / str(
        project_id
    )
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file = (
        cache_dir / f"{endpoint_key}_{country}_custom_{start_date}_{end_date}.json"
    )

    if use_cache and cache_file.exists():
        with open(cache_file) as f:
            return json.load(f)

    base = cfg.get("api", {}).get("base_url", _api_base())
    path_prefix = cfg.get("api", {}).get("path_prefix", "/api/v1/agent")
    path = ENDPOINTS[endpoint_key].format(id=project_id)
    url = f"{base}{path_prefix}{path}?country={country}&period=custom&start_date={start_date}&end_date={end_date}"
    for k, v in extra_params.items():
        url += f"&{k}={v}"

    data = _get_json(cfg, url)
    with open(cache_file, "w") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return data
