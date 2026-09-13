import Foundation
import XCTest

@testable import BelieveBoyKit

/// 登录链路：请求形状（方法 / 路径 / 是否带凭据）、响应解码、失败语义分类。
///
/// 断言的是**实际发出**的请求属性（`StubURLProtocol` 记录），不是常量表。
final class AuthServiceTests: XCTestCase {
    private let baseURL = URL(string: "https://stub.invalid")!

    private static func loginBody(
        apiKey: String = "blf_LOGINKEY",
        isAdmin: Bool = true,
        isActive: Bool = true,
        operatorNameZh: String? = "测试管理员",
        roleType: String = "admin"
    ) -> String {
        let operatorJSON = operatorNameZh.map { "\"\($0)\"" } ?? "null"
        return """
        {"id":"u-1","name":"测试管理员","email":"test_admin@believeboy.com",\
        "operator_name_zh":\(operatorJSON),"is_admin":\(isAdmin),"is_active":\(isActive),\
        "role_type":"\(roleType)","session_id":"sess-1","api_key":"\(apiKey)"}
        """
    }

    private func login(
        respondingWith response: StubURLProtocol.Response
    ) async throws -> AuthSession {
        let session = StubURLProtocol.session(routes: ["/api/v1/auth/login": response])
        return try await AuthService.login(
            email: "test_admin@believeboy.com",
            password: "TestAdmin123",
            baseURL: baseURL,
            session: session
        )
    }

    // MARK: - 成功路径

    func testLoginPostsJSONToAuthLoginWithoutCredentialHeaders() async throws {
        let session = StubURLProtocol.session(routes: [
            "/api/v1/auth/login": .json(200, Self.loginBody()),
        ])

        _ = try await AuthService.login(
            email: "test_admin@believeboy.com",
            password: "TestAdmin123",
            baseURL: baseURL,
            session: session
        )

        let recorded = try XCTUnwrap(StubURLProtocol.log.first)
        XCTAssertEqual(recorded.method, "POST")
        XCTAssertEqual(recorded.path, "/api/v1/auth/login", "前缀由 APIClient 统一拼接")
        XCTAssertNil(recorded.apiKey, "登录请求本身不得携带凭据 —— 此刻还没有 key")
        XCTAssertNil(recorded.header("X-Operator"), "登录时还没有身份，不得注入账号上下文")
        XCTAssertEqual(recorded.header("Content-Type"), "application/json")
        let json = try XCTUnwrap(recorded.jsonBody)
        XCTAssertEqual(json["email"], "test_admin@believeboy.com")
        XCTAssertEqual(json["password"], "TestAdmin123")
    }

    /// 邮箱首尾空白会被去掉（与后端 `payload.email.strip()` 同口径），密码原样保留
    /// —— 首尾空格可能是密码的一部分。
    func testEmailIsTrimmedButPasswordIsSentVerbatim() async throws {
        let session = StubURLProtocol.session(routes: [
            "/api/v1/auth/login": .json(200, Self.loginBody()),
        ])

        _ = try await AuthService.login(
            email: "  test_admin@believeboy.com  ",
            password: "  spaced secret  ",
            baseURL: baseURL,
            session: session
        )

        let recorded = try XCTUnwrap(StubURLProtocol.log.first)
        let json = try XCTUnwrap(recorded.jsonBody)
        XCTAssertEqual(json["email"], "test_admin@believeboy.com")
        XCTAssertEqual(json["password"], "  spaced secret  ")
    }

    func testLoginDecodesSessionFromSnakeCasePayload() async throws {
        let authSession = try await login(
            respondingWith: .json(200, Self.loginBody(apiKey: "blf_abc123"))
        )

        XCTAssertEqual(authSession.apiKey, "blf_abc123")
        let user = try XCTUnwrap(authSession.user)
        XCTAssertEqual(user.id, "u-1")
        XCTAssertEqual(user.email, "test_admin@believeboy.com")
        XCTAssertEqual(user.operatorNameZh, "测试管理员")
        XCTAssertTrue(user.isAdmin)
        XCTAssertEqual(user.roleType, "admin")
        XCTAssertEqual(user.operatorName, "测试管理员")
    }

    /// `role_type` 缺失时按后端同口径由 `is_admin` 兜底（`auth.py` 的默认值分支）。
    func testMissingRoleTypeFallsBackToIsAdmin() throws {
        let json = """
        {"id":"u-1","name":"张三","email":"a@b.com","operator_name_zh":null,\
        "is_admin":true,"is_active":true,"api_key":"blf_x"}
        """
        let decoded = try JSONDecoder.snakeCase.decode(LoginResponse.self, from: Data(json.utf8))
        let session = try AuthSession(loginResponse: decoded)
        XCTAssertEqual(session.user?.roleType, "admin")
        XCTAssertEqual(session.user?.operatorName, "张三", "中文名缺失时 X-Operator 退回账号名")
    }

    // MARK: - 失败路径

    /// 401 是「邮箱或密码错」，**不是**「请去重新登录」—— 用户正站在登录页上。
    func testInvalidCredentialsIsNotCredentialFailure() async {
        do {
            _ = try await login(respondingWith: .json(401, #"{"detail":"Invalid credentials"}"#))
            XCTFail("401 应抛错")
        } catch let error as AuthError {
            XCTAssertEqual(error, .invalidCredentials)
            XCTAssertEqual(error.displayMessage, "邮箱或密码不正确。")
        } catch {
            XCTFail("错误类型不符：\(error)")
        }
    }

    /// 账号停用与密码错分开：处置不同（一个找管理员，一个自己重试）。
    func testDisabledAccountIsDistinguishedFromWrongPassword() async {
        do {
            _ = try await login(respondingWith: .json(401, #"{"detail":"Account disabled"}"#))
            XCTFail("账号停用应抛错")
        } catch let error as AuthError {
            XCTAssertEqual(error, .accountDisabled)
            XCTAssertEqual(error.displayMessage, "账号已停用，请联系管理员。")
        } catch {
            XCTFail("错误类型不符：\(error)")
        }
    }

    func testRateLimitedLoginIsReported() async {
        do {
            _ = try await login(
                respondingWith: .json(429, #"{"detail":"Too many login attempts. Please try again later."}"#)
            )
            XCTFail("429 应抛错")
        } catch let error as AuthError {
            XCTAssertEqual(error, .rateLimited)
            XCTAssertEqual(error.displayMessage, "登录尝试过于频繁，请稍后再试。")
        } catch {
            XCTFail("错误类型不符：\(error)")
        }
    }

    /// 后端 DB 异常时会返回 200 + `api_key: ""`（`auth.py` 的 `except: rollback()`）。
    /// 把它当成功，用户会拿着空 header 去打下一个请求，故障点被推远。
    func testEmptyAPIKeyInSuccessfulResponseIsRejected() async {
        for body in [Self.loginBody(apiKey: ""), Self.loginBody(apiKey: "   ")] {
            do {
                _ = try await login(respondingWith: .json(200, body))
                XCTFail("空 api_key 不得当作登录成功：\(body)")
            } catch let error as AuthError {
                XCTAssertEqual(error, .emptyAPIKey)
                XCTAssertEqual(
                    error.displayMessage,
                    "后端未下发凭据，请联系管理员（后端数据库异常时会出现）。"
                )
            } catch {
                XCTFail("错误类型不符：\(error)")
            }
        }
    }

    /// `is_active=false` 即便带 key 也不是可用会话（后端登录已挡一道，客户端再挡一道）。
    func testInactiveAccountIsRejected() async {
        do {
            _ = try await login(respondingWith: .json(200, Self.loginBody(isActive: false)))
            XCTFail("停用账号不得建立会话")
        } catch let error as AuthError {
            XCTAssertEqual(error, .accountDisabled)
        } catch {
            XCTFail("错误类型不符：\(error)")
        }
    }

    /// 空输入在请求发出前就被挡下（省一次必然 401 的往返，也避免把空密码写进
    /// 服务端审计日志）。
    func testBlankInputFailsWithoutIssuingRequest() async {
        let session = StubURLProtocol.session(routes: [:])

        for (email, password) in [("", "pw"), ("   ", "pw"), ("a@b.com", "")] {
            do {
                _ = try await AuthService.login(
                    email: email,
                    password: password,
                    baseURL: baseURL,
                    session: session
                )
                XCTFail("空输入应抛错：\(email) / \(password)")
            } catch let error as AuthError {
                XCTAssertEqual(error, .missingInput)
            } catch {
                XCTFail("错误类型不符：\(error)")
            }
        }
        XCTAssertTrue(StubURLProtocol.log.isEmpty, "空输入不得发出任何请求")
    }

    /// 传输层失败归类到登录语义，且文案仍指向「连不上后端」而不是「密码错」。
    func testTransportFailureIsNotReportedAsWrongPassword() async {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [FailingTransportURLProtocol.self]
        let session = URLSession(configuration: configuration)

        do {
            _ = try await AuthService.login(
                email: "a@b.com",
                password: "pw",
                baseURL: baseURL,
                session: session
            )
            XCTFail("不可达应抛错")
        } catch let error as AuthError {
            XCTAssertEqual(error, .serverError(.transport("无法连接到主机")))
            XCTAssertEqual(error.displayMessage, "无法连接后端：无法连接到主机")
        } catch {
            XCTFail("错误类型不符：\(error)")
        }
    }
}

/// 模拟 DNS 解析 / 连接失败。
private final class FailingTransportURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
    }
    override func stopLoading() {}
}

extension JSONDecoder {
    /// 与 `APIClient` 同口径的解码器（单测里直接解响应体时复用）。
    static var snakeCase: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }
}
