import Foundation

/// 后端连通性探针。
///
/// 两步语义分开，因为它们的失败含义完全不同：
/// - `live` 失败 → 后端进程/网络不可达（与凭据无关）；
/// - `health` 失败 → 后端可达，但凭据或依赖（DB / 副本 / Redis）有问题。
///
/// 合并成一个"失败"会让排查方向丢失，因此保留两份错误。
public enum HealthProbe {
    /// 免鉴权存活检查。
    public static func live(using client: APIClient) async throws -> LiveStatus {
        try await client.get("/health/live", tier: .list, authenticated: false)
    }

    /// 需鉴权的完整检查。
    public static func full(using client: APIClient) async throws -> HealthStatus {
        try await client.get("/health", tier: .detail, authenticated: true)
    }

    /// 完整检查：存活探针失败不再做完整性探针（无意义且白等一个超时）。
    public static func snapshot(using client: APIClient) async -> HealthSnapshot {
        var liveStatus: LiveStatus?
        var liveError: APIError?
        do {
            liveStatus = try await live(using: client)
        } catch let error as APIError {
            liveError = error
        } catch {
            liveError = .transport(error.localizedDescription)
        }

        guard let liveStatus else {
            return HealthSnapshot(
                live: nil, liveError: liveError,
                health: nil, healthError: nil, healthLatencyMs: nil
            )
        }

        let started = DispatchTime.now()
        var healthStatus: HealthStatus?
        var healthError: APIError?
        do {
            healthStatus = try await full(using: client)
        } catch let error as APIError {
            healthError = error
        } catch {
            healthError = .transport(error.localizedDescription)
        }
        let elapsed = DispatchTime.now().uptimeNanoseconds &- started.uptimeNanoseconds

        return HealthSnapshot(
            live: liveStatus,
            liveError: nil,
            health: healthStatus,
            healthError: healthError,
            healthLatencyMs: Int(elapsed / 1_000_000)
        )
    }
}
