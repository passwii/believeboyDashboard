import Foundation

/// 长任务状态。
///
/// 用 `RawRepresentable` 而不是 `enum JobStatus: String`：后端 `JobStatus`
/// （`backend/app/models/job.py`）目前是 `pending / running / success / failed`，
/// 但「未知状态」在客户端必须能**安全降级**——用固定枚举时，后端加一个
/// `cancelled` 就会让整个 `/jobs/{id}` 响应解码失败，用户看到的是「任务查询坏了」，
/// 而真相只是「多了个我们不认识的状态」。这里保留原值，终态判断基于已知集合。
public struct JobStatus: RawRepresentable, Sendable, Equatable, Hashable, Codable {
    public let rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public static let pending = JobStatus(rawValue: "pending")
    public static let running = JobStatus(rawValue: "running")
    public static let success = JobStatus(rawValue: "success")
    public static let failed = JobStatus(rawValue: "failed")

    /// 是否已到终态（不会再有变化）。未知状态按「非终态」处理 —— 保守一轮，
    /// 由 `PollingPolicy` 的 `maxAttempts` 兜底，好过把未知状态当成成功。
    public var isTerminal: Bool {
        self == .success || self == .failed
    }

    public var isSuccess: Bool { self == .success }
}

/// 长任务摘要（`POST /jobs`、`GET /jobs/{job_id}` 的公共部分）。
///
/// `operator` 用反引号保留关键字原名：JSON 里就叫 `operator`，改名会让
/// `convertFromSnakeCase` 找不到键（它只是去下划线，不会把 `operator` 变
/// `operatorName`）。
public struct JobSummary: Decodable, Sendable, Equatable {
    public let id: Int
    public let jobType: String
    public let status: JobStatus
    /// 入队时带的参数（形状由 `job_type` 决定，故用 `JSONValue`）。
    public let payloadJson: [String: JSONValue]?
    public let `operator`: String?
    /// 时间戳保持**字符串**：后端返回的是 Pydantic 的 ISO8601（可能带 6 位小数秒、
    /// 可能无时区），解成 `Date` 会在这些形态上崩；需要展示时用
    /// `AgentOpsFormatting.parseISO8601`（与 S4 同口径）。
    public let createdAt: String?
    public let updatedAt: String?
}

/// 一次执行记录（`GET /jobs/{job_id}` 的 `runs`）。
public struct JobRun: Decodable, Sendable, Equatable {
    public let id: Int
    public let startedAt: String?
    public let finishedAt: String?
    public let `operator`: String?
    /// 日志摘录（后端截断过）。
    public let logExcerpt: String?
    /// 失败原因 —— 任务失败时这一项才是用户需要看到的。
    public let errorMessage: String?
    public let resultPath: String?
}

/// 长任务详情：摘要 + 全部 run。
public struct JobDetail: Decodable, Sendable, Equatable {
    public let id: Int
    public let jobType: String
    public let status: JobStatus
    public let payloadJson: [String: JSONValue]?
    public let `operator`: String?
    public let createdAt: String?
    public let updatedAt: String?
    public let runs: [JobRun]

    /// 最近一次 run 的失败原因（任务成功时为 `nil`）。
    ///
    /// 后端把 `error_message` 放在 run 上而不是 job 上，UI 要的是「一句话失败原因」，
    /// 故收敛到一处，避免每个页面各写一遍 `runs.last?.errorMessage`。
    public var failureMessage: String? {
        guard status == .failed else { return nil }
        let latest = runs.last
        let message = latest?.errorMessage?.trimmedNonEmpty ?? latest?.logExcerpt?.trimmedNonEmpty
        return message ?? "后端未提供失败原因。"
    }
}
