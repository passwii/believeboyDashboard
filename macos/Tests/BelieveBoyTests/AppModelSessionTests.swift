import BelieveBoyKit
import Foundation
import XCTest

@testable import BelieveBoyUI

/// 登录态状态机 —— 验收 1/2/3/4 的直接证据。
///
/// 打桩在**网络层**（`URLProtocol`），会话存储用内存实现，因此这里验证的是
/// 「一次真实请求回来后，界面状态怎么走」，而不是对某个 mock 的调用次数。
@MainActor
final class AppModelSessionTests: XCTestCase {
    // 静态夹具必须 `nonisolated`：类的 `@MainActor` 会把静态成员一并隔离，
    // 而它们要被 `@Sendable` 的桩件闭包使用（那个闭包不在主 actor 上）。
    private nonisolated static let liveBody = #"{"status":"ok","timestamp":1}"#
    private nonisolated static let healthBody = """
    {"status":"ok","timestamp":1.0,"database":"ok","database_replica":"not configured",\
    "redis":"ok (1.2ms)","redis_memory":"2.07M","version":"production"}
    """

    private nonisolated static func loginBody(apiKey: String) -> String {
        """
        {"id":"u-1","name":"测试管理员","email":"test_admin@believeboy.com",\
        "operator_name_zh":"测试管理员","is_admin":true,"is_active":true,\
        "role_type":"admin","session_id":"sess-1","api_key":"\(apiKey)"}
        """
    }

    private let baseURL = URL(string: "https://stub.invalid")!

    /// 与真实后端同构的桩件：**凭据的有效性由 key 本身决定**，而不是第几次调用
    /// （`blf_STALE` 已被同账号的另一次登录覆写 → 永远 403）。这样「旧 key 失效」
    /// 的用例不依赖调用顺序，也就不靠打桩脚本的自觉。
    private func rotationSession(
        staleKeys: Set<String> = ["blf_STALE", "blf_ENV_STALE"]
    ) -> URLSession {
        StubURLProtocol.session { request in
            let path = request.url?.path ?? ""
            let key = request.value(forHTTPHeaderField: "X-API-Key")
            switch path {
            case "/api/v1/auth/login":
                return .json(200, Self.loginBody(apiKey: "blf_FROM_LOGIN"))
            case "/api/v1/health/live":
                return .json(200, Self.liveBody)
            case "/api/v1/health":
                guard let key, !staleKeys.contains(key) else {
                    return .json(403, #"{"detail":"Invalid API key"}"#)
                }
                return .json(200, Self.healthBody)
            default:
                XCTFail("未登记的请求路径：\(path)")
                return .json(500, "stub: unregistered \(path)")
            }
        }
    }

    private func makeModel(
        store: InMemorySessionStore = InMemorySessionStore(),
        session: URLSession,
        processEnvironment: [String: String] = [:]
    ) -> AppModel {
        AppModel(
            sessionStore: store,
            processEnvironment: processEnvironment,
            urlSession: session
        )
    }

    private func fillCredentials(_ model: AppModel) {
        model.emailDraft = "test_admin@believeboy.com"
        model.passwordDraft = "TestAdmin123"
    }

    // MARK: - 验收 1：冷启动凭据有效 → 直进主界面，不闪登录页

    /// 「不闪登录页」的可断言形式：**构造完成时（同步）就已经是 `.signedIn`**，
    /// 且恢复登录态没有产生任何网络往返。若把恢复改成异步，这条会先失败 ——
    /// 那时用户就会先看到一帧登录页。
    func testColdStartWithStoredSessionIsSignedInWithoutLoginFlash() throws {
        let store = InMemorySessionStore()
        try store.saveSession(AuthSession(apiKey: "blf_STORED", user: .fixtureAdmin))

        let model = makeModel(store: store, session: rotationSession())

        XCTAssertEqual(model.sessionState.session?.apiKey, "blf_STORED")
        XCTAssertFalse(model.sessionState.isSignedOut, "有效凭据不得先渲染登录页")
        XCTAssertEqual(model.currentUser?.email, "test_admin@believeboy.com")
        XCTAssertEqual(model.displayName, "测试管理员")
        XCTAssertTrue(StubURLProtocol.log.isEmpty, "恢复登录态是本地读钥匙串，不应有网络往返")
    }

    func testColdStartWithoutAnyCredentialRequiresLogin() {
        let model = makeModel(session: rotationSession())

        XCTAssertTrue(model.sessionState.isSignedOut)
        XCTAssertNil(model.sessionState.signedOutReason, "首次启动没有「为什么回到登录页」可讲")
        XCTAssertNil(model.currentUser)
    }

    /// 环境变量凭据（开发 / CI）能直进主界面，但没有账号档案。
    func testEnvironmentCredentialSignsInWithoutUserContext() {
        let model = makeModel(
            session: rotationSession(),
            processEnvironment: ["BELIEVEBOY_API_KEY": "blf_ENV"]
        )

        XCTAssertEqual(model.sessionState.session?.apiKey, "blf_ENV")
        XCTAssertNil(model.currentUser)
        XCTAssertEqual(model.displayName, "环境变量凭据")
    }

    /// 钥匙串读失败（被锁 / 权限被拒）与「没配 key」是两件事，必须说清原因，
    /// 否则用户会反复重登却每次都回到登录页。
    func testKeychainReadFailureExplainsItselfOnLoginPage() {
        let store = InMemorySessionStore()
        store.failLoading(
            with: CredentialStoreError.keychain(status: -25308, message: "User interaction is not allowed.")
        )

        let model = makeModel(store: store, session: rotationSession())

        XCTAssertTrue(model.sessionState.isSignedOut)
        XCTAssertEqual(
            model.sessionState.signedOutReason,
            "读取钥匙串失败：钥匙串操作失败（OSStatus -25308）：User interaction is not allowed."
        )
    }

    // MARK: - 验收 4：登录成功入库 / 401

    func testSuccessfulLoginPersistsSessionAndEntersMainView() async throws {
        let store = InMemorySessionStore()
        let model = makeModel(store: store, session: rotationSession())
        fillCredentials(model)

        await model.signIn()

        XCTAssertEqual(store.session?.apiKey, "blf_FROM_LOGIN", "登录拿到的 key 必须入库")
        XCTAssertEqual(store.session?.user?.isAdmin, true)
        XCTAssertEqual(model.sessionState.session?.apiKey, "blf_FROM_LOGIN")
        XCTAssertNil(model.loginError)
        XCTAssertEqual(model.passwordDraft, "", "密码用完即清")

        let login = try XCTUnwrap(StubURLProtocol.log.first { $0.path == "/api/v1/auth/login" })
        XCTAssertEqual(login.method, "POST")
        XCTAssertNil(login.apiKey)
        XCTAssertEqual(login.jsonBody?["email"], "test_admin@believeboy.com")

        // 登录后立刻带新凭据发一次探测（用户不必再手点一下）。
        XCTAssertEqual(model.phase.snapshot?.health?.isOverallHealthy, true)
    }

    func testWrongPasswordKeepsUserOnLoginPageWithMessage() async {
        let store = InMemorySessionStore()
        let session = StubURLProtocol.session(routes: [
            "/api/v1/auth/login": .json(401, #"{"detail":"Invalid credentials"}"#),
        ])
        let model = makeModel(store: store, session: session)
        fillCredentials(model)

        await model.signIn()

        XCTAssertTrue(model.sessionState.isSignedOut, "登录失败必须留在登录页")
        XCTAssertEqual(model.loginError, "邮箱或密码不正确。")
        XCTAssertNil(store.session, "失败登录不得写入任何凭据")
        XCTAssertEqual(model.passwordDraft, "", "密码不得留在草稿里")
        XCTAssertFalse(model.isSigningIn)
    }

    /// 钥匙串写失败**不阻断**本次登录（key 在内存里可用），但必须告知重启后需重登 ——
    /// 静默失败会让「登录态保持」变成偶发 bug。
    func testSessionPersistenceFailureIsReportedButDoesNotBlockSignIn() async {
        let store = InMemorySessionStore()
        store.failSaving(
            with: CredentialStoreError.keychain(status: -25308, message: "User interaction is not allowed.")
        )
        let model = makeModel(store: store, session: rotationSession())
        fillCredentials(model)

        await model.signIn()

        XCTAssertTrue(model.isSignedIn, "写钥匙串失败不应阻断本次登录")
        XCTAssertNotNil(model.sessionNotice)
        XCTAssertTrue(
            model.sessionNotice?.contains("重启后需重新登录") == true,
            "必须明说后果，否则用户以为已经登好了：\(model.sessionNotice ?? "nil")"
        )
        XCTAssertNil(store.session)
    }

    // MARK: - 验收 3：密码不落盘

    /// 落盘的东西只有两样：账号档案 JSON 与那把 key。密码不得出现在其中任何一处。
    func testPasswordIsNeverPersisted() async throws {
        let password = "SuperSecret-123!"
        let store = InMemorySessionStore()
        let model = makeModel(store: store, session: rotationSession())
        model.emailDraft = "test_admin@believeboy.com"
        model.passwordDraft = password

        await model.signIn()

        let session = try XCTUnwrap(store.session)
        let profileJSON = String(
            decoding: try JSONEncoder().encode(try XCTUnwrap(session.user)),
            as: UTF8.self
        )
        XCTAssertFalse(profileJSON.contains(password), "账号档案里不得出现密码")
        XCTAssertFalse(session.apiKey.contains(password), "凭据不得是密码本身")
        XCTAssertEqual(model.passwordDraft, "")
        // 会话结构本身没有密码承载位 —— 落盘形态由它决定。
        XCTAssertEqual(session.apiKey, "blf_FROM_LOGIN")
    }

    // MARK: - 验收 2：401 / 403 → 明确的再登录路径，不做无谓重试

    /// 403 是**最常发生**的失效信号（用户在网页端登录一次就会覆写同一行
    /// `user_api_keys`，桌面端手上那把立刻失效）—— PLAN §4.1.1。
    func testForbiddenProbeBouncesToLoginWithoutRetry() async {
        let store = InMemorySessionStore()
        try? store.saveSession(AuthSession(apiKey: "blf_STALE", user: .fixtureAdmin))
        let model = makeModel(store: store, session: rotationSession())

        await model.checkConnection()

        XCTAssertTrue(model.sessionState.isSignedOut, "403 必须回到登录页")
        let reason = model.sessionState.signedOutReason ?? ""
        XCTAssertTrue(reason.contains("403"), "文案要点出状态码：\(reason)")
        XCTAssertTrue(
            reason.contains("网页端"),
            "必须点明「可能已在网页端登录」这条主路径，否则用户只会去查权限：\(reason)"
        )
        XCTAssertNil(store.session, "已失效的 key 不得留在钥匙串里反复撞 403")
        XCTAssertEqual(StubURLProtocol.callCount("/api/v1/health"), 1, "不得重试")
        XCTAssertEqual(StubURLProtocol.callCount("/api/v1/health/live"), 1)
        XCTAssertTrue(model.phase.snapshot == nil, "失败结果不得伪装成一次成功的探测")
    }

    /// 401（缺 / 无效 key）与 403 走同一条再登录路径。
    func testUnauthorizedProbeAlsoBouncesToLogin() async {
        let store = InMemorySessionStore()
        try? store.saveSession(AuthSession(apiKey: "blf_ANY", user: .fixtureAdmin))
        let session = StubURLProtocol.session { request in
            switch request.url?.path {
            case "/api/v1/health/live":
                return .json(200, Self.liveBody)
            default:
                return .json(401, #"{"detail":"Missing API key"}"#)
            }
        }
        let model = makeModel(store: store, session: session)

        await model.checkConnection()

        XCTAssertTrue(model.sessionState.isSignedOut)
        XCTAssertTrue((model.sessionState.signedOutReason ?? "").contains("401"))
        XCTAssertEqual(StubURLProtocol.callCount("/api/v1/health"), 1, "不得重试")
    }

    /// 传输失败（后端不可达）**不是**凭据问题：留在主界面并显示连接错误，不能把
    /// 用户踢去重新登录 —— 那会让他去改一个本来正确的密码。
    func testTransportFailureDoesNotSignUserOut() async {
        let store = InMemorySessionStore()
        try? store.saveSession(AuthSession(apiKey: "blf_OK", user: .fixtureAdmin))
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [UnreachableURLProtocol.self]
        let model = makeModel(store: store, session: URLSession(configuration: configuration))

        await model.checkConnection()

        XCTAssertTrue(model.isSignedIn, "连不上后端不得当成凭据失效")
        XCTAssertEqual(model.phase.snapshot?.liveError, .transport("无法连接到主机"))
        XCTAssertNotNil(store.session, "网络问题不得清掉仍然有效的凭据")
    }

    // MARK: - 验收 4（轮换）：同账号二次登录致旧 key 失效 → 强制再登录

    /// 显式复现 PLAN §4.1.1 的失效链路：
    ///
    /// 1. 冷启动时手上是 `blf_STALE` —— 已被「同账号的另一次登录」覆写失效；
    /// 2. 首次鉴权失败必须**判定为 403**（`security.py` 的 `not_found` 与 `revoked`
    ///    同语义），落到明确的再登录路径，而不是「无权限」；
    /// 3. 重新登录拿到 `blf_FROM_LOGIN` 后，同一账号立刻恢复可用。
    func testRotatedKeyForcesReloginThenNewSessionWorks() async {
        let store = InMemorySessionStore()
        try? store.saveSession(AuthSession(apiKey: "blf_STALE", user: .fixtureAdmin))
        let model = makeModel(store: store, session: rotationSession())

        // 1) 凭据在手 → 冷启动直进主界面（不闪登录页）
        XCTAssertEqual(model.sessionState.session?.apiKey, "blf_STALE")

        // 2) 首次鉴权探测 → 403 → 回登录页，且把无效 key 清掉
        await model.checkConnection()
        XCTAssertTrue(model.sessionState.isSignedOut)
        XCTAssertNil(store.session)

        // 3) 重新登录 → 新 key 入库 → 探测全绿
        fillCredentials(model)
        await model.signIn()

        XCTAssertEqual(store.session?.apiKey, "blf_FROM_LOGIN")
        XCTAssertEqual(model.phase.snapshot?.health?.isOverallHealthy, true)
        XCTAssertTrue(
            StubURLProtocol.log.contains { $0.path == "/api/v1/health" && $0.apiKey == "blf_FROM_LOGIN" },
            "重新登录后必须用新 key 探测"
        )
    }

    // MARK: - 登出

    func testSignOutClearsStoredSession() throws {
        let store = InMemorySessionStore()
        try store.saveSession(AuthSession(apiKey: "blf_TO_CLEAR", user: .fixtureAdmin))
        let model = makeModel(store: store, session: rotationSession())
        XCTAssertTrue(model.isSignedIn)

        model.signOut()

        XCTAssertTrue(model.sessionState.isSignedOut)
        XCTAssertNil(store.session)
        XCTAssertNil(try store.loadSession())
        XCTAssertEqual(model.phase, .idle)
        XCTAssertEqual(model.emailDraft, "", "登出后不保留上一个人的邮箱")
    }

    /// 未登录时不该发探针（发了必然 401，会把「没登录」显示成「key 被拒」）。
    func testProbeIsNotIssuedWhileSignedOut() async {
        let model = makeModel(session: rotationSession())

        await model.checkConnection()

        XCTAssertTrue(StubURLProtocol.log.isEmpty, "未登录不得发起任何请求")
        XCTAssertEqual(model.phase.credentialBlock, "尚未登录，请先登录。")
    }

    /// 并发点两次「登录」不得发两次请求（后端登录有 5 次 / 30 分钟限流，
    /// 连点很容易把用户自己锁在门外）。
    func testConcurrentSignInDoesNotDoubleSubmit() async {
        let store = InMemorySessionStore()
        let model = makeModel(store: store, session: rotationSession())
        fillCredentials(model)

        async let first: Void = model.signIn()
        async let second: Void = model.signIn()
        _ = await (first, second)

        XCTAssertEqual(StubURLProtocol.callCount("/api/v1/auth/login"), 1, "并发点登录只应发一次")
        XCTAssertEqual(store.saveCalls, 1)
    }
}

/// 模拟 DNS 解析 / 连接失败。
private final class UnreachableURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
    }
    override func stopLoading() {}
}
