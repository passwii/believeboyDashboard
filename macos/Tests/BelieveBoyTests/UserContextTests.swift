import Foundation
import XCTest

@testable import BelieveBoyKit

/// 账号上下文注入：`X-Operator` / `X-User-Id` / `X-Is-Admin`。
///
/// 这三项决定后端按「谁」过滤数据（`/api/v1/projects/manage` 之类依赖
/// `X-Operator`）。发错了不是报错，而是**静默返回别人的或空的数据** —— 所以必须
/// 断言真实请求头，而不是断言某个常量的值。
final class UserContextTests: XCTestCase {
    private let baseURL = URL(string: "https://stub.invalid")!
    private let healthBody = """
    {"status":"ok","timestamp":1,"database":"ok","database_replica":"not configured",\
    "redis":"ok","redis_memory":"2M","version":"development"}
    """

    private func client(for user: AuthenticatedUser?) -> APIClient {
        APIClient(
            baseURL: baseURL,
            apiKey: "blf_test",
            userContext: user.map(UserContext.from),
            session: StubURLProtocol.session(routes: ["/api/v1/health": .json(200, healthBody)])
        )
    }

    func testAuthenticatedRequestCarriesOperatorIdentityAndAdminFlag() async throws {
        _ = try await HealthProbe.full(using: client(for: .fixtureAdmin))

        let recorded = try XCTUnwrap(StubURLProtocol.log.first)
        XCTAssertEqual(
            recorded.header("X-Operator"),
            "%E6%B5%8B%E8%AF%95%E7%AE%A1%E7%90%86%E5%91%98",
            "中文名必须 percent-encode：HTTP 头值只能是 ASCII"
        )
        XCTAssertEqual(recorded.header("X-User-Id"), AuthenticatedUser.fixtureAdmin.id)
        XCTAssertEqual(recorded.header("X-Is-Admin"), "true")
        XCTAssertEqual(recorded.apiKey, "blf_test")
    }

    func testNonAdminSendsExplicitFalse() async throws {
        _ = try await HealthProbe.full(using: client(for: .fixtureOperator))

        let recorded = try XCTUnwrap(StubURLProtocol.log.first)
        XCTAssertEqual(recorded.header("X-Is-Admin"), "false")
        XCTAssertEqual(recorded.header("X-Operator"), "%E6%9D%8E%E5%9B%9B")
        XCTAssertEqual(recorded.header("X-User-Id"), AuthenticatedUser.fixtureOperator.id)
    }

    /// 环境变量凭据 / 主 key 场景没有账号档案：不发账号上下文，而不是发空值
    /// （空 `X-Operator` 会让后端把操作员匹配到空字符串上）。
    func testNoUserMeansNoIdentityHeaders() async throws {
        _ = try await HealthProbe.full(using: client(for: nil))

        let recorded = try XCTUnwrap(StubURLProtocol.log.first)
        XCTAssertNil(recorded.header("X-Operator"))
        XCTAssertNil(recorded.header("X-User-Id"))
        XCTAssertNil(recorded.header("X-Is-Admin"))
    }

    /// 免鉴权探针不得带账号上下文 / 凭据（S1 契约，S2 加了上下文后要复验）。
    func testUnauthenticatedRequestCarriesNeitherCredentialNorContext() async throws {
        let client = APIClient(
            baseURL: baseURL,
            apiKey: "blf_test",
            userContext: UserContext.from(.fixtureAdmin),
            session: StubURLProtocol.session(routes: ["/api/v1/health/live": .json(200, #"{"status":"ok","timestamp":1}"#)])
        )

        _ = try await HealthProbe.live(using: client)

        let recorded = try XCTUnwrap(StubURLProtocol.log.first)
        XCTAssertNil(recorded.apiKey)
        XCTAssertNil(recorded.header("X-Operator"))
        XCTAssertNil(recorded.header("X-User-Id"))
        XCTAssertNil(recorded.header("X-Is-Admin"))
    }

    // MARK: - 编码

    /// `encodeURIComponent` 等价性：后端 `_decode_header_value` 先试 base64、失败后
    /// `unquote`，所以发出去的必须是「标准 percent-encoding」，且 `%` 必须出现
    /// （否则 base64 分支可能先命中并解出乱码）。
    func testOperatorNameEncodingMatchesEncodeURIComponent() {
        XCTAssertEqual("张三".percentEncodedForHTTPHeaderValue, "%E5%BC%A0%E4%B8%89")
        XCTAssertEqual(
            "测试用户A".percentEncodedForHTTPHeaderValue,
            "%E6%B5%8B%E8%AF%95%E7%94%A8%E6%88%B7A"
        )
        // 未保留字符集与 encodeURIComponent 一致（不转义 - _ . ! ~ * ' ( )）
        XCTAssertEqual(
            "a-b_c.d!e~f*g'h(i)".percentEncodedForHTTPHeaderValue,
            "a-b_c.d!e~f*g'h(i)"
        )
        // 保留字符必须转义
        XCTAssertEqual(
            "a b+c&d=e/f?g#h".percentEncodedForHTTPHeaderValue,
            "a%20b%2Bc%26d%3De%2Ff%3Fg%23h"
        )
        XCTAssertEqual("".percentEncodedForHTTPHeaderValue, "")
    }

    /// 纯 ASCII 名字原样透传（不引入无谓的编码）。
    func testAsciiOperatorNameIsPassedThrough() {
        let context = UserContext(operatorName: "alice", userId: "7", isAdmin: false)
        XCTAssertEqual(context.headers["X-Operator"], "alice")
        XCTAssertEqual(context.headers["X-User-Id"], "7")
        XCTAssertEqual(context.headers["X-Is-Admin"], "false")
    }
}
