# Payment report CSV parsing, validation, and transaction processing.
#
# Planned contents (to be migrated from app.services.monthly_report_service
# and app.services.product_analysis_source_service):
#
#   Validation:
#     - validate_payment_report_project_match()  (check payment CSV matches project/country)
#
#   Transaction parsing (monthly report):
#     - _build_transaction_payloads()            (parse raw rows → MonthlyReportTransaction)
#     - _classify_monthly_rows()                 (categorize transactions into 15 types)
#     - _parse_transaction_datetime()            (handle timezone abbreviations PDT/EDT/CET/...)
#
#   Payment DataFrame building (product analysis):
#     - _build_payment_df_from_source()          (AnalysisPaymentRow → DataFrame)
#     - _build_payment_df_from_sources()         (concatenate multiple payment DataFrames)
#
# DO NOT move code yet – this file is a placeholder for future refactoring.
