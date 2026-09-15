import Foundation

// MARK: - 请求（`POST /product-analysis-reports`）

/// 发起一次产品分析核算（后端 `CreateProductAnalysisReportRequest`）。
///
/// 三类报表的 file id 是**必填**（`min_length=1`），第四个（库存）可选 —— 与后端
/// `file_ids` 那条分支（`if data.inventory_report_file_id and ...strip()`）一致。
/// `file_id` 就是入库响应里的 `file_id`（`finalize_ad_upload_temp_file` 落盘后的文件名）。
public struct ProductAnalysisReportRequest: Encodable, Sendable, Equatable {
    public let projectName: String
    public let reportStartDate: String
    public let reportEndDate: String
    public let businessReportFileID: String
    public let paymentReportFileID: String
    public let adReportFileID: String
    public let inventoryReportFileID: String?
    public let country: String

    public init(
        projectName: String,
        reportStartDate: String,
        reportEndDate: String,
        businessReportFileID: String,
        paymentReportFileID: String,
        adReportFileID: String,
        inventoryReportFileID: String? = nil,
        country: String = ReportCatalog.defaultCountry
    ) {
        self.projectName = projectName
        self.reportStartDate = reportStartDate
        self.reportEndDate = reportEndDate
        self.businessReportFileID = businessReportFileID
        self.paymentReportFileID = paymentReportFileID
        self.adReportFileID = adReportFileID
        self.inventoryReportFileID = inventoryReportFileID
        self.country = country
    }

    enum CodingKeys: String, CodingKey {
        case projectName = "project_name"
        case reportStartDate = "report_start_date"
        case reportEndDate = "report_end_date"
        case businessReportFileID = "business_report_file_id"
        case paymentReportFileID = "payment_report_file_id"
        case adReportFileID = "ad_report_file_id"
        case inventoryReportFileID = "inventory_report_file_id"
        case country
    }

    /// 提交前的阻塞项（空数组 = 可以发）。判定放在 Kit，可离线逐条钉住。
    ///
    /// 这一层刻意**不**做「日期格式」之外的业务校验：后端会返回 400/422 的中文 detail，
    /// 客户端把能提前判的判掉即可（少一次注定失败的写请求）。
    public var blockers: [ProductAnalysisRequestBlocker] {
        var blockers: [ProductAnalysisRequestBlocker] = []
        if projectName.trimmedNonEmpty == nil { blockers.append(.missingProject) }
        if businessReportFileID.trimmedNonEmpty == nil { blockers.append(.missingBusinessReport) }
        if paymentReportFileID.trimmedNonEmpty == nil { blockers.append(.missingPaymentReport) }
        if adReportFileID.trimmedNonEmpty == nil { blockers.append(.missingAdReport) }
        if ReportCatalog.parseDateString(reportStartDate) == nil
            || ReportCatalog.parseDateString(reportEndDate) == nil
        {
            blockers.append(.invalidDate)
        } else if reportStartDate > reportEndDate {
            blockers.append(.reversedDateRange)
        }
        return blockers
    }

    public var isSubmittable: Bool { blockers.isEmpty }
}

public enum ProductAnalysisRequestBlocker: Sendable, Equatable {
    case missingProject
    case missingBusinessReport
    case missingPaymentReport
    case missingAdReport
    case invalidDate
    case reversedDateRange

    public var message: String {
        switch self {
        case .missingProject: return "请先选择项目"
        case .missingBusinessReport: return "缺少业务报告的 file_id"
        case .missingPaymentReport: return "缺少付款报告的 file_id"
        case .missingAdReport: return "缺少广告报告的 file_id"
        case .invalidDate: return "日期格式必须是 YYYY-MM-DD"
        case .reversedDateRange: return "开始日期不能晚于结束日期"
        }
    }
}

// MARK: - 发起响应

/// `POST /product-analysis-reports` 的响应（后端 `ProductAnalysisReportResponse`）。
///
/// `status_endpoint` / `result_endpoint` 是后端自己给的**相对路径**：客户端跟着它们走，
/// 而不是自己拼 URL —— 端点改名时这两条会一起变，拼死路径则会在改名当天悄悄 404。
public struct ProductAnalysisReportTicket: Decodable, Sendable, Equatable {
    public let jobID: Int
    public let statusEndpoint: String?
    public let resultEndpoint: String?
    public let status: JobStatus
    public let createdAt: String?

    // 显式写 `CodingKeys`：`convertFromSnakeCase` 把 `job_id` 变成 `jobId`（**不是** `jobID`），
    // 而 Swift 侧习惯写 `ID`。两边对不上时编译通过、运行时整条响应报「缺少字段 taskID」
    // （S4 的 `calls_24h → calls24H` 是同一个坑）。
    private enum CodingKeys: String, CodingKey {
        case jobID = "jobId"
        case statusEndpoint, resultEndpoint, status, createdAt
    }

    public init(
        jobID: Int,
        statusEndpoint: String? = nil,
        resultEndpoint: String? = nil,
        status: JobStatus,
        createdAt: String? = nil
    ) {
        self.jobID = jobID
        self.statusEndpoint = statusEndpoint
        self.resultEndpoint = resultEndpoint
        self.status = status
        self.createdAt = createdAt
    }

    /// 轮询用的路径 —— 后端给了就跟着走（去掉它带的 `/api/v1` 前缀，见
    /// `ReportCatalog.clientPath(fromBackendEndpoint:)`），没给就用目录里的规范路径。
    public var resolvedStatusPath: String {
        ReportCatalog.clientPath(fromBackendEndpoint: statusEndpoint)
            ?? ReportCatalog.productAnalysisTaskEndpoint(taskID: jobID)
    }

    /// 下载用的路径（同上）。
    public var resolvedResultPath: String {
        ReportCatalog.clientPath(fromBackendEndpoint: resultEndpoint)
            ?? ReportCatalog.productAnalysisResultEndpoint(taskID: jobID)
    }
}

// MARK: - 任务状态

/// `GET /product-analysis-reports/tasks/{task_id}` 的响应
/// （后端 `ProductAnalysisTaskStatusResponse`）。
///
/// 这是**异步任务的唯一进度来源**：`stage` 是后端写的中文阶段名（`started` /
/// `processing` / `completed` / `failed`），UI 不要把它当枚举硬匹配 —— 后端加一个阶段
/// 不该让状态页变成「任务查询坏了」。
public struct ProductAnalysisTaskStatus: Decodable, Sendable, Equatable {
    public let taskID: Int
    public let status: JobStatus
    public let stage: String
    /// 0…100（后端已夹过）。
    public let progress: Int
    public let message: String?
    public let errorMessage: String?
    /// `idle / running / success / failed`：结果**落库**的进度，与任务状态是两件事。
    public let persistenceStatus: String
    public let persistenceMessage: String?
    public let createdAt: String?
    public let updatedAt: String?

    // 同 `ProductAnalysisReportTicket`：`task_id` → `taskId`，与 Swift 习惯的 `taskID` 差一个字母。
    private enum CodingKeys: String, CodingKey {
        case taskID = "taskId"
        case status, stage, progress, message, errorMessage
        case persistenceStatus, persistenceMessage, createdAt, updatedAt
    }

    public init(
        taskID: Int,
        status: JobStatus,
        stage: String,
        progress: Int,
        message: String? = nil,
        errorMessage: String? = nil,
        persistenceStatus: String = "idle",
        persistenceMessage: String? = nil,
        createdAt: String? = nil,
        updatedAt: String? = nil
    ) {
        self.taskID = taskID
        self.status = status
        self.stage = stage
        self.progress = progress
        self.message = message
        self.errorMessage = errorMessage
        self.persistenceStatus = persistenceStatus
        self.persistenceMessage = persistenceMessage
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    public var isTerminal: Bool { status.isTerminal }
    public var isSuccess: Bool { status.isSuccess }

    /// 有结果文件可下载。后端 `result` 端点在 `status != success` 时回 409，故先判状态。
    public var hasDownloadableResult: Bool { status.isSuccess }

    /// 一行状态文案（失败优先 —— 用户最需要看到的是失败原因）。
    public var summaryText: String {
        if let errorMessage = errorMessage?.trimmedNonEmpty {
            return "处理失败：\(errorMessage)"
        }
        if let message = message?.trimmedNonEmpty { return message }
        return stage
    }

    /// 夹回 0…1（后端理论上已经夹过，但进度条不该因为一个越界值画到框外）。
    public var progressFraction: Double {
        min(1, max(0, Double(progress) / 100))
    }
}
