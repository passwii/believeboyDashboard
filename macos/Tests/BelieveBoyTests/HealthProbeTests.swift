import Foundation
import XCTest

import BelieveBoyKit

/// 健康探针的两步语义与鉴权头契约 —— 这些是 UI 判断「网络问题还是凭据问题」的依据。
final class HealthProbeTests: XCTestCase {
    private let baseURL = URL(string: "https://stub.invalid")!

    private func client(_ session: URLSession, apiKey: String? = "blf_test") -> APIClient {
        APIClient(baseURL: baseURL, apiKey: apiKey, session: session)
    }

    func testSnapshotDecodesSnakeCasePayloadAndAttachesKeyOnlyToAuthenticatedProbe() async throws {
        let session = StubURLProtocol.session(routes: [
            "/api/v1/health/live": .json(200, #"{"status":"ok","timestamp":1789295079.8}"#),
            "/api/v1/health": .json(
                200,
                #"{"status":"ok","timestamp":1789295079.8,"database":"ok","database_replica":"not configured","redis":"ok (0.9ms)","redis_memory":"2.07M","version":"development"}"#
            ),
        ])

        let snapshot = await HealthProbe.snapshot(using: client(session))

        let health = try XCTUnwrap(snapshot.health)
        XCTAssertEqual(snapshot.live?.status, "ok")
        XCTAssertNil(snapshot.liveError)
        XCTAssertNil(snapshot.healthError)
        XCTAssertEqual(health.database, "ok")
        XCTAssertEqual(health.databaseReplica, "not configured")
        XCTAssertEqual(health.redis, "ok (0.9ms)")
        XCTAssertEqual(health.redisMemory, "2.07M")
        XCTAssertEqual(health.version, "development")
        XCTAssertNotNil(snapshot.healthLatencyMs)

        // 前缀拼接与鉴权头归属：免鉴权探针不得带 key，完整探针必须带。
        let log = StubURLProtocol.log
        XCTAssertEqual(log.map(\.path), ["/api/v1/health/live", "/api/v1/health"])
        XCTAssertNil(log[0].apiKey)
        XCTAssertEqual(log[1].apiKey, "blf_test")
    }

    func testLiveFailureShortCircuitsBeforeAuthenticatedProbe() async {
        let session = StubURLProtocol.session(routes: [
            "/api/v1/health/live": .json(500, #"{"detail":"boom"}"#),
        ])

        let snapshot = await HealthProbe.snapshot(using: client(session))

        XCTAssertNil(snapshot.live)
        XCTAssertNil(snapshot.health, "存活探针失败后不应再请求 /health")
        XCTAssertNil(snapshot.healthLatencyMs)
        XCTAssertEqual(snapshot.liveError, .http(status: 500, body: #"{"detail":"boom"}"#))
        XCTAssertNil(snapshot.healthError)
        XCTAssertEqual(StubURLProtocol.log.map(\.path), ["/api/v1/health/live"])
    }

    func testMissingCredentialFailsWithoutIssuingRequest() async {
        let session = StubURLProtocol.session(routes: [:])

        do {
            _ = try await HealthProbe.full(using: client(session, apiKey: nil))
            XCTFail("缺凭据应抛错")
        } catch let error as APIError {
            XCTAssertEqual(error, .missingCredential)
            XCTAssertTrue(error.requiresCredentialFix)
            XCTAssertEqual(error.displayMessage, "缺少 API key，请先在设置中填写。")
        } catch {
            XCTFail("错误类型不符：\(error)")
        }
        XCTAssertTrue(StubURLProtocol.log.isEmpty, "缺凭据时不得发出请求")
    }

    func testUnauthorizedResponseMapsToCredentialFixSignal() async {
        let body = #"{"detail":"Invalid API key"}"#
        let session = StubURLProtocol.session(routes: [
            "/api/v1/health/live": .json(200, #"{"status":"ok","timestamp":1}"#),
            "/api/v1/health": .json(403, body),
        ])

        let snapshot = await HealthProbe.snapshot(using: client(session, apiKey: "blf_revoked"))

        XCTAssertNotNil(snapshot.live)
        XCTAssertNil(snapshot.health)
        XCTAssertEqual(snapshot.healthError, .unauthorized(status: 403, body: body))
        XCTAssertEqual(
            snapshot.healthError?.requiresCredentialFix,
            true,
            "key 被拒（含登录轮换导致失效）必须提示重新登录或改 key，而不是静默失败"
        )
    }

    func testUnreachableHostIsTransportFailureNotCredentialFailure() async {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FailingURLProtocol.self]

        let snapshot = await HealthProbe.snapshot(
            using: client(URLSession(configuration: configuration))
        )

        XCTAssertNil(snapshot.live)
        XCTAssertNil(snapshot.health)
        XCTAssertEqual(snapshot.liveError, .transport("无法连接到主机"))
        XCTAssertEqual(snapshot.liveError?.requiresCredentialFix, false)
    }
}

/// 模拟 DNS 解析 / 连接失败。
private final class FailingURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
    }
    override func stopLoading() {}
}
