import Foundation

// MARK: - 响应信封

/// 10 个 `ad-*-raw` 端点共用的响应信封
/// （`RawResponse[_RowT]`，`backend/app/schemas/external/aggregate.py`）：
/// `{project_id, period, country, data[], summary}`。**没有 agent 壳**。
///
/// ⚠️ `CodingKeys` 的原始值必须写**变换后**的键名（`APIClient` 的 `convertFromSnakeCase`）：
/// `project_id` 变换后是 `projectId`（不是 `projectID`），故这一处显式写原始值 —— 与
/// `AdAnalysisPayload` 同一个坑。行内字段不受该策略影响（字典解码保留原样），
/// 两边的规则方向相反。
public struct AdDataRawPayload: Sendable, Equatable, Decodable {
    public let projectID: Int?
    public let country: String?
    public let period: AdDataPeriod?
    public let data: [DynamicJSONRow]
    public let summary: AdDataRawSummary?

    public init(
        projectID: Int? = nil,
        country: String? = nil,
        period: AdDataPeriod? = nil,
        data: [DynamicJSONRow] = [],
        summary: AdDataRawSummary? = nil
    ) {
        self.projectID = projectID
        self.country = country
        self.period = period
        self.data = data
        self.summary = summary
    }

    private enum CodingKeys: String, CodingKey {
        case projectID = "projectId"
        case country
        case period
        case data
        case summary
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        projectID = try container.decodeIfPresent(Int.self, forKey: .projectID)
        country = try container.decodeIfPresent(String.self, forKey: .country)
        period = try container.decodeIfPresent(AdDataPeriod.self, forKey: .period)
        data = try container.decodeIfPresent([DynamicJSONRow].self, forKey: .data) ?? []
        summary = try container.decodeIfPresent(AdDataRawSummary.self, forKey: .summary)
    }

    /// 本页返回的行数。
    public var returnedRowCount: Int { data.count }

    /// 是否**可能**被单次拉取上限截断（口径 2：`data.count == limit` 即按可能截断处理，
    /// 不静默当作完整数据）。
    ///
    /// 为什么不能靠 `summary.total_rows` 判断：它是**本页返回行数**（`len(rows)`），
    /// 不是窗口内总行数 —— 没有服务端总数，所以「还有没有更多」只能由「顶到 limit」推断。
    public func isTruncated(limit: Int = AdDataCatalog.pageLimit) -> Bool {
        data.count >= limit
    }
}

/// 响应里的 `period`（`PeriodInfo`）：后端把「实际解析成哪段日期」回填在这里。
public struct AdDataPeriod: Sendable, Equatable, Decodable {
    public let type: String?
    public let value: String?
    public let startDate: String?
    public let endDate: String?

    public init(
        type: String? = nil,
        value: String? = nil,
        startDate: String? = nil,
        endDate: String? = nil
    ) {
        self.type = type
        self.value = value
        self.startDate = startDate
        self.endDate = endDate
    }
}

/// 响应里的 `summary`（`RawSummary`）。
public struct AdDataRawSummary: Sendable, Equatable, Decodable {
    /// **本页返回行数**（不是窗口内总行数，见 `isTruncated`）。
    public let totalRows: Int?
    /// `[start_date, end_date]`。
    public let dateRange: [String]

    public init(totalRows: Int? = nil, dateRange: [String] = []) {
        self.totalRows = totalRows
        self.dateRange = dateRange
    }

    private enum CodingKeys: String, CodingKey {
        case totalRows
        case dateRange
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        totalRows = try container.decodeIfPresent(Int.self, forKey: .totalRows)
        dateRange = try container.decodeIfPresent([String].self, forKey: .dateRange) ?? []
    }
}

// MARK: - 入库文件（`ad-upload-files`）

/// `ad-upload-files` 的一项（`backend/app/schemas/external/ad_upload_files.py`）。
///
/// 本页只把这份列表当**附属信息**用（口径 3）：不拿它给报表类型置灰 —— 该端点是按
/// `updated_at desc` 截断的，实测「搜索词」这种久未入库的类型会因为截断而不出现，
/// 于是 Web 把有 1321 行数据的类型渲染成「（暂无数据）」并禁用。桌面端把可用性判定交给
/// 「所选类型 raw 响应的 `data` 是否为空」，这份列表只用来显示「最近一次入库是哪一份」。
public struct AdUploadFileItem: Sendable, Equatable, Decodable {
    public let fileID: Int?
    public let reportType: String
    public let reportLabel: String?
    public let country: String?
    public let periodStartDate: String?
    public let periodEndDate: String?
    public let version: Int?
    public let isCurrent: Bool?
    public let ingestionStatus: String?
    public let rowCountPreview: Int?
    /// 入库时刻（后端是 `datetime`，这里按原样保留字符串，显示时取日期前缀）。
    public let uploadedAt: String?

    public init(
        fileID: Int? = nil,
        reportType: String,
        reportLabel: String? = nil,
        country: String? = nil,
        periodStartDate: String? = nil,
        periodEndDate: String? = nil,
        version: Int? = nil,
        isCurrent: Bool? = nil,
        ingestionStatus: String? = nil,
        rowCountPreview: Int? = nil,
        uploadedAt: String? = nil
    ) {
        self.fileID = fileID
        self.reportType = reportType
        self.reportLabel = reportLabel
        self.country = country
        self.periodStartDate = periodStartDate
        self.periodEndDate = periodEndDate
        self.version = version
        self.isCurrent = isCurrent
        self.ingestionStatus = ingestionStatus
        self.rowCountPreview = rowCountPreview
        self.uploadedAt = uploadedAt
    }

    private enum CodingKeys: String, CodingKey {
        case fileID = "fileId"
        case reportType
        case reportLabel
        case country
        case periodStartDate
        case periodEndDate
        case version
        case isCurrent
        case ingestionStatus
        case rowCountPreview
        case uploadedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        fileID = try container.decodeIfPresent(Int.self, forKey: .fileID)
        reportType = try container.decode(String.self, forKey: .reportType)
        reportLabel = try container.decodeIfPresent(String.self, forKey: .reportLabel)
        country = try container.decodeIfPresent(String.self, forKey: .country)
        periodStartDate = try container.decodeIfPresent(String.self, forKey: .periodStartDate)
        periodEndDate = try container.decodeIfPresent(String.self, forKey: .periodEndDate)
        version = try container.decodeIfPresent(Int.self, forKey: .version)
        isCurrent = try container.decodeIfPresent(Bool.self, forKey: .isCurrent)
        ingestionStatus = try container.decodeIfPresent(String.self, forKey: .ingestionStatus)
        rowCountPreview = try container.decodeIfPresent(Int.self, forKey: .rowCountPreview)
        uploadedAt = try container.decodeIfPresent(String.self, forKey: .uploadedAt)
    }

    /// 入库日期（`YYYY-MM-DD`；拿不到就返回 nil，由调用方决定占位）。
    public var uploadedDay: String? {
        guard let uploadedAt, uploadedAt.count >= 10 else { return nil }
        return String(uploadedAt.prefix(10))
    }
}

// MARK: - 查询

/// 一次 `ad-*-raw` 查询的参数（**口径 1**：`period` 必填，没有「不传=全量」）。
///
/// `nil` 的日期落到哨兵窗口而不是省略参数 —— 后端 `parse_period` 在 `period` 为空时直接
/// `400 period is required`，`period=custom` 又要求 `start_date` / `end_date` 都有值。
/// Web 的写法是 `start_date: dateFrom || '2000-01-01'`，两边逐字一致（空白串在此同样落到
/// 哨兵：JS 里 `'' || '2000-01-01'` 就是哨兵）。
public struct AdDataQuery: Sendable, Equatable {
    public let country: String
    public let dateFrom: String?
    public let dateTo: String?
    public let limit: Int

    public init(
        country: String,
        dateFrom: String? = nil,
        dateTo: String? = nil,
        limit: Int = AdDataCatalog.pageLimit
    ) {
        self.country = country
        self.dateFrom = dateFrom
        self.dateTo = dateTo
        self.limit = limit
    }

    /// 实际发出的查询串（键序固定，便于断言与两端比对排错）。
    ///
    /// 不带 `order_by` / `order_dir`：默认即 `report_end_date desc`，而排序放在客户端做
    /// （对齐 Web，也避开 `_run_raw_query` 无 tiebreaker 的服务端翻页问题）。
    public var parameters: [String: String] {
        [
            "period": "custom",
            "country": country,
            "limit": String(limit),
            "start_date": dateFrom?.trimmedNonEmpty ?? AdDataCatalog.sentinelStartDate,
            "end_date": dateTo?.trimmedNonEmpty ?? AdDataCatalog.sentinelEndDate,
        ]
    }
}

/// 一次 `ad-upload-files` 查询的参数。
///
/// `limit` 取端点上限 500（Web 用默认的 100）：这份列表只用于显示「最近一次入库」，
/// 窗口大一点能覆盖更多类型，代价是单响应约 150 KB。
public struct AdUploadFilesQuery: Sendable, Equatable {
    public let country: String
    public let limit: Int

    public static let maxLimit = 500

    public init(country: String, limit: Int = AdUploadFilesQuery.maxLimit) {
        self.country = country
        self.limit = limit
    }

    public var parameters: [String: String] {
        ["country": country, "limit": String(limit)]
    }
}
