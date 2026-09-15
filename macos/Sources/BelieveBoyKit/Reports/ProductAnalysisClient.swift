import Foundation

/// 「产品分析」的数据源抽象。
///
/// 抽协议的理由与 S5.1~S5.4 各批相同：**确认后才写**、**失败可重试且不产生半成品**、
/// **异步任务轮询有退避与上限、可取消**、**切模块不泄漏 Task** —— 这些都是状态机逻辑，
/// 必须在完全不碰网络的前提下逐条钉住。测试注入假实现（含成功 / 失败 / 挂起 / 逐次失败
/// 的编排），能造出真实后端造不出来的时序（例如「committed 回包晚于用户切换」）。
public protocol ProductAnalysisDataProviding: Sendable {
    /// 当前账号可见的项目（`GET /projects/manage`，按 `X-Operator` 过滤）。
    func projects() async throws -> [AdProject]

    /// 识别一个本地文件（`POST /ad-upload/recognize`，multipart）。
    ///
    /// 只做识别：后端把文件存成临时文件并返回 `temp_file_id`，**不写业务表**。
    func recognizeAdUpload(fileURL: URL, filename: String, country: String) async throws -> AdUploadRecognition

    /// 入库（`POST /ad-upload/commit`，JSON）。
    func commitAdUpload(_ request: AdUploadCommitRequest) async throws -> AdUploadCommitResult

    /// 入库状态（`GET /ad-upload/status`）。
    func adUploadStatuses(_ query: AdUploadStatusQuery) async throws -> AdUploadStatusResponse

    /// 发起产品分析核算（`POST /product-analysis-reports`）。
    func createProductAnalysisReport(
        _ request: ProductAnalysisReportRequest
    ) async throws -> ProductAnalysisReportTicket

    /// 任务状态（`GET /product-analysis-reports/tasks/{id}`）。
    func productAnalysisTask(path: String) async throws -> ProductAnalysisTaskStatus

    /// 任务结果（`GET .../result`，`FileResponse`）—— **流式落盘**，不整份进内存。
    @discardableResult
    func downloadProductAnalysisResult(
        path: String,
        to destination: URL,
        onProgress: (@Sendable (DownloadProgress) -> Void)?
    ) async throws -> URL
}

public extension ProductAnalysisDataProviding {
    func downloadProductAnalysisResult(
        path: String,
        to destination: URL
    ) async throws -> URL {
        try await downloadProductAnalysisResult(path: path, to: destination, onProgress: nil)
    }
}

/// `ProductAnalysisDataProviding` 的真实实现（直连既有后端路由，零后端改动）。
///
/// 分层超时（对齐 Web 与既有批次）：
///
/// | 用途 | 端点 | 超时档 |
/// | --- | --- | --- |
/// | 项目列表 | `GET /projects/manage` | `.list`（5s） |
/// | 识别（multipart 上传） | `POST /ad-upload/recognize` | `.report`（60s） |
/// | 入库（JSON 写） | `POST /ad-upload/commit` | `.report`（60s） |
/// | 入库状态（列表） | `GET /ad-upload/status` | `.list`（5s） |
/// | 发起核算（写 + 建任务） | `POST /product-analysis-reports` | `.detail`（10s） |
/// | 任务状态（单资源） | `GET .../tasks/{id}` | `.list`（5s） |
/// | 任务结果（文件） | `GET .../tasks/{id}/result` | `.report`（60s） |
///
/// 为什么识别 / 入库走 `.report`（60s）而不是 `.detail`：两者都要把文件整份读完再落盘
/// （识别要解析 xlsx / csv、入库要按行写库），Web 端代理对这两条也是 report 档；
/// 用 10s 会在稍大的台账上偶发「上传失败」而其实后端还在写。
public struct ProductAnalysisClient: ProductAnalysisDataProviding {
    private let client: APIClient

    public init(client: APIClient) {
        self.client = client
    }

    public func projects() async throws -> [AdProject] {
        try await client.get(ReportCatalog.projectsEndpoint, tier: .list)
    }

    public func recognizeAdUpload(
        fileURL: URL,
        filename: String,
        country: String
    ) async throws -> AdUploadRecognition {
        var form = MultipartFormData()
        form.addField(ReportCatalog.uploadCountryField, country)
        form.addFile(
            ReportCatalog.uploadFileField,
            filename: filename,
            mimeType: Self.mimeType(forFilename: filename),
            contentsOf: fileURL
        )
        return try await client.upload(
            ReportCatalog.adUploadRecognizeEndpoint,
            form: form,
            tier: .report
        )
    }

    public func commitAdUpload(_ request: AdUploadCommitRequest) async throws -> AdUploadCommitResult {
        try await client.write(.post, ReportCatalog.adUploadCommitEndpoint, body: request, tier: .report)
    }

    public func adUploadStatuses(_ query: AdUploadStatusQuery) async throws -> AdUploadStatusResponse {
        try await client.get(
            ReportCatalog.adUploadStatusEndpoint,
            query: query.parameters,
            tier: .list
        )
    }

    public func createProductAnalysisReport(
        _ request: ProductAnalysisReportRequest
    ) async throws -> ProductAnalysisReportTicket {
        try await client.write(
            .post,
            ReportCatalog.productAnalysisReportsEndpoint,
            body: request,
            tier: .detail
        )
    }

    /// 轮询 / 下载都按**后端给的路径**走（`status_endpoint` / `result_endpoint`），
    /// 参数是整条路径而不是 task id —— 端点改名时不用改客户端。
    public func productAnalysisTask(path: String) async throws -> ProductAnalysisTaskStatus {
        try await client.get(path, tier: .list)
    }

    @discardableResult
    public func downloadProductAnalysisResult(
        path: String,
        to destination: URL,
        onProgress: (@Sendable (DownloadProgress) -> Void)? = nil
    ) async throws -> URL {
        try await client.download(path, to: destination, tier: .report, onProgress: onProgress)
    }

    /// 上传体的 MIME。后端按**扩展名**分派解析器（`ALLOWED_EXTENSIONS`），不校验 MIME，
    /// 所以这里只求「说真话」：给不对反而会让中间层（代理 / 杀软）误判。
    public static func mimeType(forFilename filename: String) -> String {
        switch (filename as NSString).pathExtension.lowercased() {
        case "xlsx":
            return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        case "xls":
            return "application/vnd.ms-excel"
        case "csv":
            return "text/csv"
        case "txt":
            return "text/plain"
        default:
            return "application/octet-stream"
        }
    }
}

// MARK: - 报表自动化

/// 「报表自动化」状态页的数据源抽象。
public protocol ReportAutomationDataProviding: Sendable {
    /// 当前账号可见的项目（`GET /projects/manage`）。
    func projects() async throws -> [AdProject]

    /// RPA 报表上传状态矩阵（`GET /rpa-reports/status`）。
    func rpaStatus(_ query: RpaReportStatusQuery) async throws -> RpaReportStatusResponse
}

/// `ReportAutomationDataProviding` 的真实实现。
///
/// 分层超时：项目列表 `.list`（5s）；`rpa-reports/status` 走 **`.stats`（15s）** ——
/// 后端这条是按「项目 × 报表类型」扫多张表再各自查 `latest` 的**聚合**（`rpa_report_service`），
/// 5s 档在项目数再涨一档时会把整页变成错误态。对齐 Web 端代理给统计档的口径。
public struct ReportAutomationClient: ReportAutomationDataProviding {
    private let client: APIClient

    public init(client: APIClient) {
        self.client = client
    }

    public func projects() async throws -> [AdProject] {
        try await client.get(ReportCatalog.projectsEndpoint, tier: .list)
    }

    public func rpaStatus(_ query: RpaReportStatusQuery) async throws -> RpaReportStatusResponse {
        try await client.get(
            ReportCatalog.rpaStatusEndpoint,
            query: query.parameters,
            tier: .stats
        )
    }
}
