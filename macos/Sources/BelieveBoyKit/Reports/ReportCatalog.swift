import Foundation

/// 「报表中心 · 上传与分析簇」的端点与类型目录（S5.5，BLF-1068）。
///
/// 本批（PLAN §8 的 S5.5）搬两页：**产品分析**（`/dashboard/reports/product-analysis`）
/// 与**报表自动化**（`/dashboard/reports/auto-upload`）。端点面刻意收窄到一个「写入 +
/// 异步任务 + 状态」的最小闭环，而不是整组报表中心的 39 GET / 36 write：
///
/// | 用途 | 端点 | 通道 |
/// | --- | --- | --- |
/// | 广告报表识别 | `POST /ad-upload/recognize` | multipart（`file` + `country`） |
/// | 广告报表入库 | `POST /ad-upload/commit` | JSON |
/// | 广告入库状态 | `GET /ad-upload/status` | JSON |
/// | 发起产品分析核算 | `POST /product-analysis-reports` | JSON（异步任务） |
/// | 任务状态 | `GET /product-analysis-reports/tasks/{id}` | JSON |
/// | 任务结果 | `GET /product-analysis-reports/tasks/{id}/result` | `FileResponse`（流式落盘） |
/// | RPA 上传完成度 | `GET /rpa-reports/status` | JSON |
/// | 项目列表 | `GET /projects/manage` | JSON（既有同源实现，不另起一套） |
///
/// **不走 `/api/v1/agent/*`**（那要 agent 凭据，桌面端打不通）：`ad_upload` /
/// `product_analysis_reports` / `rpa_reports` 三个 router 都挂 `Depends(protected)`
/// （`require_api_key`），账号 `blf_` key + `X-Operator` 一族直连即可（BLF-1068 已核实）。
public enum ReportCatalog {
    // MARK: - 端点

    /// 项目列表。与 `AdSharedCatalog` 同一条：`/projects/manage` 按 `X-Operator` 过滤
    /// 可见项目（AGENTS.md 的约定），本批**复用**而不是另写一套。
    public static let projectsEndpoint = AdSharedCatalog.projectsEndpoint

    public static let adUploadRecognizeEndpoint = "/ad-upload/recognize"
    public static let adUploadCommitEndpoint = "/ad-upload/commit"
    public static let adUploadStatusEndpoint = "/ad-upload/status"

    public static let productAnalysisReportsEndpoint = "/product-analysis-reports"

    public static func productAnalysisTaskEndpoint(taskID: Int) -> String {
        "\(productAnalysisReportsEndpoint)/tasks/\(taskID)"
    }

    public static func productAnalysisResultEndpoint(taskID: Int) -> String {
        "\(productAnalysisTaskEndpoint(taskID: taskID))/result"
    }

    public static let rpaStatusEndpoint = "/rpa-reports/status"

    /// 把**后端给的**端点（带 `/api/v1` 前缀）转成客户端的相对路径。
    ///
    /// `POST /product-analysis-reports` 的响应里带 `status_endpoint` /
    /// `result_endpoint`，其真实值是 `/api/v1/product-analysis-reports/tasks/1`
    /// （夹具 `product-analysis-report-create.json` 就是这个值）。而 `APIClient` 会**自己**
    /// 拼上 `apiPrefix`（`/api/v1`）—— 直接拿后端给的全路径去请求会拼成
    /// `/api/v1/api/v1/...` → 404。本仓所有目录常量（`AdDataCatalog` / `InsightCatalog`）
    /// 也都是不带前缀的形态，这里统一到同一口径。
    public static func clientPath(fromBackendEndpoint endpoint: String?) -> String? {
        guard let trimmed = endpoint?.trimmedNonEmpty else { return nil }
        if trimmed == APIClient.apiPrefix { return "/" }
        if trimmed.hasPrefix(APIClient.apiPrefix + "/") {
            return String(trimmed.dropFirst(APIClient.apiPrefix.count))
        }
        return trimmed
    }

    // MARK: - multipart 字段名

    /// 后端签名是 `file: UploadFile = File(...)` / `country: str = Form(default='US')`
    /// （`backend/app/api/v1/endpoints/ad_upload.py:20`），字段名必须一字不差。
    public static let uploadFileField = "file"
    public static let uploadCountryField = "country"

    // MARK: - 固定口径

    /// `GET /ad-upload/status` 的 `limit`（后端 `ge=1, le=200`，默认 50 —— 照抄 Web 口径）。
    public static let adUploadStatusLimit = 50

    /// `/rpa-reports/status` 的默认站点（Web `AutoUploadPage` 的初值）。
    public static let defaultCountry = AdCountries.defaultCode

    // MARK: - 路由（与 `NavigationCatalog` 的 route id 同字）

    public static let productAnalysisRouteID = "/dashboard/reports/product-analysis"
    public static let reportAutomationRouteID = "/dashboard/reports/auto-upload"

    /// 本地日期（`yyyy-MM-dd`）——「报表自动化」页的日期导航与 Web 一致用**本机时区**
    /// （`toLocalDateInputValue`），不是 S4 那种「美西今天」。
    ///
    /// 这不是口误：RPA 状态页的 `report_date` 是运营在自己电脑上挑的业务日期，Web 取的是
    /// 浏览器本地日期；桌面端照抄同一语义。要拿美西今天有 `AgentOpsFormatting.usToday`。
    public static func localDateString(_ date: Date, timeZone: TimeZone = .current) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let components = calendar.dateComponents([.year, .month, .day], from: date)
        let year = String(format: "%04d", components.year ?? 1970)
        let month = String(format: "%02d", components.month ?? 1)
        let day = String(format: "%02d", components.day ?? 1)
        return "\(year)-\(month)-\(day)"
    }

    /// 日期串按天平移（Web `shiftDateString`）。
    public static func shiftDateString(_ value: String, days: Int, timeZone: TimeZone = .current) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        guard let date = parseDateString(value) else { return value }
        guard let shifted = calendar.date(byAdding: .day, value: days, to: date) else { return value }
        return localDateString(shifted, timeZone: timeZone)
    }

    /// `yyyy-MM-dd` → `Date`（本机时区当天零点）；不合法返回 nil（调用方**保持原值**，
    /// 不要拿 `Date()` 顶替 —— 用户手输到一半的半截日期不该被悄悄改成今天）。
    public static func parseDateString(_ value: String, timeZone: TimeZone = .current) -> Date? {
        let parts = value.split(separator: "-", omittingEmptySubsequences: false)
        // 位数也要管：`2026-9-4` 能通过 Int 解析与范围校验，但后端 `Query(min_length=10,
        // max_length=10)` 会直接 422。长度与范围都不对就不当它是合法日期。
        guard parts.count == 3,
              parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]),
              (1...12).contains(month), (1...31).contains(day), year >= 1900, year <= 2999
        else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        var components = DateComponents()
        components.year = year
        components.month = month
        components.day = day
        return calendar.date(from: components)
    }
}

// MARK: - 页面默认日期区间

/// 页面默认日期区间（照抄 Web 两处 `getXxxRange`）。
///
/// 「产品分析 → 手动核算」默认**上周**（周一~周日），「月度 SKU 分析」默认**上月**。
/// 两处都用**本机时区**（Web 的 `new Date()`），与 `localDateString` 同一口径。
public enum ReportDateRanges {
    /// 上一个完整自然周（周一 ~ 周日）—— Web `getLastWeekRange`。
    public static func lastWeek(
        now: Date = Date(),
        timeZone: TimeZone = .current
    ) -> (start: String, end: String) {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        // `weekday`：1 = 周日。距离本周一的天数因此是 `weekday == 1 ? 6 : weekday - 2`。
        let weekday = calendar.component(.weekday, from: now)
        let daysSinceMonday = weekday == 1 ? 6 : weekday - 2
        let currentMonday = calendar.date(byAdding: .day, value: -daysSinceMonday, to: now) ?? now
        let lastMonday = calendar.date(byAdding: .day, value: -7, to: currentMonday) ?? currentMonday
        let lastSunday = calendar.date(byAdding: .day, value: 6, to: lastMonday) ?? lastMonday
        return (
            ReportCatalog.localDateString(lastMonday, timeZone: timeZone),
            ReportCatalog.localDateString(lastSunday, timeZone: timeZone)
        )
    }

    /// 上一个自然月（1 号 ~ 月末）—— Web `getLastMonthRange`。
    public static func lastMonth(
        now: Date = Date(),
        timeZone: TimeZone = .current
    ) -> (start: String, end: String) {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let startOfThisMonth = calendar.date(
            from: calendar.dateComponents([.year, .month], from: now)
        ) ?? now
        let lastOfPrevMonth = calendar.date(byAdding: .day, value: -1, to: startOfThisMonth)
            ?? startOfThisMonth
        let startOfPrevMonth = calendar.date(
            from: calendar.dateComponents([.year, .month], from: lastOfPrevMonth)
        ) ?? lastOfPrevMonth
        return (
            ReportCatalog.localDateString(startOfPrevMonth, timeZone: timeZone),
            ReportCatalog.localDateString(lastOfPrevMonth, timeZone: timeZone)
        )
    }
}

// MARK: - 报表类型标签

/// 报表类型 → 中文标签。
///
/// 照抄 Web 的 `frontend/app/dashboard/reports/auto-upload/report-type-labels.ts`
/// （唯一权威），**包括**历史队列里可能出现的旧值 —— 上传队列与状态矩阵的历史数据
/// 都会带旧类型，显示成原始 key 比显示成「未知」更糟。
public enum ReportTypeLabels {
    /// 与 Web `REPORT_UPLOAD_REPORT_TYPE_LABELS` 逐条对应。
    public static let adTypeLabels: [String: String] = [
        "ad_search_term_share_report": "广告 - 搜索词展示量份额",
        "ad_budget_report": "广告 - 预算",
        "ad_campaign_report": "广告 - 广告活动",
        "ad_purchased_product_report": "广告 - 已购买商品",
        "ad_promoted_product_report": "广告 - 推广的商品",
        "ad_invalid_traffic_report": "广告 - 总流量和无效流量",
        "ad_placement_report": "广告 - 广告位",
        "ad_target_report": "广告 - 搜索词投放",
        "ad_search_term_report": "广告 - 搜索词",
        "ad_time_trend_report": "广告 - 按时间查看效果",
    ]

    public static let labels: [String: String] = [
        "inventory_report": "亚马逊物流库存",
        "business_report": "业务报告",
        "ad_product_report": "广告 - 已推广商品",
        "sales_report": "销售报表 - 所有订单",
        "payment_report": "付款报告",
        "return_report": "退货报告",
        // 历史值：保留映射以免显示原始 key，但不再作为新上传选项。
        "inventory_ledger": "历史库存分类账类型（待重新识别）",
        "inventory_ledger_summary": "库存分类账 · 汇总视图（Summary）",
        "inventory_ledger_detail": "库存分类账 · 明细视图（Detail）",
        "unknown": "未识别",
    ].merging(adTypeLabels) { current, _ in current }

    /// `unknown` / 空 → 「未识别」；字典里没有的类型回退原始 key（Web 同口径）。
    public static func label(for code: String?) -> String {
        guard let code, !code.isEmpty else { return "未识别" }
        if code == "unknown" { return "未识别" }
        return labels[code] ?? code
    }
}

/// 10 个广告报表类型（`AdUploadType` 去掉 `unknown`），顺序照抄
/// `frontend/components/report-upload/types.ts` 的 `AD_REPORT_TYPES`（＝ Web 状态矩阵的列序）。
public enum AdUploadReportTypes {
    public static let all: [String] = [
        "ad_search_term_share_report",
        "ad_budget_report",
        "ad_campaign_report",
        "ad_purchased_product_report",
        "ad_promoted_product_report",
        "ad_invalid_traffic_report",
        "ad_placement_report",
        "ad_target_report",
        "ad_search_term_report",
        "ad_time_trend_report",
    ]

    /// 后端 `AdUploadType` 的全集（含 `unknown`），与 `backend/app/schemas/ad_upload.py:6` 一一对应。
    public static let backendLiterals: [String] = all + ["unknown"]

    public static func isAdReport(_ code: String) -> Bool { code.hasPrefix("ad_") }

    /// 该类型是否吃「单日」还是「周期」日期 —— 产品分析三类报表里只有付款报告是周期。
    /// Web `DATE_REQUIRED_REPORT_TYPES` 的等价物（本批只用到这三类）。
    public static func requiresDateRange(_ code: String) -> Bool { code == "payment_report" }
}
