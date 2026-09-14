import Foundation

/// 长任务客户端：入队 → 轮询到终态 → 下载结果。
///
/// 对应 `backend/app/api/v1/endpoints/jobs.py` 的三个端点：
///
/// | 用途 | 端点 | 超时档 |
/// | --- | --- | --- |
/// | 入队 | `POST /jobs`（`job_type` + `file_id` + `params`） | `.detail`（10s） |
/// | 查询 | `GET /jobs/{job_id}` | `.list`（5s） |
/// | 取结果 | `GET /jobs/{job_id}/result`（`FileResponse`） | `.report`（60s） |
///
/// 为什么不做成"一个方法干完三件事"：这三步的失败语义完全不同 —— 入队失败是参数/权限
/// 问题，轮询超时是"还在跑"，下载失败可能只是结果文件被清理。UI 要把它们分别说清楚
/// （「任务失败了」和「任务还在跑，已停止等待」是两种提示），所以能力分层暴露，
/// `waitForSuccess` 只作为最常见组合的便捷入口。
public struct JobClient: Sendable {
    private let client: APIClient

    public init(client: APIClient) {
        self.client = client
    }

    /// 入队（`POST /jobs`）。
    ///
    /// - Parameters:
    ///   - jobType: 后端注册的任务类型（如 `report_upload_ingest`）。
    ///   - fileID: 目标文件标识。后端 `CreateJobRequest.file_id` 是**必填字符串**
    ///     （`min_length=1`），不是可选数字 id。
    ///   - params: 任务参数，形状由 `jobType` 决定，故用 `JSONValue` 承载。
    public func submit(
        jobType: String,
        fileID: String,
        params: [String: JSONValue] = [:],
        tier: RequestTier = .detail
    ) async throws -> JobSummary {
        let payload = CreateJobPayload(jobType: jobType, fileID: fileID, params: params)
        return try await client.write(.post, "/jobs", body: payload, tier: tier)
    }

    /// 查详情（`GET /jobs/{job_id}`）。
    public func detail(_ jobID: Int, tier: RequestTier = .list) async throws -> JobDetail {
        try await client.get("/jobs/\(jobID)", tier: tier)
    }

    /// 轮询到终态（`success` 或 `failed`）。
    ///
    /// 返回的是终态详情而不是 `Void`：失败原因（`JobDetail.failureMessage`）、
    /// 执行日志（`runs[].logExcerpt`）都在里面，用户需要看到它们才知道下一步做什么。
    ///
    /// 超时上限由 `policy` 决定，**不会无限打后端**；取消会原样向上抛
    /// `CancellationError`（切模块 / 关视图时不该被当成"任务失败"）。
    public func waitForCompletion(
        _ jobID: Int,
        policy: PollingPolicy = .job,
        sleeper: PollSleeper = .task,
        tier: RequestTier = .list
    ) async throws -> JobDetail {
        try await policy.run(sleeper: sleeper) { _ in
            let detail = try await detail(jobID, tier: tier)
            return detail.status.isTerminal ? .finished(detail) : .pending
        }
    }

    /// 轮询到终态，失败则抛错（`APIError.jobFailed`）。
    ///
    /// 成功路径返回 `JobDetail`（调用方可能要拿 `runs` 里的日志或 `result_path`）。
    public func waitForSuccess(
        _ jobID: Int,
        policy: PollingPolicy = .job,
        sleeper: PollSleeper = .task,
        tier: RequestTier = .list
    ) async throws -> JobDetail {
        let detail = try await waitForCompletion(jobID, policy: policy, sleeper: sleeper, tier: tier)
        guard detail.status.isSuccess else {
            throw APIError.jobFailed(status: detail.status.rawValue, detail: detail.failureMessage)
        }
        return detail
    }

    /// 下载任务结果（`GET /jobs/{job_id}/result`）。流式落盘，见 `APIClient.download`。
    @discardableResult
    public func downloadResult(
        _ jobID: Int,
        to destination: URL,
        onProgress: (@Sendable (DownloadProgress) -> Void)? = nil
    ) async throws -> URL {
        try await client.download(
            "/jobs/\(jobID)/result",
            to: destination,
            tier: .report,
            onProgress: onProgress
        )
    }
}

/// `POST /jobs` 的请求体。
///
/// 显式写 `CodingKeys`：`APIClient` 的编码器是**原样键名**的 `JSONEncoder`
/// （没有 `.convertToSnakeCase`），而后端要的是 `job_type` / `file_id`。
/// 靠属性名自动生成会发出 `jobType` / `fileID`，后端直接 422。
private struct CreateJobPayload: Encodable, Sendable {
    let jobType: String
    let fileID: String
    let params: [String: JSONValue]

    enum CodingKeys: String, CodingKey {
        case jobType = "job_type"
        case fileID = "file_id"
        case params
    }
}
