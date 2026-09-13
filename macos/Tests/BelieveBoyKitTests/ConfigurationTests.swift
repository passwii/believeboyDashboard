import Foundation
import XCTest

@testable import BelieveBoyKit

/// 配置解析与健康判定的边界 —— UI 的绿/红判定完全建立在它们之上。
final class ConfigurationTests: XCTestCase {
    func testEnvironmentVariableOverridesWinAndBlankValuesFallBack() {
        let resolved = AppConfig.resolved(
            baseURL: AppConfig.Environment.production.baseURL,
            apiKey: "blf_from_call",
            environment: [
                "BELIEVEBOY_BASE_URL": "  http://127.0.0.1:8100  ",
                "BELIEVEBOY_API_KEY": "   ",
            ]
        )

        XCTAssertEqual(resolved.baseURL, AppConfig.Environment.local.baseURL)
        XCTAssertEqual(resolved.apiKey, "blf_from_call", "全空白的环境变量不得覆盖已有凭据")
    }

    func testUnknownBaseURLHasNoEnvironmentMatch() {
        XCTAssertEqual(AppConfig.Environment.matching(AppConfig.Environment.production.baseURL), .production)
        XCTAssertEqual(AppConfig.Environment.matching(AppConfig.Environment.local.baseURL), .local)
        XCTAssertNil(AppConfig.Environment.matching(URL(string: "https://dash-api.example.com")!))
    }

    func testProductionEnvironmentTargetsPublicAPI() {
        XCTAssertEqual(
            AppConfig.defaultBaseURL.absoluteString,
            "https://dash-api.believeboy.com",
            "桌面端直连生产后端，不经 Next.js 代理"
        )
    }

    func testHealthValueClassificationTreatsFreeTextErrorsAsUnhealthy() {
        XCTAssertTrue(HealthStatus.isHealthy("ok"))
        XCTAssertTrue(HealthStatus.isHealthy("ok (0.9ms)"))
        XCTAssertTrue(HealthStatus.isHealthy("not configured"), "未配置的副本仍算正常")
        XCTAssertFalse(HealthStatus.isHealthy("error: connection refused"))
        XCTAssertFalse(HealthStatus.isHealthy("unavailable"))
        XCTAssertFalse(HealthStatus.isHealthy("degraded"))
        XCTAssertFalse(HealthStatus.isHealthy("breaker open"))
    }

    func testRedisRowAcceptsExplicitNotConfiguredButRejectsErrors() {
        XCTAssertTrue(status(redis: "ok (0.9ms)").isEmptyOrHealthyRedis)
        XCTAssertTrue(status(redis: "not configured").isEmptyOrHealthyRedis)
        XCTAssertFalse(status(redis: "error: refused").isEmptyOrHealthyRedis)
    }

    func testReplicaRowTreatsNotConfiguredAsHealthy() {
        let snapshot = status(database: "ok", replica: "not configured")
        XCTAssertTrue(snapshot.isDatabaseHealthy)
        XCTAssertTrue(snapshot.isReplicaHealthy)
        XCTAssertFalse(status(replica: "error: refused").isReplicaHealthy)
    }

    private func status(
        database: String = "ok",
        replica: String = "not configured",
        redis: String = "ok (0.9ms)"
    ) -> HealthStatus {
        HealthStatus(
            status: "ok",
            timestamp: 1,
            database: database,
            databaseReplica: replica,
            redis: redis,
            redisMemory: "2.07M",
            version: "development"
        )
    }
}
