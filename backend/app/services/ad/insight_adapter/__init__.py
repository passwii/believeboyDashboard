"""Ad Analysis Insight adapter（BLF-1016，BLF-1005 Stage 4）。

把广告分析从「legacy ``AIInsight`` + 多轮 ad_agent pipeline」迁移到
``ad_analysis.v1`` canonical Insight run。本包只做三件事：

1. **slot 组装**（``slots.py``）：复用既有 ``aggregate_project_data``
   聚合产物，裁剪成 ``ad.context`` / ``ad.data`` 两个 typed slot；数据
   新鲜度与缺数维度作为可审计输入随 slot 落库。
2. **run 提交**（``submit.py``）：服务端解析 scope（project 归属 + 国家
   自洽），以 ``ad:{project}:{country}:{start}:{end}`` 幂等键提交 run。
3. **prompt 模板**（``prompt.py``）：服务端持有的单轮 prompt + 指令 +
   清洗，由 ``executor.role_runtime_for`` 按 role_id 注入。

provider、run、SSE、重试、取消、持久化全部复用 ``app/services/insight``，
本包不新增任何 LLM 调用链，也不写 ``AIInsight`` 历史表。
"""
