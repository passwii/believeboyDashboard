"""Inventory Health Insight adapter（BLF-1016，BLF-1005 Stage 4）。

``inventory_health.v1`` 是本项目**首个**库存 LLM role——旧链路没有库存
洞察（``InsightType`` 无库存成员，``services/inventory`` 下零 LLM 调用），
所以这里没有「旧行为」可迁移，只有一件事不能做：在域内再起一条 LLM 调用
链。provider、run、SSE、重试、取消、持久化全部复用 ``app/services/insight``。

- ``slots.py``：把确定性补货分析（``list_inventory_replenishment_analysis``）
  的产物裁成 ``inventory.context`` / ``inventory.data`` typed slot，
  快照新鲜度与缺数维度显式入 slot（``_compute_snapshot_age_days`` 把
  「无快照」折成 0 天，本模块用 ``latest_inventory_snapshot_date`` 区分
  缺失与新鲜）。
- ``submit.py``：服务端解析 scope 并以 ``inventory:{project}:{country}:{report_date}``
  幂等键提交 run。
- ``prompt.py``：服务端持有的单轮 prompt / 指令 / 清洗。
"""
