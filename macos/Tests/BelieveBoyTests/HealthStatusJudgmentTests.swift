import Foundation
import XCTest

@testable import BelieveBoyKit

/// 总体健康判定 —— UI 绿勾/红叉完全建立在这一个属性上。
///
/// 后端在主库或副本异常时**仍返回 HTTP 200**（`backend/app/api/v1/endpoints/health.py`
/// 的 `overall = "degraded"` 分支），所以"拿到响应"不等于"健康"。
final class HealthStatusJudgmentTests: XCTestCase {
    private let baseURL = URL(string: "https://stub.invalid")!

    private func health(from json: String) async throws -> HealthStatus {
        let session = StubURLProtocol.session(routes: ["/api/v1/health": .json(200, json)])
        let client = APIClient(baseURL: baseURL, apiKey: "blf_test", session: session)
        return try await HealthProbe.full(using: client)
    }

    /// 主库异常时后端返回 `status: "degraded"` + HTTP 200：总体必须是**不健康**。
    func testDegradedPrimaryDatabaseIsOverallUnhealthyDespiteHTTP200() async throws {
        let health = try await health(
            from: """
            {"status":"degraded","timestamp":1.0,"database":"error: OperationalError",\
            "database_replica":"ok (lag 0.4s)","redis":"ok (1.2ms)","redis_memory":"2.07M",\
            "version":"production"}
            """
        )

        XCTAssertEqual(health.database, "error: OperationalError")
        XCTAssertFalse(health.isDatabaseHealthy)
        XCTAssertFalse(health.isOverallHealthy, "HTTP 200 + status=degraded 不得显示为绿勾")
    }

    /// 副本降级同样进总体判定。
    func testDegradedReplicaIsOverallUnhealthy() async throws {
        let health = try await health(
            from: """
            {"status":"degraded","timestamp":1.0,"database":"ok",\
            "database_replica":"degraded (lag 12.0s)","redis":"ok (1.2ms)","redis_memory":"2.07M",\
            "version":"production"}
            """
        )

        XCTAssertFalse(health.isReplicaHealthy)
        XCTAssertFalse(health.isOverallHealthy)
    }

    /// 后端 overall 只看主库与副本，Redis 内存读数失败时 `status` 仍是 `ok` ——
    /// 若只信 `status`，就会出现"总体绿灯 + 明细红灯"的自相矛盾。
    func testUnavailableRedisMemoryIsOverallUnhealthyEvenWhenStatusSaysOk() async throws {
        let health = try await health(
            from: """
            {"status":"ok","timestamp":1.0,"database":"ok","database_replica":"not configured",\
            "redis":"ok (1.2ms)","redis_memory":"unavailable","version":"production"}
            """
        )

        XCTAssertEqual(health.status, "ok")
        XCTAssertTrue(health.isEmptyOrHealthyRedis, "Redis 本身心跳正常")
        XCTAssertFalse(health.isRedisMemoryUsable)
        XCTAssertFalse(health.isOverallHealthy, "内存读不到就不能算全绿")
    }

    /// 未配置 Redis（`not configured` + `redis_memory: null`）是正常状态，不得拖红。
    func testUnconfiguredRedisStaysHealthy() async throws {
        let health = try await health(
            from: """
            {"status":"ok","timestamp":1.0,"database":"ok","database_replica":"not configured",\
            "redis":"not configured","redis_memory":null,"version":"production"}
            """
        )

        XCTAssertTrue(health.isOverallHealthy)
    }

    /// Redis 心跳错误（`unavailable`）时后端仍可能报 ok。
    func testErrorRedisIsOverallUnhealthy() async throws {
        let health = try await health(
            from: """
            {"status":"ok","timestamp":1.0,"database":"ok","database_replica":"not configured",\
            "redis":"error: ConnectionError","redis_memory":"unavailable","version":"production"}
            """
        )

        XCTAssertFalse(health.isEmptyOrHealthyRedis)
        XCTAssertFalse(health.isOverallHealthy)
    }

    /// 全绿样本（防"永远不健康"的过度矫正）。
    func testFullyHealthyPayloadIsOverallHealthy() async throws {
        let health = try await health(
            from: """
            {"status":"ok","timestamp":1.0,"database":"ok","database_replica":"ok (lag 0.4s)",\
            "redis":"ok (1.2ms)","redis_memory":"2.07M","version":"production"}
            """
        )

        XCTAssertTrue(health.isOverallHealthy)
    }

    /// `status` 是权威字段：明细都正常但后端自报 degraded，也按不健康处理。
    func testStatusFieldAloneCanDriveOverallToUnhealthy() {
        let health = HealthStatus(
            status: "degraded",
            timestamp: 1,
            database: "ok",
            databaseReplica: "ok",
            redis: "ok (1.2ms)",
            redisMemory: "2.07M",
            version: "production"
        )

        XCTAssertFalse(health.isOverallHealthy)
    }

    /// `unknown` 只是"取不到字段"，不是错误，但也不足以当绿色读数。
    func testUnknownRedisMemoryIsNotUsable() {
        let health = HealthStatus(
            status: "ok",
            timestamp: 1,
            database: "ok",
            databaseReplica: "ok",
            redis: "ok (1.2ms)",
            redisMemory: "unknown",
            version: "production"
        )

        XCTAssertFalse(health.isRedisMemoryUsable)
        XCTAssertFalse(health.isOverallHealthy)
    }
}
