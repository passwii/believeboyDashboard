"""
Ad Analysis Agent Pipeline — 主入口
====================================

将四层串联为完整流程：
  Layer 0: DataProfiler   → DataProfile
  Layer 1: StrategyPlanner → AnalysisStrategy
  Layer 2: PromptAssembler → system_prompt + user_message
  LLM 生成 → 流式输出
  Layer 3: EvolutionEngine → 提取元数据、记录运行
"""
from __future__ import annotations

import logging
from typing import Any, Iterator

from sqlalchemy.orm import Session

from app.core.config import Settings
from app.services.ad_agent import (
    AnalysisResult,
    AnalysisStrategy,
    DataProfile,
)
from app.services.ad_agent.config_loader import load_registry, RegistryConfig
from app.services.ad_agent.data_profiler import profile_data
from app.services.ad_agent.strategy_planner import plan_strategy
from app.services.ad_agent.prompt_assembler import (
    assemble_system_prompt,
    assemble_user_message,
    _build_strategy_declaration,
)
from app.services.ad_agent.evolution_engine import (
    extract_run_metadata,
    record_run,
    record_run_to_db,
)

logger = logging.getLogger(__name__)

# ── 格式后处理（复用现有逻辑）──────────────────────────────────────────────
from app.services.ai_insight_generator import normalize_insight_markdown


def run_ad_agent_pipeline(
    aggregated_data: dict[str, Any],
    settings: Settings,
    *,
    project_id: int = 0,
    project_name: str = "",
    country: str = "",
    date_range_start: str = "",
    date_range_end: str = "",
    project_context_text: str = "",
    sku_context_text: str = "",
    user_message: str | None = None,
    model: str | None = None,
    registry: RegistryConfig | None = None,
    insight_id: int | None = None,
) -> AnalysisResult:
    """同步执行完整的 Agent Pipeline（非流式）。

    对外接口，供需要一次性获取完整结果的场景使用。
    """
    from app.services import ai as ai_chat_service

    if registry is None:
        registry = load_registry()

    # Layer 0
    data_profile = profile_data(aggregated_data, registry)
    logger.info("DataProfile: %d available, %d skipped",
                len(data_profile.available_dimensions),
                len(data_profile.skipped_dimensions))

    # Layer 1
    strategy = plan_strategy(data_profile, registry)
    logger.info("Strategy: %s", strategy.strategy_summary)

    # Layer 2
    strategy_declaration = _build_strategy_declaration(strategy, data_profile)
    system_prompt = assemble_system_prompt(strategy, data_profile, registry)
    user_content = assemble_user_message(
        aggregated_data, strategy_declaration,
        project_context_text, sku_context_text, user_message,
    )

    # LLM 调用
    if not ai_chat_service.is_provider_configured(settings):
        raise RuntimeError("AI Provider 未配置")

    models, default_model = ai_chat_service.resolve_available_models(settings)
    selected_model = model or default_model

    llm_config = ai_chat_service.build_llm_config(
        settings=settings,
        model=selected_model,
        system_prompt=system_prompt,
        reasoning_effort=None,
    )

    content = ai_chat_service.generate_assistant_content(
        llm_config=llm_config,
        messages=[],
        user_content=user_content,
    )

    content = normalize_insight_markdown(content)

    # Layer 3
    metadata = extract_run_metadata(
        insight_id=insight_id,
        project_id=project_id,
        project_name=project_name,
        country=country,
        date_range_start=date_range_start,
        date_range_end=date_range_end,
        data_profile=data_profile,
        strategy=strategy,
        content=content,
    )
    record_run(metadata)

    return AnalysisResult(
        content=content,
        strategy_declaration=strategy_declaration,
        data_profile=data_profile,
        strategy=strategy,
        evolution_metadata=metadata.to_dict(),
    )


def run_ad_agent_pipeline_stream(
    aggregated_data: dict[str, Any],
    settings: Settings,
    *,
    project_id: int = 0,
    project_name: str = "",
    country: str = "",
    date_range_start: str = "",
    date_range_end: str = "",
    project_context_text: str = "",
    sku_context_text: str = "",
    user_message: str | None = None,
    model: str | None = None,
    registry: RegistryConfig | None = None,
    db: Session | None = None,
    insight_id: int | None = None,
) -> Iterator[dict[str, Any]]:
    """流式执行 Agent Pipeline。

    依次 yield：
      {"type": "profile", "data": {...}}
      {"type": "strategy", "data": {...}}
      {"type": "declaration", "text": "..."}
      {"type": "chunk", "delta": "..."}   (多次)
      {"type": "done", "content": "...", "evolution_metadata": {...}}
    """
    from app.services import ai as ai_chat_service

    if registry is None:
        registry = load_registry()

    # Layer 0
    data_profile = profile_data(aggregated_data, registry)
    yield {"type": "profile", "data": data_profile.to_dict()}

    # Layer 1
    strategy = plan_strategy(data_profile, registry)
    yield {"type": "strategy", "data": strategy.to_dict()}

    # Layer 2
    strategy_declaration = _build_strategy_declaration(strategy, data_profile)
    yield {"type": "declaration", "text": strategy_declaration}

    system_prompt = assemble_system_prompt(strategy, data_profile, registry)
    user_content = assemble_user_message(
        aggregated_data, strategy_declaration,
        project_context_text, sku_context_text, user_message,
    )

    # LLM 流式调用
    if not ai_chat_service.is_provider_configured(settings):
        raise RuntimeError("AI Provider 未配置")

    models, default_model = ai_chat_service.resolve_available_models(settings)
    selected_model = model or default_model

    llm_config = ai_chat_service.build_llm_config(
        settings=settings,
        model=selected_model,
        system_prompt=system_prompt,
        reasoning_effort=None,
    )

    full_content = ""
    for chunk in ai_chat_service.stream_assistant_content(
        llm_config=llm_config,
        messages=[],
        user_content=user_content,
        settings=settings,
    ):
        if isinstance(chunk, dict):
            if chunk.get("type") == "thinking":
                continue
            delta = chunk.get("content", "")
        elif isinstance(chunk, str):
            delta = chunk
        else:
            continue

        if delta:
            full_content += delta
            yield {"type": "chunk", "delta": delta}

    # 格式后处理
    full_content = normalize_insight_markdown(full_content)

    # Layer 3
    metadata = extract_run_metadata(
        insight_id=insight_id,
        project_id=project_id,
        project_name=project_name,
        country=country,
        date_range_start=date_range_start,
        date_range_end=date_range_end,
        data_profile=data_profile,
        strategy=strategy,
        content=full_content,
    )
    if db is not None:
        try:
            record_run_to_db(db, metadata)
            # DB 写入成功，避免重复写入内存历史
            record_run(metadata, skip_if_db=True)
        except Exception as exc:
            logger.warning("Failed to persist run to DB, falling back to in-memory: %s", exc)
            record_run(metadata)
    else:
        record_run(metadata)

    yield {
        "type": "done",
        "content": full_content,
        "strategy_declaration": strategy_declaration,
        "evolution_metadata": metadata.to_dict(),
    }


def run_ad_agent_pipeline_multi_pass_stream(
    aggregated_data: dict[str, Any],
    settings: Settings,
    *,
    project_id: int = 0,
    project_name: str = "",
    country: str = "",
    date_range_start: str = "",
    date_range_end: str = "",
    project_context_text: str = "",
    sku_context_text: str = "",
    user_message: str | None = None,
    model: str | None = None,
    registry: RegistryConfig | None = None,
    db: Session | None = None,
    insight_id: int | None = None,
) -> Iterator[dict[str, Any]]:
    """智能选择单轮或多轮 Pipeline。

    当 estimated_passes >= 3 且数据足够复杂时，使用多轮分析。
    否则回退到单轮分析。
    """
    from app.services.ad_agent.multi_pass import run_multi_pass_stream

    if registry is None:
        registry = load_registry()

    # Layer 0 + 1（共享）
    data_profile = profile_data(aggregated_data, registry)
    yield {"type": "profile", "data": data_profile.to_dict()}

    strategy = plan_strategy(data_profile, registry)
    yield {"type": "strategy", "data": strategy.to_dict()}

    strategy_declaration = _build_strategy_declaration(strategy, data_profile)
    yield {"type": "declaration", "text": strategy_declaration}

    # 选择单轮或多轮
    if strategy.estimated_passes >= 3 and len(data_profile.available_dimensions) >= 3:
        logger.info("Using multi-pass pipeline (estimated_passes=%d, available_dims=%d)",
                     strategy.estimated_passes, len(data_profile.available_dimensions))
        yield {"type": "pass_mode", "mode": "multi_pass"}

        content = ""
        for event in run_multi_pass_stream(
            aggregated_data, settings, data_profile, strategy, registry,
            project_context_text=project_context_text,
            sku_context_text=sku_context_text,
            model=model,
        ):
            if event.get("type") == "done":
                content = event.get("content", "")
            yield event
    else:
        logger.info("Using single-pass pipeline (estimated_passes=%d)", strategy.estimated_passes)
        yield {"type": "pass_mode", "mode": "single_pass"}

        # 单轮：复用现有 LLM 调用逻辑
        from app.services import ai as ai_chat_service

        system_prompt = assemble_system_prompt(strategy, data_profile, registry)
        user_content = assemble_user_message(
            aggregated_data, strategy_declaration,
            project_context_text, sku_context_text, user_message,
        )

        if not ai_chat_service.is_provider_configured(settings):
            raise RuntimeError("AI Provider 未配置")

        models, default_model = ai_chat_service.resolve_available_models(settings)
        selected_model = model or default_model

        llm_config = ai_chat_service.build_llm_config(
            settings=settings,
            model=selected_model,
            system_prompt=system_prompt,
            reasoning_effort=None,
        )

        content = ""
        for chunk in ai_chat_service.stream_assistant_content(
            llm_config=llm_config, messages=[], user_content=user_content, settings=settings,
        ):
            if isinstance(chunk, dict):
                if chunk.get("type") == "thinking":
                    continue
                delta = chunk.get("content", "")
            elif isinstance(chunk, str):
                delta = chunk
            else:
                continue
            if delta:
                content += delta
                yield {"type": "chunk", "delta": delta}

        content = normalize_insight_markdown(content)

    # Layer 3: Evolution
    metadata = extract_run_metadata(
        insight_id=insight_id,
        project_id=project_id, project_name=project_name, country=country,
        date_range_start=date_range_start, date_range_end=date_range_end,
        data_profile=data_profile, strategy=strategy, content=content,
    )
    if db is not None:
        try:
            record_run_to_db(db, metadata)
            record_run(metadata, skip_if_db=True)
        except Exception as exc:
            logger.warning("Failed to persist run to DB: %s", exc)
            record_run(metadata)
    else:
        record_run(metadata)

    yield {
        "type": "done",
        "content": content,
        "strategy_declaration": strategy_declaration,
        "evolution_metadata": metadata.to_dict(),
    }
