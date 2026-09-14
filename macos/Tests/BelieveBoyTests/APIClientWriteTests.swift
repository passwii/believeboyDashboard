import Foundation
import XCTest

@testable import BelieveBoyKit

/// JSON 写入（POST / PUT / PATCH / DELETE）的请求契约。
///
/// 断言的是**实际发出**的请求属性（`StubURLProtocol` 记录），不是常量表：
/// 「方法常量写对了」和「请求真的用了 PUT」是两回事。
final class APIClientWriteTests: XCTestCase {
    private let baseURL = URL(string: "https://stub.invalid")!

    private struct Payload: Encodable, Sendable {
        let name: String
        let count: Int
    }

    private struct Reply: Decodable, Sendable, Equatable {
        let ok: Bool
        let id: Int?
    }

    private func client(apiKey: String? = "blf_test", session: URLSession) -> APIClient {
        APIClient(baseURL: baseURL, apiKey: apiKey, session: session)
    }

    // MARK: - 带请求体

    func testPutSendsJSONBodyWithCredentialAndDecodesReply() async throws {
        let session = StubURLProtocol.session(routes: [
            "/api/v1/inspections/periods/9": .json(200, #"{"ok":true,"id":9}"#),
        ])

        let reply: Reply = try await client(session: session).put(
            "/inspections/periods/9",
            body: Payload(name: "第二周巡检", count: 3)
        )

        XCTAssertEqual(reply, Reply(ok: true, id: 9))
        let recorded = try XCTUnwrap(StubURLProtocol.log.first)
        XCTAssertEqual(recorded.method, "PUT")
        XCTAssertEqual(recorded.path, "/api/v1/inspections/periods/9")
        XCTAssertEqual(recorded.header("Content-Type"), "application/json")
        XCTAssertEqual(recorded.apiKey, "blf_test")
        XCTAssertEqual(recorded.timeout, RequestTier.detail.timeout, "写操作默认走详情档（10s）")
        let json = try XCTUnwrap(recorded.jsonObject)
        XCTAssertEqual(json["name"] as? String, "第二周巡检")
        XCTAssertEqual(json["count"] as? Int, 3, "数字按 JSON 数字发出，而不是字符串 '3'")
    }

    func testPatchUsesPatchMethodAndKeepsQuerySorted() async throws {
        let session = StubURLProtocol.session(routes: [
            "/api/v1/projects/manage": .json(200, #"{"ok":true,"id":1}"#),
        ])

        let _: Reply = try await client(session: session).write(
            .patch,
            "/projects/manage",
            body: Payload(name: "x", count: 1),
            query: ["b": "2", "a": "1"]
        )

        let recorded = try XCTUnwrap(StubURLProtocol.log.first)
        XCTAssertEqual(recorded.method, "PATCH")
        XCTAssertEqual(
            recorded.headers.keys.contains("Content-Type"),
            true,
            "有请求体就必须声明 Content-Type"
        )
    }

    // MARK: - 无请求体

    func testDeleteWithoutBodySendsNeitherContentTypeNorBody() async throws {
        let session = StubURLProtocol.session(routes: [
            "/api/v1/sku-info/42": .json(200, #"{"ok":true,"id":42}"#),
        ])

        let reply: Reply = try await client(session: session).delete("/sku-info/42")

        XCTAssertEqual(reply.id, 42)
        let recorded = try XCTUnwrap(StubURLProtocol.log.first)
        XCTAssertEqual(recorded.method, "DELETE")
        XCTAssertNil(recorded.header("Content-Type"), "无请求体不得声称 Content-Type")
        XCTAssertNil(recorded.body, "无请求体不得带体")
        XCTAssertEqual(recorded.apiKey, "blf_test")
    }

    // MARK: - 忽略响应体

    func testWriteIgnoringResponseAccepts204WithEmptyBody() async throws {
        let session = StubURLProtocol.session(routes: [
            "/api/v1/crm/follow-ups/5": .json(204, ""),
        ])

        try await client(session: session).deleteIgnoringResponse("/crm/follow-ups/5")

        XCTAssertEqual(StubURLProtocol.callCount("/api/v1/crm/follow-ups/5"), 1)
    }

    func testWriteIgnoringResponseAccepts200WithBodyAndDoesNotDecodeIt() async throws {
        let session = StubURLProtocol.session(routes: [
            "/api/v1/crm/follow-ups/5": .json(200, #"{"ok":true}"#),
        ])

        // 不解码：即便响应体形状与任何模型都不匹配，也不该失败。
        try await client(session: session).writeIgnoringResponse(
            .put,
            "/crm/follow-ups/5",
            body: Payload(name: "跟进", count: 2)
        )

        XCTAssertEqual(StubURLProtocol.callCount("/api/v1/crm/follow-ups/5"), 1)
    }

    func testWriteIgnoringResponseStillFailsOnNonSuccessStatus() async {
        let session = StubURLProtocol.session(routes: [
            "/api/v1/crm/follow-ups/5": .json(500, #"{"detail":"boom"}"#),
        ])

        do {
            try await client(session: session).deleteIgnoringResponse("/crm/follow-ups/5")
            XCTFail("500 必须抛错")
        } catch let error as APIError {
            guard case .http(let status, let body) = error else {
                return XCTFail("期望 .http，实际 \(error)")
            }
            XCTAssertEqual(status, 500)
            XCTAssertTrue(body.contains("boom"), "错误体要原样带出来，便于定位")
        } catch {
            XCTFail("期望 APIError，实际 \(error)")
        }
    }

    // MARK: - 错误分类（验收标准 5）

    func testWriteAuthFailureIsCredentialProblem() async {
        for status in [401, 403] {
            let session = StubURLProtocol.session(routes: [
                "/api/v1/crm/follow-ups/5": .json(status, #"{"detail":"Invalid API key"}"#),
            ])

            do {
                try await client(session: session).deleteIgnoringResponse("/crm/follow-ups/5")
                XCTFail("HTTP \(status) 必须抛错")
            } catch let error as APIError {
                XCTAssertEqual(error, .unauthorized(status: status, body: #"{"detail":"Invalid API key"}"#))
                XCTAssertTrue(error.requiresCredentialFix, "401/403 必须导向重新登录（§4.1.1 的 403 主路径）")
            } catch {
                XCTFail("期望 APIError，实际 \(error)")
            }
        }
    }

    /// 传输层失败（DNS / 超时 / 连接被拒）**不是**凭据问题：不得让用户重登。
    func testTransportFailureIsNotCredentialProblem() async {
        let session = StubURLProtocol.session(routes: [
            "/api/v1/crm/follow-ups/5": StubURLProtocol.Response(
                status: 0,
                body: "",
                failure: URLError(.cannotConnectToHost)
            ),
        ])

        do {
            try await client(session: session).deleteIgnoringResponse("/crm/follow-ups/5")
            XCTFail("传输失败必须抛错")
        } catch let error as APIError {
            guard case .transport(let detail) = error else {
                return XCTFail("期望 .transport，实际 \(error)")
            }
            XCTAssertEqual(detail, "无法连接到主机")
            XCTAssertFalse(error.requiresCredentialFix, "传输失败不是凭据问题，不能把用户赶回登录页")
        } catch {
            XCTFail("期望 APIError，实际 \(error)")
        }
    }

    func testWriteWithoutCredentialFailsBeforeSendingRequest() async {
        let session = StubURLProtocol.session(routes: [:])

        do {
            let _: Reply = try await client(apiKey: nil, session: session).delete("/sku-info/42")
            XCTFail("无凭据必须抛错")
        } catch let error as APIError {
            XCTAssertEqual(error, .missingCredential)
            XCTAssertTrue(error.requiresCredentialFix)
        } catch {
            XCTFail("期望 APIError，实际 \(error)")
        }
        XCTAssertTrue(StubURLProtocol.log.isEmpty, "缺凭据应在发出请求前拦截")
    }

    func testWriteSurfacesDecodingMismatchAsDecodingError() async {
        let session = StubURLProtocol.session(routes: [
            "/api/v1/sku-info/42": .json(200, #"{"unexpected":1}"#),
        ])

        do {
            let _: Reply = try await client(session: session).delete("/sku-info/42")
            XCTFail("形状不匹配必须抛错")
        } catch let error as APIError {
            guard case .decoding = error else {
                return XCTFail("期望 .decoding，实际 \(error)")
            }
            XCTAssertFalse(error.requiresCredentialFix)
        } catch {
            XCTFail("期望 APIError，实际 \(error)")
        }
    }
}
