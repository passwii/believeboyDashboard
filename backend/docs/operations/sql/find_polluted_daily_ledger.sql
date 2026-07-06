-- 找出"被缓存 bug 污染的"日频 ledger entry
-- 判据：同 subscription_id 下，连续多天的 auto log 复用同一个截图文件名（说明命中了
-- dispatcher._summary_cache 里残留的旧数据）。
--
-- 背景：2026-05-24 引入 minutely-scan 自动调度路径后，_dispatch_one 没初始化
-- _dispatch_date_str / _summary_cache，导致跨日自动调度反复命中前一天的缓存。
-- 该 bug 已在 _dispatch_one 入口修复（跨日清缓存 + 刷新日期），但历史上产出的
-- auto log 数据是错的，需要手动补发。
--
-- 用法：
--   1) 直接 psql 执行，导出为 CSV 给运维人工补发
--   2) 修完 bug 后重跑，新污染条目应为空

WITH daily_auto AS (
  SELECT dl.id, dl.subscription_id, dl.frequency, dl.report_date, dl.screenshot_r2_key,
         SUBSTRING(dl.screenshot_r2_key FROM '/(\d{4}-\d{2}-\d{2})_') AS filename_date
  FROM scheduled_report_delivery_logs dl
  WHERE dl.frequency = 'daily'
    AND dl.screenshot_r2_key IS NOT NULL
    AND dl.report_date = (dl.created_at AT TIME ZONE 'Asia/Shanghai')::date::text
),
lagged AS (
  SELECT *,
         lag(filename_date) OVER (PARTITION BY subscription_id ORDER BY report_date) AS prev_filename_date
  FROM daily_auto
)
SELECT DISTINCT ON (le.ledger_key)
  le.ledger_key,
  le.subscription_id,
  le.email,
  le.frequency,
  le.country,
  s.project_ids,
  le.expected_date                                                              AS polluted_expected_date,
  SUBSTRING(latest_dl.screenshot_r2_key FROM '/(\d{4}-\d{2}-\d{2})_')           AS polluted_filename_date,
  le.latest_delivery_log_id                                                     AS polluted_log_id,
  le.status                                                                     AS current_ledger_status,
  le.sent_at
FROM lagged
JOIN scheduled_report_subscriptions   s         ON s.id = lagged.subscription_id
JOIN scheduled_report_ledger_entries  le        ON le.subscription_id = lagged.subscription_id
                                              AND le.expected_date  = lagged.report_date
LEFT JOIN scheduled_report_delivery_logs latest_dl ON latest_dl.id = le.latest_delivery_log_id
WHERE prev_filename_date IS NOT NULL
  AND filename_date = prev_filename_date
ORDER BY le.ledger_key, s.project_ids, le.subscription_id, le.expected_date;