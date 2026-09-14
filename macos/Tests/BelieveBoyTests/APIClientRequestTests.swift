import Foundation
import XCTest

@testable import BelieveBoyKit

/// 请求构造契约：超时分层与 base URL 拼接。
///
/// 断言的是**实际发出**的请求属性（`StubURLProtocol` 记录），不是常量表 ——
/// 「表里写了 0」和「请求真的没有 60s 超时」是两回事，这里只认后者。
final class APIClientRequestTests: XCTestCase {
    private let liveBody = #"{"status":"ok","timestamp":1.0}"#

    /// `.stream` 必须真正摆脱 Foundation 的 60s 默认值：SSE / NDJSON 在数据间隙
    /// 超过 60s 会被 `timeoutInterval` 掐断，而 `URLRequest` 没有"禁用超时"开关 ——
    /// 不写该属性只会保留默认值。
    func testStreamTierRequestCarriesNoFiniteTimeout() async throws {
        let session = StubURLProtocol.session(routes: ["/api/v1/health/live": .json(200, liveBody)])
        let client = APIClient(
            baseURL: URL(string: "https://stub.invalid")!,
            apiKey: nil,
            session: session
        )

        _ = try await client.get("/health/live", tier: .stream, authenticated: false) as LiveStatus

        let recorded = try XCTUnwrap(StubURLProtocol.log.first)
        XCTAssertGreaterThan(
            recorded.timeout,
            60,
            "不显式写 timeoutInterval 会退化成 Foundation 默认的 60s"
        )
        XCTAssertEqual(recorded.timeout, RequestTier.unboundedTimeout)
    }

    /// 有限档位写自己的值，且与表一致。
    func testFiniteTiersCarryTheirDeclaredTimeout() async throws {
        for (tier, expected) in [(RequestTier.report, 60.0), (.list, 5.0)] {
            let session = StubURLProtocol.session(routes: ["/api/v1/health/live": .json(200, liveBody)])
            let client = APIClient(
                baseURL: URL(string: "https://stub.invalid")!,
                apiKey: nil,
                session: session
            )

            _ = try await client.get("/health/live", tier: tier, authenticated: false) as LiveStatus

            XCTAssertEqual(StubURLProtocol.log.first?.timeout, expected, "档位 \(tier)")
        }
    }

    /// 根地址拼出干净前缀。
    func testRootBaseURLYieldsSingleAPIPrefix() async throws {
        let session = StubURLProtocol.session(routes: ["/api/v1/health/live": .json(200, liveBody)])
        let client = APIClient(
            baseURL: URL(string: "https://stub.invalid")!,
            apiKey: nil,
            session: session
        )

        _ = try await client.get("/health/live", tier: .list, authenticated: false) as LiveStatus

        XCTAssertEqual(StubURLProtocol.log.map(\.path), ["/api/v1/health/live"])
    }

    /// 带路径前缀的 base URL 被显式拒绝，而不是拼成 `/api/api/v1/...` 静默 404。
    func testBaseURLWithPathPrefixIsRejectedWithoutIssuingRequest() async {
        for raw in ["https://proxy.example.com/api/", "https://proxy.example.com/api", "https://proxy.example.com/?tenant=1"] {
            let session = StubURLProtocol.session(routes: [:])
            let client = APIClient(
                baseURL: URL(string: raw)!,
                apiKey: "blf_test",
                session: session
            )

            do {
                _ = try await client.get("/health", tier: .detail) as HealthStatus
                XCTFail("\(raw) 应被拒绝，实际发起了请求：\(StubURLProtocol.log.map(\.path))")
            } catch let error as APIError {
                guard case .invalidBaseURL = error else {
                    return XCTFail("\(raw) 期望 .invalidBaseURL，实际 \(error)")
                }
            } catch {
                XCTFail("\(raw) 期望 APIError，实际 \(error)")
            }
            XCTAssertTrue(StubURLProtocol.log.isEmpty, "\(raw) 拒绝后不得发出任何请求")
        }
    }

    /// 路径拼接本身对 query 的排序是稳定的（回归保护，避免签名/缓存键漂移）。
    func testQueryItemsAreSortedForStableURLs() throws {
        let url = try APIClient.url(
            baseURL: URL(string: "https://stub.invalid")!,
            path: "/health",
            query: ["b": "2", "a": "1"]
        )
        XCTAssertEqual(url.path, "/api/v1/health")
        XCTAssertEqual(url.query, "a=1&b=2")
    }
}
