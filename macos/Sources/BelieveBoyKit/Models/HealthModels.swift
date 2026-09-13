import Foundation

/// `GET /api/v1/health/live` —— 免鉴权存活探针。
public struct LiveStatus: Decodable, Sendable, Equatable {
    public let status: String
    public let timestamp: Double
}

/// `GET /api/v1/health` —— 需鉴权的完整性探针。
///
/// 字段与 `backend/app/api/v1/endpoints/health.py` 的 `HealthResponse` 1:1；
/// JSON 为 snake_case，由 `APIClient` 的 `.convertFromSnakeCase` 统一转换。
public struct HealthStatus: Decodable, Sendable, Equatable {
    public let status: String
    public let timestamp: Double
    public let database: String
    public let databaseReplica: String
    public let redis: String
    public let redisMemory: String?
    /// 后端 `app_env`（如 `production` / `development`）。
    public let version: String?

    /// 该字段值是否代表"正常"。后端在异常时返回 `error: …` / `unavailable` 等自由文本，
    /// 因此判定为「不含错误标记」而非「等于 ok」。
    public static func isHealthy(_ value: String) -> Bool {
        let lowered = value.lowercased()
        return !lowered.contains("error") && !lowered.contains("unavailable")
            && !lowered.contains("degraded") && !lowered.contains("breaker open")
    }

    public var isDatabaseHealthy: Bool { Self.isHealthy(database) }
    public var isReplicaHealthy: Bool { Self.isHealthy(databaseReplica) }
    public var isEmptyOrHealthyRedis: Bool {
        redis == "not configured" || Self.isHealthy(redis)
    }
}

/// 一次连接检查的完整结果。
public struct HealthSnapshot: Sendable, Equatable {
    /// 存活探针结果。`nil` = 该步失败（原因见 `liveError`）。
    public let live: LiveStatus?
    public let liveError: APIError?
    /// 完整探针结果。免鉴权场景下不请求，保持 `nil`。
    public let health: HealthStatus?
    public let healthError: APIError?
    /// 完整探针的往返耗时（毫秒）；未请求为 `nil`。
    public let healthLatencyMs: Int?

    public init(
        live: LiveStatus?,
        liveError: APIError?,
        health: HealthStatus?,
        healthError: APIError?,
        healthLatencyMs: Int?
    ) {
        self.live = live
        self.liveError = liveError
        self.health = health
        self.healthError = healthError
        self.healthLatencyMs = healthLatencyMs
    }
}
