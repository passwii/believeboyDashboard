import Foundation

// MARK: - `GET /rpa-reports/status` 的响应

/// 单个报表类型在某项目下的状态（后端 `ReportTypeStatusSchema`）。
public struct RpaReportTypeStatus: Decodable, Sendable, Equatable {
    public let reportType: String
    /// 后端认为「这个日期窗口内该类型有数据」。
    public let hasData: Bool
    /// 后端认为「已上传」——**上传完成度 M/N 就数它**（Web 状态矩阵的绿勾也是它）。
    public let isUploaded: Bool
    /// 报表实际业务日期（`period_end_date` / `snapshot_at`），用于历史月份内容填充。
    public let latestDate: String?
    public let originalFilename: String?
    public let statusSource: String?

    public init(
        reportType: String,
        hasData: Bool,
        isUploaded: Bool,
        latestDate: String? = nil,
        originalFilename: String? = nil,
        statusSource: String? = nil
    ) {
        self.reportType = reportType
        self.hasData = hasData
        self.isUploaded = isUploaded
        self.latestDate = latestDate
        self.originalFilename = originalFilename
        self.statusSource = statusSource
    }

    private enum CodingKeys: String, CodingKey {
        case reportType, hasData, isUploaded, latestDate, originalFilename, statusSource
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        reportType = try container.decodeIfPresent(String.self, forKey: .reportType) ?? ""
        hasData = try container.decodeIfPresent(Bool.self, forKey: .hasData) ?? false
        isUploaded = try container.decodeIfPresent(Bool.self, forKey: .isUploaded) ?? false
        latestDate = try container.decodeIfPresent(String.self, forKey: .latestDate)
        originalFilename = try container.decodeIfPresent(String.self, forKey: .originalFilename)
        statusSource = try container.decodeIfPresent(String.self, forKey: .statusSource)
    }
}

/// 一个项目的状态行（后端 `ProjectReportStatusSchema`）。
public struct RpaProjectStatus: Decodable, Sendable, Equatable, Identifiable {
    public let projectID: Int
    public let projectName: String
    public let country: String
    public let statuses: [RpaReportTypeStatus]

    public var id: Int { projectID }

    public init(
        projectID: Int,
        projectName: String,
        country: String,
        statuses: [RpaReportTypeStatus]
    ) {
        self.projectID = projectID
        self.projectName = projectName
        self.country = country
        self.statuses = statuses
    }

    private enum CodingKeys: String, CodingKey {
        case projectID = "projectId"
        case projectName, country, statuses
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        projectID = try container.decodeIfPresent(Int.self, forKey: .projectID) ?? 0
        projectName = try container.decodeIfPresent(String.self, forKey: .projectName) ?? ""
        country = try container.decodeIfPresent(String.self, forKey: .country) ?? ReportCatalog.defaultCountry
        statuses = try container.decodeIfPresent([RpaReportTypeStatus].self, forKey: .statuses) ?? []
    }

    /// 某个报表类型的状态格。
    ///
    /// 后端**可能不返回**某一列（该类型在这条链路里没被登记）—— 返回 nil 由目录侧落成
    /// 「未知」而不是红色 ❌：没有格子 ≠ 没上传（Web 的 `cell?.is_uploaded ?? false`
    /// 会把它画成红叉，桌面端不照抄这条 —— 见 `ReportAutomationCatalog` 的说明）。
    public func status(for reportType: String) -> RpaReportTypeStatus? {
        statuses.first { $0.reportType == reportType }
    }
}

/// `GET /rpa-reports/status` 的响应（后端 `RpaReportStatusResponseSchema`）。
public struct RpaReportStatusResponse: Decodable, Sendable, Equatable {
    public let country: String
    public let items: [RpaProjectStatus]

    public init(country: String, items: [RpaProjectStatus]) {
        self.country = country
        self.items = items
    }

    private enum CodingKeys: String, CodingKey {
        case country, items
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        country = try container.decodeIfPresent(String.self, forKey: .country) ?? ReportCatalog.defaultCountry
        items = try container.decodeIfPresent([RpaProjectStatus].self, forKey: .items) ?? []
    }
}

/// 查询参数。
public struct RpaReportStatusQuery: Sendable, Equatable {
    /// 必填（后端 `Query(..., min_length=10, max_length=10)`）。
    public var reportDate: String
    public var country: String

    public init(reportDate: String, country: String = ReportCatalog.defaultCountry) {
        self.reportDate = reportDate
        self.country = country
    }

    public var parameters: [String: String] {
        ["report_date": reportDate, "country": country]
    }

    /// 参数是否够发一次请求（日期必须是 `YYYY-MM-DD`）。
    public var isValid: Bool { ReportCatalog.parseDateString(reportDate) != nil }
}

// MARK: - 状态矩阵目录

/// 状态矩阵的一列（＝一个报表类型）。
public struct ReportAutomationColumn: Sendable, Hashable, Identifiable {
    public let reportType: String
    public let label: String

    public var id: String { reportType }

    public init(reportType: String, label: String) {
        self.reportType = reportType
        self.label = label
    }
}

/// 报表自动化状态页的列目录与完成度口径。
///
/// 列序照抄 Web `frontend/app/dashboard/reports/auto-upload/report-type-labels.ts` 的
/// `REPORT_TYPES`（5 个非广告列 + 10 个广告列）。**注意**：该文件明确写了
/// 「库存分类账（`inventory_ledger_summary` / `inventory_ledger_detail`）不在此页面展示
/// （BLF-482），仅保留已激活报表类型」。桌面端照抄这条，不自行加列。
public enum ReportAutomationCatalog {
    /// 非广告的五列（Web 原文标签）。
    public static let coreColumns: [ReportAutomationColumn] = [
        ReportAutomationColumn(reportType: "inventory_report", label: "库存"),
        ReportAutomationColumn(reportType: "business_report", label: "业务"),
        ReportAutomationColumn(reportType: "sales_report", label: "销售"),
        ReportAutomationColumn(reportType: "payment_report", label: "付款"),
        ReportAutomationColumn(reportType: "return_report", label: "退货"),
    ]

    /// 广告列：标签是 `广告-` + 短名（Web `AD_REPORT_TYPES[].short`）。
    public static let adColumns: [ReportAutomationColumn] = [
        ReportAutomationColumn(reportType: "ad_search_term_share_report", label: "广告-词份额"),
        ReportAutomationColumn(reportType: "ad_budget_report", label: "广告-预算"),
        ReportAutomationColumn(reportType: "ad_campaign_report", label: "广告-广告活动"),
        ReportAutomationColumn(reportType: "ad_purchased_product_report", label: "广告-已购商品"),
        ReportAutomationColumn(reportType: "ad_promoted_product_report", label: "广告-推广商品"),
        ReportAutomationColumn(reportType: "ad_invalid_traffic_report", label: "广告-无效流量"),
        ReportAutomationColumn(reportType: "ad_placement_report", label: "广告-广告位"),
        ReportAutomationColumn(reportType: "ad_target_report", label: "广告-搜索词投放"),
        ReportAutomationColumn(reportType: "ad_search_term_report", label: "广告-搜索词"),
        ReportAutomationColumn(reportType: "ad_time_trend_report", label: "广告-时间效果"),
    ]

    /// 全量列序（＝ Web 的 `REPORT_TYPES`）。
    public static let columns: [ReportAutomationColumn] = coreColumns + adColumns

    /// 一个格子的状态。
    public enum CellState: Sendable, Equatable {
        case uploaded
        case missing
        /// 后端没给这个类型的状态 —— **不画成「没上传」**（少一列 ≠ 没上传）。
        case unreported
    }

    public static func cellState(_ project: RpaProjectStatus, column: ReportAutomationColumn) -> CellState {
        guard let status = project.status(for: column.reportType) else { return .unreported }
        return status.isUploaded ? .uploaded : .missing
    }

    /// 上传完成度（M/N）。`unreported` **不计入分母** —— 分母是「后端真的报了状态的那些列」，
    /// 否则后端少报一列会把 M/N 直接压成「永远做不完」。
    public struct Completeness: Sendable, Equatable {
        public let uploaded: Int
        public let reported: Int

        public var total: Int { columns.count }

        public var fraction: Double {
            guard reported > 0 else { return 0 }
            return Double(uploaded) / Double(reported)
        }

        public var text: String { "\(uploaded)/\(reported)" }

        /// 后端**一列都没报**（例如该日期还没有任何 RPA 数据）—— 这时候 M/N 是 0/0，
        /// 界面应当说「暂无状态」而不是「0/0」。
        public var isEmpty: Bool { reported == 0 }
    }

    /// 全表完成度（所有项目、所有列）。
    public static func completeness(_ projects: [RpaProjectStatus]) -> Completeness {
        var uploaded = 0
        var reported = 0
        for project in projects {
            for column in columns {
                switch cellState(project, column: column) {
                case .uploaded:
                    uploaded += 1
                    reported += 1
                case .missing:
                    reported += 1
                case .unreported:
                    continue
                }
            }
        }
        return Completeness(uploaded: uploaded, reported: reported)
    }

    /// 单个项目的完成度（详情行用）。
    public static func completeness(_ project: RpaProjectStatus) -> Completeness {
        completeness([project])
    }
}
