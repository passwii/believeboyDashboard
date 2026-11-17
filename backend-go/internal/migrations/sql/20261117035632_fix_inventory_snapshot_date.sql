-- +goose Up
-- +goose StatementBegin
-- 2026-11-17 批次 FBA 文件的 snapshot-date 是 2026-11-16，但 Go 日期解析把
-- date-only 值按 UTC→美西转换，误存成 2026-11-15。修正该批项目的
-- inventory source 及其上传日志，避免日报分析在 11-15 使用 11-16 的数据。
UPDATE public.analysis_source_files
SET report_date = DATE '2026-11-16',
    updated_at = now()
WHERE report_type = 'inventory_report'
  AND country = 'US'
  AND report_date = DATE '2026-11-15'
  AND original_filename LIKE 'FBA-2026-11-17_%';

UPDATE public.report_upload_logs
SET upload_date = DATE '2026-11-17'
WHERE report_type = 'inventory_report'
  AND country = 'US'
  AND upload_date = DATE '2026-11-15'
  AND source_file_id IN (
    SELECT id
    FROM public.analysis_source_files
    WHERE report_type = 'inventory_report'
      AND country = 'US'
      AND original_filename LIKE 'FBA-2026-11-17_%'
  );
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
-- 数据修复以恢复日期语义为主；回退会把该批 source 与日志还原到误存的
-- 2026-11-15，仅在明确需要复现旧数据时使用。
UPDATE public.analysis_source_files
SET report_date = DATE '2026-11-15',
    updated_at = now()
WHERE report_type = 'inventory_report'
  AND country = 'US'
  AND report_date = DATE '2026-11-16'
  AND original_filename LIKE 'FBA-2026-11-17_%';

UPDATE public.report_upload_logs
SET upload_date = DATE '2026-11-15'
WHERE report_type = 'inventory_report'
  AND country = 'US'
  AND upload_date = DATE '2026-11-17'
  AND source_file_id IN (
    SELECT id
    FROM public.analysis_source_files
    WHERE report_type = 'inventory_report'
      AND country = 'US'
      AND original_filename LIKE 'FBA-2026-11-17_%'
  );
-- +goose StatementEnd
