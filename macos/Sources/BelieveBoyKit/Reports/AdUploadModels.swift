import Foundation

// MARK: - 识别（`POST /ad-upload/recognize` 的响应）

/// 项目匹配摘要（后端 `AdUploadProjectMatchSummary`）。
public struct AdUploadProjectMatch: Decodable, Sendable, Equatable {
    /// 匹配状态。未知值**不**让整条响应解码失败 —— 后端加一个状态不该把页面变成错误页。
    public enum Status: Sendable, Equatable {
        /// 没匹配上（用户必须自己选项目）。
        case unmatched
        /// 唯一命中。
        case matched
        /// 命中多个候选（用户必须自己选）。
        case conflict
        /// 用户先前手动指定过。
        case manual
        /// 客户端不认识的取值（原样保留，按「需要用户确认」处理）。
        case unknown(String)

        public init(rawValue: String) {
            switch rawValue {
            case "unmatched": self = .unmatched
            case "matched": self = .matched
            case "conflict": self = .conflict
            case "manual": self = .manual
            default: self = .unknown(rawValue)
            }
        }

        public var rawValue: String {
            switch self {
            case .unmatched: return "unmatched"
            case .matched: return "matched"
            case .conflict: return "conflict"
            case .manual: return "manual"
            case .unknown(let value): return value
            }
        }

        /// 是否可以**直接**用识别出的项目名入库（Web `report-status-card` 的
        /// `projectLocked` 语义：只有 `matched` 才敢锁定）。
        public var isAutoResolved: Bool { self == .matched }
    }

    public let status: Status
    public let projectName: String?
    public let candidateProjects: [String]
    public let matchedBy: String?
    public let matchedValues: [String]
    public let message: String?

    public init(
        status: Status,
        projectName: String? = nil,
        candidateProjects: [String] = [],
        matchedBy: String? = nil,
        matchedValues: [String] = [],
        message: String? = nil
    ) {
        self.status = status
        self.projectName = projectName
        self.candidateProjects = candidateProjects
        self.matchedBy = matchedBy
        self.matchedValues = matchedValues
        self.message = message
    }

    private enum CodingKeys: String, CodingKey {
        case status, projectName, candidateProjects, matchedBy, matchedValues, message
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        status = Status(rawValue: try container.decodeIfPresent(String.self, forKey: .status) ?? "")
        projectName = try container.decodeIfPresent(String.self, forKey: .projectName)
        candidateProjects = try container.decodeIfPresent([String].self, forKey: .candidateProjects) ?? []
        matchedBy = try container.decodeIfPresent(String.self, forKey: .matchedBy)
        matchedValues = try container.decodeIfPresent([String].self, forKey: .matchedValues) ?? []
        message = try container.decodeIfPresent(String.self, forKey: .message)
    }
}

/// 识别结果（后端 `AdUploadRecognitionResponse`）。
///
/// **这是「即将写入的内容」的证据**：写链路要求识别结果先呈现、用户明确确认后才发
/// `commit`（PLAN §8 的 S6 口径）。所以这里把识别器给出的每一条判据都留着 ——
/// 报表类型 / 中文标签 / 命中列 / 日期 / 项目匹配 / 行数预览 / 警告 ——
/// 少一项，用户就是「闭着眼睛点确认」。
///
/// ⚠️ 与 `/report-upload/recognize`（A 表那条链路）的响应**不是同一个形状**：
/// 那个有 `detected_date` / `detected_countries` / `date_input_mode` / `primary_country`，
/// 这个有 `detected_report_date` 与 `matched_columns`。桌面端两批分开落模型，不要互相套用。
public struct AdUploadRecognition: Decodable, Sendable, Equatable {
    public enum Status: Sendable, Equatable {
        case recognized
        /// 认得出文件，但不在支持的报表类型里（如 CSV 的业务报告走 ad 通道）。
        case unsupported
        case error
        case unknown(String)

        public init(rawValue: String) {
            switch rawValue {
            case "recognized": self = .recognized
            case "unsupported": self = .unsupported
            case "error": self = .error
            default: self = .unknown(rawValue)
            }
        }

        public var rawValue: String {
            switch self {
            case .recognized: return "recognized"
            case .unsupported: return "unsupported"
            case .error: return "error"
            case .unknown(let value): return value
            }
        }

        /// 只有 `recognized` 才可能入库（Web 同判据）。
        public var isRecognized: Bool { self == .recognized }
    }

    public let tempFileID: String
    public let originalFilename: String
    public let fileExtension: String
    /// 后端 `AdUploadType` 字面量；`unknown` = 没认出来。
    public let reportType: String
    public let reportLabel: String
    public let matchedColumns: [String]
    public let reason: String
    public let status: Status
    public let country: String
    public let detectedReportDate: String?
    public let detectedStartDate: String?
    public let detectedEndDate: String?
    public let projectMatch: AdUploadProjectMatch
    public let rowCountPreview: Int?
    public let warnings: [String]

    public init(
        tempFileID: String,
        originalFilename: String,
        fileExtension: String = "",
        reportType: String,
        reportLabel: String,
        matchedColumns: [String] = [],
        reason: String = "",
        status: Status,
        country: String = ReportCatalog.defaultCountry,
        detectedReportDate: String? = nil,
        detectedStartDate: String? = nil,
        detectedEndDate: String? = nil,
        projectMatch: AdUploadProjectMatch = AdUploadProjectMatch(status: .unmatched),
        rowCountPreview: Int? = nil,
        warnings: [String] = []
    ) {
        self.tempFileID = tempFileID
        self.originalFilename = originalFilename
        self.fileExtension = fileExtension
        self.reportType = reportType
        self.reportLabel = reportLabel
        self.matchedColumns = matchedColumns
        self.reason = reason
        self.status = status
        self.country = country
        self.detectedReportDate = detectedReportDate
        self.detectedStartDate = detectedStartDate
        self.detectedEndDate = detectedEndDate
        self.projectMatch = projectMatch
        self.rowCountPreview = rowCountPreview
        self.warnings = warnings
    }

    private enum CodingKeys: String, CodingKey {
        case tempFileID = "tempFileId"
        case originalFilename, fileExtension = "extension", reportType, reportLabel
        case matchedColumns, reason, status, country
        case detectedReportDate, detectedStartDate, detectedEndDate
        case projectMatch, rowCountPreview, warnings
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tempFileID = try container.decode(String.self, forKey: .tempFileID)
        originalFilename = try container.decodeIfPresent(String.self, forKey: .originalFilename) ?? ""
        fileExtension = try container.decodeIfPresent(String.self, forKey: .fileExtension) ?? ""
        reportType = try container.decodeIfPresent(String.self, forKey: .reportType) ?? "unknown"
        reportLabel = try container.decodeIfPresent(String.self, forKey: .reportLabel)
            ?? ReportTypeLabels.label(for: reportType)
        matchedColumns = try container.decodeIfPresent([String].self, forKey: .matchedColumns) ?? []
        reason = try container.decodeIfPresent(String.self, forKey: .reason) ?? ""
        status = Status(rawValue: try container.decodeIfPresent(String.self, forKey: .status) ?? "")
        country = try container.decodeIfPresent(String.self, forKey: .country) ?? ReportCatalog.defaultCountry
        detectedReportDate = try container.decodeIfPresent(String.self, forKey: .detectedReportDate)
        detectedStartDate = try container.decodeIfPresent(String.self, forKey: .detectedStartDate)
        detectedEndDate = try container.decodeIfPresent(String.self, forKey: .detectedEndDate)
        projectMatch = try container.decodeIfPresent(AdUploadProjectMatch.self, forKey: .projectMatch)
            ?? AdUploadProjectMatch(status: .unmatched)
        rowCountPreview = try container.decodeIfPresent(Int.self, forKey: .rowCountPreview)
        warnings = try container.decodeIfPresent([String].self, forKey: .warnings) ?? []
    }

    // MARK: - 派生

    /// 中文标签（后端给了就用后端的，没给就查目录 —— 两处都认不出来才回退原始 key）。
    public var displayLabel: String {
        let trimmed = reportLabel.trimmedNonEmpty
        if let trimmed { return trimmed }
        return ReportTypeLabels.label(for: reportType)
    }

    /// 识别出的日期区间（单日报表退化成 `reportDate ~ reportDate`，Web 同口径）。
    public var detectedRange: (start: String, end: String)? {
        if let start = detectedStartDate, let end = detectedEndDate { return (start, end) }
        if let single = detectedReportDate { return (single, single) }
        return nil
    }

    /// 需要用户在**确认前**补的项（空数组 = 识别结果齐全，可以直接确认）。
    ///
    /// 这是「不可逆操作不可一键完成」的一半：缺项目或缺日期的识别结果，确认按钮就得灰着，
    /// 而不是让后端 422 回一条看不懂的英文。
    public func confirmBlockers(selectedProject: String?, startDate: String?, endDate: String?)
        -> [AdUploadConfirmBlocker]
    {
        var blockers: [AdUploadConfirmBlocker] = []
        if !status.isRecognized { blockers.append(.notRecognized) }
        if (selectedProject ?? "").trimmedNonEmpty == nil {
            blockers.append(projectMatch.status.isAutoResolved ? .missingProject : .projectNeedsChoice)
        }
        // 本批两条链路都要日期：入库要版本号 / 产品分析要周期。后端 `commit` 只在
        // `not dry_run` 时做单日校验，故「填没填」由客户端先挡一道。
        if AdUploadReportTypes.requiresDateRange(reportType) {
            if (startDate ?? "").trimmedNonEmpty == nil || (endDate ?? "").trimmedNonEmpty == nil {
                blockers.append(.missingDateRange)
            } else if let start = startDate, let end = endDate, start > end {
                blockers.append(.reversedDateRange)
            }
        } else if (startDate ?? "").trimmedNonEmpty == nil {
            blockers.append(.missingReportDate)
        }
        return blockers
    }
}

/// 确认入库前的阻塞项（文案由 UI 层出，判定留在 Kit —— 可离线逐条钉住）。
public enum AdUploadConfirmBlocker: Sendable, Equatable {
    case notRecognized
    case projectNeedsChoice
    case missingProject
    case missingReportDate
    case missingDateRange
    case reversedDateRange

    public var message: String {
        switch self {
        case .notRecognized: return "识别未通过，不能提交"
        case .projectNeedsChoice: return "识别到多个候选项目，请先选择项目"
        case .missingProject: return "请先选择项目"
        case .missingReportDate: return "请先填写报表日期"
        case .missingDateRange: return "请先填写完整的日期范围"
        case .reversedDateRange: return "开始日期不能晚于结束日期"
        }
    }
}

// MARK: - 入库（`POST /ad-upload/commit`）

/// 入库请求（后端 `AdUploadCommitRequest`）。
///
/// **键名必须显式写成 snake_case**：`APIClient` 的编码器是原样键名的 `JSONEncoder`
/// （没有 `.convertToSnakeCase`），靠属性名自动生成会发出 `tempFileID` / `reportType`，
/// 后端直接 422。与 `JobClient.CreateJobPayload` 同一坑、同一处置。
public struct AdUploadCommitRequest: Encodable, Sendable, Equatable {
    public let tempFileID: String
    public let reportType: String
    public let originalFilename: String?
    public let projectName: String?
    public let country: String
    public let reportDate: String?
    public let reportStartDate: String?
    public let reportEndDate: String?
    /// `true` = 只做识别校验 + 临时文件复制 + 行级解析，**不写** `ad_upload_files` /
    /// `ad_upload_promoted_product_rows`，也不占版本号。
    ///
    /// 本批的写链路两处都用它：
    /// - 「手动核算」页要的是「识别 + 计算」快照，不落库（Web `manual-calculation-panel`
    ///   与 `monthly-sku-analysis-panel` 的 `dry_run: true` 逐字一致）；
    /// - 「入库」页（`auto-upload`）才是正式入库，本批不搬那条链路。
    public let dryRun: Bool

    public init(
        tempFileID: String,
        reportType: String,
        originalFilename: String? = nil,
        projectName: String? = nil,
        country: String = ReportCatalog.defaultCountry,
        reportDate: String? = nil,
        reportStartDate: String? = nil,
        reportEndDate: String? = nil,
        dryRun: Bool = false
    ) {
        self.tempFileID = tempFileID
        self.reportType = reportType
        self.originalFilename = originalFilename
        self.projectName = projectName
        self.country = country
        self.reportDate = reportDate
        self.reportStartDate = reportStartDate
        self.reportEndDate = reportEndDate
        self.dryRun = dryRun
    }

    enum CodingKeys: String, CodingKey {
        case tempFileID = "temp_file_id"
        case reportType = "report_type"
        case originalFilename = "original_filename"
        case projectName = "project_name"
        case country
        case reportDate = "report_date"
        case reportStartDate = "report_start_date"
        case reportEndDate = "report_end_date"
        case dryRun = "dry_run"
    }
}

/// 入库结果（后端 `AdUploadCommitResponse`）。
public struct AdUploadCommitResult: Decodable, Sendable, Equatable {
    /// `0` = `dry_run`（后端不落库，故没有行 id）。
    public let id: Int
    public let reportType: String
    public let reportLabel: String
    /// `pending / saved / failed / success / skipped`；`skipped` = dry_run。
    public let ingestionStatus: String
    public let projectName: String
    public let country: String
    public let reportDate: String?
    public let reportStartDate: String
    public let reportEndDate: String
    /// 落盘后的文件名 —— 产品分析异步任务要的就是这个（`*_file_id`）。
    public let fileID: String
    public let filePath: String
    public let version: Int
    public let isCurrent: Bool
    public let message: String

    public init(
        id: Int,
        reportType: String,
        reportLabel: String,
        ingestionStatus: String,
        projectName: String,
        country: String,
        reportDate: String? = nil,
        reportStartDate: String,
        reportEndDate: String,
        fileID: String,
        filePath: String,
        version: Int,
        isCurrent: Bool,
        message: String
    ) {
        self.id = id
        self.reportType = reportType
        self.reportLabel = reportLabel
        self.ingestionStatus = ingestionStatus
        self.projectName = projectName
        self.country = country
        self.reportDate = reportDate
        self.reportStartDate = reportStartDate
        self.reportEndDate = reportEndDate
        self.fileID = fileID
        self.filePath = filePath
        self.version = version
        self.isCurrent = isCurrent
        self.message = message
    }

    private enum CodingKeys: String, CodingKey {
        case id, reportType, reportLabel, ingestionStatus, projectName, country
        case reportDate, reportStartDate, reportEndDate
        case fileID = "fileId"
        case filePath, version, isCurrent, message
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(Int.self, forKey: .id) ?? 0
        reportType = try container.decodeIfPresent(String.self, forKey: .reportType) ?? ""
        reportLabel = try container.decodeIfPresent(String.self, forKey: .reportLabel)
            ?? ReportTypeLabels.label(for: reportType)
        ingestionStatus = try container.decodeIfPresent(String.self, forKey: .ingestionStatus) ?? ""
        projectName = try container.decodeIfPresent(String.self, forKey: .projectName) ?? ""
        country = try container.decodeIfPresent(String.self, forKey: .country) ?? ReportCatalog.defaultCountry
        reportDate = try container.decodeIfPresent(String.self, forKey: .reportDate)
        reportStartDate = try container.decodeIfPresent(String.self, forKey: .reportStartDate) ?? ""
        reportEndDate = try container.decodeIfPresent(String.self, forKey: .reportEndDate) ?? ""
        fileID = try container.decodeIfPresent(String.self, forKey: .fileID) ?? ""
        filePath = try container.decodeIfPresent(String.self, forKey: .filePath) ?? ""
        version = try container.decodeIfPresent(Int.self, forKey: .version) ?? 0
        isCurrent = try container.decodeIfPresent(Bool.self, forKey: .isCurrent) ?? true
        message = try container.decodeIfPresent(String.self, forKey: .message) ?? ""
    }

    /// `dry_run` 走过（后端回 `skipped` + `id=0`）—— UI 据此把「已写入」改成「已识别（不入库）」。
    public var isDryRun: Bool { ingestionStatus == "skipped" || id == 0 }
}

// MARK: - 入库状态（`GET /ad-upload/status`）

/// 查询参数（后端 `list_ad_upload_status` 的五个 Query）。
public struct AdUploadStatusQuery: Sendable, Equatable, Encodable {
    public var country: String
    public var projectName: String?
    public var reportType: String?
    public var reportDate: String?
    public var limit: Int

    public init(
        country: String = ReportCatalog.defaultCountry,
        projectName: String? = nil,
        reportType: String? = nil,
        reportDate: String? = nil,
        limit: Int = ReportCatalog.adUploadStatusLimit
    ) {
        self.country = country
        self.projectName = projectName
        self.reportType = reportType
        self.reportDate = reportDate
        self.limit = limit
    }

    /// 只发有值的参数 —— 空串会被后端当成「按空串过滤」而不是「不过滤」。
    public var parameters: [String: String] {
        var params: [String: String] = [
            "country": country,
            "limit": String(limit),
        ]
        if let projectName = projectName?.trimmedNonEmpty { params["project_name"] = projectName }
        if let reportType = reportType?.trimmedNonEmpty { params["report_type"] = reportType }
        if let reportDate = reportDate?.trimmedNonEmpty { params["report_date"] = reportDate }
        return params
    }
}

/// 一条入库记录（后端 `AdUploadStatusItem`）。
public struct AdUploadStatusItem: Decodable, Sendable, Equatable, Identifiable {
    public let id: Int
    public let projectName: String
    public let reportType: String
    public let reportLabel: String
    public let country: String
    public let reportDate: String?
    public let reportStartDate: String
    public let reportEndDate: String
    public let version: Int
    public let isCurrent: Bool
    public let recognitionStatus: String
    public let ingestionStatus: String
    public let originalFilename: String?
    public let rowCountPreview: Int?
    public let updatedAt: String?
    public let warnings: [String]

    private enum CodingKeys: String, CodingKey {
        case id, projectName, reportType, reportLabel, country
        case reportDate, reportStartDate, reportEndDate, version, isCurrent
        case recognitionStatus, ingestionStatus, originalFilename, rowCountPreview, updatedAt, warnings
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(Int.self, forKey: .id)
        projectName = try container.decodeIfPresent(String.self, forKey: .projectName) ?? ""
        reportType = try container.decodeIfPresent(String.self, forKey: .reportType) ?? ""
        reportLabel = try container.decodeIfPresent(String.self, forKey: .reportLabel)
            ?? ReportTypeLabels.label(for: reportType)
        country = try container.decodeIfPresent(String.self, forKey: .country) ?? ReportCatalog.defaultCountry
        reportDate = try container.decodeIfPresent(String.self, forKey: .reportDate)
        reportStartDate = try container.decodeIfPresent(String.self, forKey: .reportStartDate) ?? ""
        reportEndDate = try container.decodeIfPresent(String.self, forKey: .reportEndDate) ?? ""
        version = try container.decodeIfPresent(Int.self, forKey: .version) ?? 0
        isCurrent = try container.decodeIfPresent(Bool.self, forKey: .isCurrent) ?? true
        recognitionStatus = try container.decodeIfPresent(String.self, forKey: .recognitionStatus) ?? ""
        ingestionStatus = try container.decodeIfPresent(String.self, forKey: .ingestionStatus) ?? ""
        originalFilename = try container.decodeIfPresent(String.self, forKey: .originalFilename)
        rowCountPreview = try container.decodeIfPresent(Int.self, forKey: .rowCountPreview)
        updatedAt = try container.decodeIfPresent(String.self, forKey: .updatedAt)
        warnings = try container.decodeIfPresent([String].self, forKey: .warnings) ?? []
    }

    /// 日期列展示口径（单日报表显示 `report_date`，周期报表显示区间）。
    public var dateText: String {
        if let reportDate, !reportDate.isEmpty { return reportDate }
        if reportStartDate.isEmpty && reportEndDate.isEmpty { return "—" }
        return "\(reportStartDate) ~ \(reportEndDate)"
    }

    /// 「已入库」的判据（Web 状态矩阵只看 `is_uploaded`，这里额外要求当前版本）。
    public var isIngested: Bool { ingestionStatus == "success" || ingestionStatus == "saved" }
}

/// 入库状态列表（后端 `AdUploadStatusResponse`）。
public struct AdUploadStatusResponse: Decodable, Sendable, Equatable {
    public let country: String
    public let items: [AdUploadStatusItem]

    public init(country: String, items: [AdUploadStatusItem]) {
        self.country = country
        self.items = items
    }

    private enum CodingKeys: String, CodingKey {
        case country, items
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        country = try container.decodeIfPresent(String.self, forKey: .country) ?? ReportCatalog.defaultCountry
        items = try container.decodeIfPresent([AdUploadStatusItem].self, forKey: .items) ?? []
    }
}
