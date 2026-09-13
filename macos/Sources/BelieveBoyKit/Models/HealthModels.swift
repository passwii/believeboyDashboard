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

    /// `redis_memory` 是否为可信读数。后端在 `INFO memory` 失败时写 `unavailable`、
    /// 取不到字段时写 `unknown` —— 两者都只是「没读到」，不能当作绿色。
    /// `nil`（未配置 Redis，后端不返回该字段）不算异常，故不在此判定内。
    public var isRedisMemoryUsable: Bool {
        guard let redisMemory else { return false }
        return Self.isHealthy(redisMemory) && redisMemory.lowercased() != "unknown"
    }

    /// 全部明细依赖是否健康。明细行与总体行共用这套判定，避免两处口径漂移。
    public var hasHealthyDependencies: Bool {
        isDatabaseHealthy && isReplicaHealthy && isEmptyOrHealthyRedis
            && (redisMemory == nil || isRedisMemoryUsable)
    }

    /// 总体是否健康 —— UI 的绿勾判定。
    ///
    /// 以 `status` 为权威，而不是「拿到了响应就算健康」：后端在主库/副本异常时仍返回
    /// HTTP 200 + `status: "degraded"`（`backend/app/api/v1/endpoints/health.py`），
    /// 只看响应是否有值会把降级显示成绿勾。同时叠加逐项判定 —— 后端 overall 只看主库
    /// 与副本，Redis / 内存读数异常时 `status` 仍是 `ok`，只看 `status` 就会出现
    /// 「总体绿灯 + 明细红灯」的自相矛盾。
    public var isOverallHealthy: Bool {
        Self.isHealthy(status) && hasHealthyDependencies
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
