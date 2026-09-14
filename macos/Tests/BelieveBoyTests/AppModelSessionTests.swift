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
        remembered: InMemoryRememberedLoginStore = InMemoryRememberedLoginStore(),
        clientIdentifiers: InMemoryClientIdentifierStore = InMemoryClientIdentifierStore(),
        session: URLSession,
        processEnvironment: [String: String] = [:]
    ) -> AppModel {
        AppModel(
            sessionStore: store,
            rememberedLogins: remembered,
            clientIdentifiers: clientIdentifiers,
            processEnvironment: processEnvironment,
            urlSession: session
        )
    }

    /// 最后一次登录请求实际发出的设备槽标识（**看真实请求，不看内部状态**）。
    private func loginClientIDHeader() -> String? {
        StubURLProtocol.log
            .last { $0.path == "/api/v1/auth/login" }?
            .header("X-Client-Id")
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

    /// 403 的具体成因在 BLF-1059/1060 之后变了：key 已按设备槽分区，**换一台设备登录
    /// 不会再顶掉本机**，现在只剩「同一设备标识在别处登录（同槽轮换）」「改密码撤销
    /// 全部设备」等。文案仍要点出「别处登录过」这条主路径（PLAN §4.1.1）—— 否则用户
    /// 只会去查权限。
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
            "必须点明「可能已在网页端/其他设备登录」这条路径，否则用户只会去查权限：\(reason)"
        )
        XCTAssertTrue(
            reason.contains("改密码"),
            "按设备槽分区后，改密码撤销全部设备是最常见的成因，文案不能漏：\(reason)"
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

    // MARK: - 「记住密码」

    /// 默认不记住：替用户把密码写进钥匙串必须是他自己的决定（默认关）。
    func testPasswordIsNotRememberedByDefault() async {
        let remembered = InMemoryRememberedLoginStore()
        let model = makeModel(remembered: remembered, session: rotationSession())
        XCTAssertFalse(model.rememberPassword)
        fillCredentials(model)

        await model.signIn()

        XCTAssertNil(remembered.login, "未勾选「记住密码」不得写入任何凭据")
    }

    func testRememberPasswordStoresCredentialsAfterSuccessfulLogin() async {
        let remembered = InMemoryRememberedLoginStore()
        let model = makeModel(remembered: remembered, session: rotationSession())
        model.setRememberPassword(true)
        fillCredentials(model)

        await model.signIn()

        XCTAssertEqual(remembered.login?.email, "test_admin@believeboy.com")
        XCTAssertEqual(remembered.login?.password, "TestAdmin123")
        XCTAssertNil(model.loginError)
    }

    /// 勾上时不该立刻写：此刻草稿里可能是还没验证过的密码。
    func testEnablingRememberPasswordDoesNotWriteBeforeLogin() {
        let remembered = InMemoryRememberedLoginStore()
        let model = makeModel(remembered: remembered, session: rotationSession())
        fillCredentials(model)

        model.setRememberPassword(true)

        XCTAssertNil(remembered.login, "写入必须发生在登录成功之后")
    }

    /// 登录失败不得把错密码记下来（否则下次预填的还是错的），但用户的勾选态保留。
    func testFailedLoginDoesNotRememberPassword() async {
        let remembered = InMemoryRememberedLoginStore()
        let session = StubURLProtocol.session(routes: [
            "/api/v1/auth/login": .json(401, #"{"detail":"Invalid credentials"}"#),
        ])
        let model = makeModel(remembered: remembered, session: session)
        model.setRememberPassword(true)
        fillCredentials(model)

        await model.signIn()

        XCTAssertNil(remembered.login)
        XCTAssertTrue(model.rememberPassword, "失败不该把用户的勾选态改掉")
    }

    /// 取消勾选 = 立刻删掉已存的凭据。
    func testUncheckingRememberPasswordDeletesStoredCredentials() {
        let remembered = InMemoryRememberedLoginStore(
            seeded: RememberedLogin(email: "test_admin@believeboy.com", password: "TestAdmin123")
        )
        let model = makeModel(remembered: remembered, session: rotationSession())

        // 钥匙串里有凭据 → 登录页开箱即预填、勾选态为真。
        XCTAssertTrue(model.rememberPassword)
        XCTAssertEqual(model.emailDraft, "test_admin@believeboy.com")
        XCTAssertEqual(model.passwordDraft, "TestAdmin123")

        model.setRememberPassword(false)

        XCTAssertNil(remembered.login)
        XCTAssertEqual(remembered.deleteCalls, 1)
    }

    /// 403（key 被网页端顶掉）之后，记住的凭据让「再登录」只是一次点击 —— 这正是
    /// 「记住密码」在本项目里的主要价值（key 是覆盖式轮换，见 PLAN §4.1.1）。
    func testRotatedKeyKeepsRememberedCredentialsReadyForOneClickRelogin() async {
        let store = InMemorySessionStore()
        try? store.saveSession(AuthSession(apiKey: "blf_STALE", user: .fixtureAdmin))
        let remembered = InMemoryRememberedLoginStore(
            seeded: RememberedLogin(email: "test_admin@believeboy.com", password: "TestAdmin123")
        )
        let model = makeModel(store: store, remembered: remembered, session: rotationSession())

        await model.checkConnection()

        XCTAssertTrue(model.sessionState.isSignedOut)
        XCTAssertEqual(model.emailDraft, "test_admin@believeboy.com", "失效后必须预填邮箱")
        XCTAssertEqual(model.passwordDraft, "TestAdmin123", "失效后必须预填密码，一次点击即可重登")
        XCTAssertNotNil(remembered.login, "预填不是删除：用户并未取消勾选")

        await model.signIn()
        XCTAssertTrue(model.isSignedIn)
        XCTAssertEqual(store.session?.apiKey, "blf_FROM_LOGIN")
    }

    /// 登出后仍保留「记住密码」的凭据（用户勾的就是这个），但会话必须干净。
    func testSignOutKeepsRememberedCredentialsButClearsSession() throws {
        let store = InMemorySessionStore()
        try store.saveSession(AuthSession(apiKey: "blf_TO_CLEAR", user: .fixtureAdmin))
        let remembered = InMemoryRememberedLoginStore(
            seeded: RememberedLogin(email: "test_admin@believeboy.com", password: "TestAdmin123")
        )
        let model = makeModel(store: store, remembered: remembered, session: rotationSession())

        model.signOut()

        XCTAssertNil(store.session)
        XCTAssertNotNil(remembered.login, "登出不得顺手删掉「记住密码」")
        XCTAssertEqual(model.emailDraft, "test_admin@believeboy.com")
    }

    /// 密码只有两个去处 —— 内存草稿与钥匙串。既不进账号档案，也不进 `UserDefaults`。
    func testRememberedPasswordDoesNotLeakIntoUserDefaultsOrProfile() async throws {
        let password = "SuperSecret-123!"
        let store = InMemorySessionStore()
        let remembered = InMemoryRememberedLoginStore()
        let model = makeModel(store: store, remembered: remembered, session: rotationSession())
        model.setRememberPassword(true)
        model.emailDraft = "test_admin@believeboy.com"
        model.passwordDraft = password

        await model.signIn()

        XCTAssertEqual(remembered.login?.password, password, "勾选后密码只该落到钥匙串那一条路径")
        let profileJSON = String(
            decoding: try JSONEncoder().encode(try XCTUnwrap(store.session?.user)),
            as: UTF8.self
        )
        XCTAssertFalse(profileJSON.contains(password), "账号档案里不得出现密码")
        for (key, value) in UserDefaults.standard.dictionaryRepresentation() {
            XCTAssertFalse(
                String(describing: value).contains(password),
                "UserDefaults 里不得出现密码（键：\(key)）"
            )
        }
    }

    /// 「记住密码」存储读失败（钥匙串被锁 / 权限被拒）不得挡住登录：只提示原因。
    func testRememberedCredentialReadFailureWarnsWithoutBlockingLogin() async {
        let remembered = InMemoryRememberedLoginStore()
        remembered.failLoading(
            with: CredentialStoreError.keychain(status: -25308, message: "User interaction is not allowed.")
        )
        let model = makeModel(remembered: remembered, session: rotationSession())

        XCTAssertTrue(model.sessionState.isSignedOut)
        XCTAssertTrue(
            (model.sessionNotice ?? "").contains("记住密码"),
            "要说清是「记住密码」这条读失败：\(model.sessionNotice ?? "nil")"
        )
        XCTAssertFalse(model.rememberPassword, "读不到就不能显示成已记住")

        fillCredentials(model)
        await model.signIn()
        XCTAssertTrue(model.isSignedIn, "读失败不得挡住登录")
    }

    /// 写「记住密码」失败不影响登录结果，但必须告知（否则用户以为已经记住了）。
    func testRememberedCredentialWriteFailureIsReportedButDoesNotBlockSignIn() async {
        let remembered = InMemoryRememberedLoginStore()
        remembered.failSaving(
            with: CredentialStoreError.keychain(status: -25308, message: "User interaction is not allowed.")
        )
        let model = makeModel(remembered: remembered, session: rotationSession())
        model.setRememberPassword(true)
        fillCredentials(model)

        await model.signIn()

        XCTAssertTrue(model.isSignedIn)
        XCTAssertTrue((model.sessionNotice ?? "").contains("记住密码"))
        XCTAssertNil(remembered.login)
    }

    /// 服务器选择默认折叠（渲染效果由离屏渲染核对），折叠标题给的是简称。
    func testServerOptionsAreCollapsedByDefaultAndTitledByEnvironment() {
        let model = makeModel(session: rotationSession())
        XCTAssertFalse(model.isServerOptionsExpanded)
        XCTAssertEqual(model.serverDisplayName, "生产")

        model.customBaseURL = "https://dash-api.example.com"
        XCTAssertEqual(model.serverDisplayName, "自定义")
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

    // MARK: - 验收 1/2/3（BLF-1060）：登录真的带走设备标识

    /// 登录请求确实带上了本机的设备标识（不是后端默认槽）—— 断的是**真实请求头**。
    func testLoginSendsThePersistedDeviceIdentifier() async {
        let clientIdentifiers = InMemoryClientIdentifierStore(seeded: "mac-01a09fa8-6311")
        let model = makeModel(clientIdentifiers: clientIdentifiers, session: rotationSession())
        fillCredentials(model)

        await model.signIn()

        XCTAssertEqual(
            loginClientIDHeader(),
            "mac-01a09fa8-6311",
            "桌面端必须把本机标识发出去，否则后端按 default 槽下发 → 又变成顶掉网页端"
        )
        XCTAssertEqual(clientIdentifiers.saveCalls, 0, "已有标识不该在登录时被改写")
    }

    /// 首次启动（钥匙串里还没有标识）：登录前就生成并落盘，本次登录直接带上它。
    func testFirstLaunchGeneratesTheDeviceIdentifierBeforeLogin() async {
        let clientIdentifiers = InMemoryClientIdentifierStore()
        let model = makeModel(clientIdentifiers: clientIdentifiers, session: rotationSession())
        fillCredentials(model)

        await model.signIn()

        let header = try? XCTUnwrap(loginClientIDHeader())
        XCTAssertEqual(header, clientIdentifiers.clientID, "生成的标识必须落盘，且就是本次发出的那个")
        XCTAssertEqual(clientIdentifiers.saveCalls, 1)
        XCTAssertNotNil(header)
    }

    /// **「重启进程后不变」**（验收 2）：两个 `AppModel` 实例（= 两次启动）共用同一份
    /// 存储 → 登录用的是同一个设备槽；退出再登也不会换槽。
    func testRestartReusesTheSameDeviceIdentifier() async {
        let clientIdentifiers = InMemoryClientIdentifierStore()
        // 「重启 + 记住密码」是用户实际走的那条路：凭据由钥匙串预填，一次点击即可重登。
        let remembered = InMemoryRememberedLoginStore(
            seeded: RememberedLogin(email: "test_admin@believeboy.com", password: "TestAdmin123")
        )

        // 第一次启动（钥匙串里还没有设备标识）：生成标识并登录。
        let firstLaunch = makeModel(
            remembered: remembered,
            clientIdentifiers: clientIdentifiers,
            session: rotationSession()
        )
        fillCredentials(firstLaunch)
        await firstLaunch.signIn()
        XCTAssertTrue(firstLaunch.isSignedIn)
        let firstHeader = loginClientIDHeader()
        XCTAssertNotNil(firstHeader)

        // 重启 + 退出再登（会话已清，凭据回填）。
        firstLaunch.signOut()
        let secondLaunch = makeModel(
            remembered: remembered,
            clientIdentifiers: clientIdentifiers,
            session: rotationSession()
        )
        XCTAssertEqual(secondLaunch.emailDraft, "test_admin@believeboy.com", "预填才能只点一下重登")
        await secondLaunch.signIn()
        XCTAssertTrue(secondLaunch.isSignedIn, "重登失败则本用例什么都没证明")

        XCTAssertEqual(loginClientIDHeader(), firstHeader, "同一台机器重启后必须复用同一个设备槽")
        XCTAssertEqual(clientIdentifiers.saveCalls, 1, "重启不该重新生成标识")
    }

    /// 两个独立 install（各自一份钥匙串存储）→ 各自一把 key，标识不同（验收 3）。
    func testSeparateInstallsGetTheirOwnDeviceIdentifiers() async {
        let firstInstall = InMemoryClientIdentifierStore()
        let secondInstall = InMemoryClientIdentifierStore()

        let firstModel = makeModel(clientIdentifiers: firstInstall, session: rotationSession())
        fillCredentials(firstModel)
        await firstModel.signIn()
        let firstHeader = loginClientIDHeader()

        let secondModel = makeModel(clientIdentifiers: secondInstall, session: rotationSession())
        fillCredentials(secondModel)
        await secondModel.signIn()
        let secondHeader = loginClientIDHeader()

        XCTAssertNotNil(firstHeader)
        XCTAssertNotEqual(firstHeader, secondHeader, "两个 install 必须是两个设备槽，否则仍会互相顶")
        XCTAssertNotEqual(firstInstall.clientID, secondInstall.clientID)
    }

    /// 403 → 「记住密码」预填 → 重新登录：这条路径同样带设备标识（验收 3）。
    func testReloginAfter403StillSendsTheSameDeviceIdentifier() async {
        let store = InMemorySessionStore()
        try? store.saveSession(AuthSession(apiKey: "blf_STALE", user: .fixtureAdmin))
        let remembered = InMemoryRememberedLoginStore(
            seeded: RememberedLogin(email: "test_admin@believeboy.com", password: "TestAdmin123")
        )
        let clientIdentifiers = InMemoryClientIdentifierStore(seeded: "mac-restart-proof")
        let model = makeModel(
            store: store,
            remembered: remembered,
            clientIdentifiers: clientIdentifiers,
            session: rotationSession()
        )

        await model.checkConnection()
        XCTAssertTrue(model.sessionState.isSignedOut)

        await model.signIn()

        XCTAssertTrue(model.isSignedIn)
        XCTAssertEqual(loginClientIDHeader(), "mac-restart-proof", "重登路径必须带上同一个设备标识")
    }

    /// 钥匙串写不进设备标识：**不挡登录**，且这次登录仍带上一个标识（于是网页端那把
    /// key 依然安全），同时给出可见提示 —— 静默降级会让「重启后换槽」变成偶发灵异。
    func testUnwritableDeviceIdentifierStoreStillLogsInAndWarns() async {
        let clientIdentifiers = InMemoryClientIdentifierStore()
        clientIdentifiers.failSaving(
            with: CredentialStoreError.keychain(status: -34018, message: "Missing entitlement")
        )
        let model = makeModel(clientIdentifiers: clientIdentifiers, session: rotationSession())

        XCTAssertNotNil(model.sessionNotice, "启动时就该把退化说清楚")
        let notice = model.sessionNotice ?? ""
        XCTAssertTrue(notice.contains("设备标识"), "提示要指明是设备标识的问题：\(notice)")

        fillCredentials(model)
        await model.signIn()

        XCTAssertTrue(model.isSignedIn, "钥匙串写不进不得挡住登录")
        let header = loginClientIDHeader()
        XCTAssertNotNil(header, "退化也不得回退成「不带标识」—— 那会顶掉网页端")
        XCTAssertTrue(ClientIdentifier.isValid(header ?? ""), "发出去的值必须合法：\(header ?? "nil")")
        XCTAssertNotNil(
            model.sessionNotice,
            "登录流程会重置提示，设备标识的退化说明要在登录后补回：\(String(describing: model.sessionNotice))"
        )
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
