"""Schedule Report Insight adapter（BLF-1014，BLF-1005 Stage 3）。

把 schedule report 的 AI 摘要从「dispatcher 里同步调 LLM」迁移到
``schedule_report_summary.v1`` Insight run。本包只做三件事：

1. **slot 组装**（``slots.py``）：从 delivery_log / subscription / ledger
   entry 解析出 role 需要的 typed slots（``report.context`` /
   ``report.data`` / 可选 ``project.context``），不碰 LLM、不碰传输层。
2. **run 提交**（``submit.py``）：校验 scope（project 归属与国家一致性），
   以 ``delivery:{log_id}`` 幂等键提交 run，落 ``delivery_log_id ↔ run_id``
   关联；同一 delivery 重复触发只 replay，绝不重复扣费。
3. **终态回写**（``sync.py``）：Insight run 终态 → delivery_log 的
   ``ai_summary_*`` 字段（生成中/完成/失败/取消），口径与旧消费者兼容。

旧线程路径 ``enqueue_ai_summary_generation``（threading.Thread 直调 LLM）
由本 adapter 取代；Celery ``generate_delivery_summary`` 改为提交流观察者。
"""
