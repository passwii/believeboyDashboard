import BelieveBoyKit
import Foundation
import Observation

/// 应用级状态容器：登录态 + 连接配置 + 健康检查。
///
/// 为什么不用 TCA / Redux：当前状态图只有「一个会话 + 一次探针」，引入 reducer
/// 框架是为尚未出现的复杂度付费。后续模块各自新增 store，共享这里的会话组装方式。
///
/// 放在 UI target 而非 Kit：它持有视图状态，且被 `RootView` 直接观察；
/// Kit 保持纯逻辑、无 UI 依赖。
@MainActor
@Observable
public final class AppModel {
    /// 登录态。
    ///
    /// 三态的存在理由就是验收 1「冷启动凭据有效 → 直进主界面（**不闪登录页**）」：
    /// 钥匙串读取是同步的，但在读完之前**不能**先渲染登录页 —— 否则带有效凭据的
    /// 用户每次启动都会看到登录页闪一下。`.restoring` 就是那段「还没判定」的窗口。
    public enum SessionState: Equatable {
        case restoring
        /// 需要登录。`reason` 非空时说明「为什么回到了这里」（如凭据被顶掉）。
        case signedOut(reason: String?)
        case signedIn(AuthSession)

        public var session: AuthSession? {
            if case .signedIn(let session) = self { return session }
            return nil
        }

        public var isSignedOut: Bool {
            if case .signedOut = self { return true }
            return false
        }

        public var signedOutReason: String? {
            if case .signedOut(let reason) = self { return reason }
            return nil
        }
    }

    /// 连接检查的状态。
    public enum ConnectionPhase: Equatable {
        case idle
        case checking
        case done(HealthSnapshot)
        /// 检查**尚未发起** —— 没有可用凭据（未登录，或钥匙串读取失败）。
        /// 不伪造一个探针失败结果：进程存活与否根本还没测过，红的「进程存活」行是假信号。
        case blockedByCredential(String)

        public var isChecking: Bool {
            if case .checking = self { return true }
            return false
        }

        public var snapshot: HealthSnapshot? {
            if case .done(let snapshot) = self { return snapshot }
            return nil
        }

        /// 未发起检查的原因（非 nil 时 UI 显示该文案而非"按 ⌘R"提示）。
        public var credentialBlock: String? {
            if case .blockedByCredential(let message) = self { return message }
            return nil
        }
    }

    // MARK: - 登录态

    public private(set) var sessionState: SessionState = .restoring
    /// 登录表单：邮箱。密码单独放 `passwordDraft`，且**用完即清**。
    public var emailDraft: String = ""
    /// 登录表单：密码。不落盘、不进日志、不出现在任何 `Encodable` 里
    /// （`LoginRequest` 是唯一载体，构造完即随请求发走）。
    public var passwordDraft: String = ""
    public private(set) var isSigningIn = false
    /// 登录失败文案（邮箱密码错 / 账号停用 / 限流 / 网络），直接展示在登录页。
    public private(set) var loginError: String?
    /// 会话已建但持久化失败等**非致命**提示（登录仍可用）。
    public private(set) var sessionNotice: String?

    /// 内置环境选择。自定义地址非空时由 `customBaseURL` 覆盖。
    public var environment: AppConfig.Environment
    public var customBaseURL: String = ""
    public private(set) var phase: ConnectionPhase = .idle

    private let sessionStore: SessionStore
    /// 进程环境变量（`BELIEVEBOY_BASE_URL` / `BELIEVEBOY_API_KEY`）。
    /// 注意与 `environment`（配置里选的生产/本地）不是一回事，故单独命名。
    private let processEnvironment: [String: String]
    private let urlSession: URLSession

    public init(
        sessionStore: SessionStore = KeychainSessionStore(),
        appEnvironment: AppConfig.Environment = .production,
        processEnvironment: [String: String] = ProcessInfo.processInfo.environment,
        urlSession: URLSession = .shared
    ) {
        self.sessionStore = sessionStore
        self.processEnvironment = processEnvironment
        self.urlSession = urlSession
        self.environment = appEnvironment
        // 环境变量提供的 base URL 若命中内置环境，直接选中，省去用户手贴。
        let resolvedURL = AppConfig.resolved(environment: processEnvironment).baseURL
        if let matched = AppConfig.Environment.matching(resolvedURL) {
            self.environment = matched
        } else if resolvedURL != AppConfig.defaultBaseURL {
            self.customBaseURL = resolvedURL.absoluteString
        }
        restoreSession()
    }

    // MARK: - 派生值

    /// 当前生效的后端地址。自定义字段非空时优先。
    public var effectiveBaseURL: URL {
        if let custom = customBaseURL.trimmedNonEmpty, let url = URL(string: custom) {
            return url
        }
        return environment.baseURL
    }

    /// 当前账号档案；环境变量凭据（无账号上下文）时为 `nil`。
    public var currentUser: AuthenticatedUser? { sessionState.session?.user }

    public var isSignedIn: Bool { sessionState.session != nil }

    /// 顶栏显示的名字：中文名优先，退回邮箱，最后是「未登录」。
    public var displayName: String {
        guard let user = currentUser else { return isSignedIn ? "环境变量凭据" : "未登录" }
        return user.operatorNameZh?.trimmedNonEmpty ?? user.name
    }

    // MARK: - 会话恢复

    /// 冷启动恢复登录态。
    ///
    /// 顺序：环境变量覆盖 → 钥匙串会话 → 未登录。
    ///
    /// 环境变量（`BELIEVEBOY_API_KEY`）排在最前，是为了保持 S1 既有语义
    /// （「进程级只读覆盖」，README 的 CLI 排查路径）；它是**只读**的，因此这条路
    /// 没有账号档案，也就没有 `X-Operator` 一族请求头。要登录态就把这个变量去掉。
    private func restoreSession() {
        switch CredentialAvailability.resolve(EnvironmentCredentialStore(environment: processEnvironment)) {
        case .available(let key):
            sessionState = .signedIn(AuthSession(apiKey: key, user: nil))
            return
        case .unavailable(let reason):
            // 读不到环境变量不是错误路径，继续看钥匙串。
            _ = reason
        case .missing:
            break
        }

        do {
            if let stored = try sessionStore.loadSession() {
                sessionState = .signedIn(stored)
                return
            }
        } catch let error as CredentialStoreError {
            // 钥匙串读失败 ≠ 未登录：可能是被锁 / 权限被拒。必须说清，否则用户会
            // 反复重登却不知道为什么每次都回到登录页。
            sessionState = .signedOut(reason: "读取钥匙串失败：\(error.displayMessage)")
            return
        } catch {
            sessionState = .signedOut(reason: "读取钥匙串失败：\(error.localizedDescription)")
            return
        }

        sessionState = .signedOut(reason: nil)
    }

    // MARK: - 登录 / 登出

    /// 登录：`POST /api/v1/auth/login` → 会话入库 → 进入主界面。
    public func signIn() async {
        guard !isSigningIn else { return }
        isSigningIn = true
        loginError = nil
        sessionNotice = nil

        do {
            let authSession = try await AuthService.login(
                email: emailDraft,
                password: passwordDraft,
                baseURL: effectiveBaseURL,
                session: urlSession
            )
            // 密码用毕即清：不留在内存草稿里，也没有任何持久化路径会碰到它。
            passwordDraft = ""
            persist(authSession)
            sessionState = .signedIn(authSession)
            await checkConnection()
        } catch let error as AuthError {
            passwordDraft = ""
            loginError = error.displayMessage
        } catch {
            passwordDraft = ""
            loginError = error.localizedDescription
        }

        isSigningIn = false
    }

    /// 退出登录：清钥匙串会话并回到登录页。
    public func signOut() {
        do {
            try sessionStore.clearSession()
        } catch let error as CredentialStoreError {
            sessionNotice = "已退出登录，但钥匙串未清干净：\(error.displayMessage)"
        } catch {
            sessionNotice = "已退出登录，但钥匙串未清干净：\(error.localizedDescription)"
        }
        resetSessionState(reason: nil)
    }

    /// 会话入库。失败**不阻断本次登录**（key 在内存里仍然可用），但必须告知用户
    /// 重启后需要重新登录 —— 静默失败会让「登录态保持」变成偶发 bug。
    private func persist(_ session: AuthSession) {
        do {
            try sessionStore.saveSession(session)
        } catch let error as CredentialStoreError {
            sessionNotice = "已登录，但凭据未能写入钥匙串（\(error.displayMessage)），重启后需重新登录。"
        } catch {
            sessionNotice = "已登录，但凭据未能写入钥匙串（\(error.localizedDescription)），重启后需重新登录。"
        }
    }

    private func resetSessionState(reason: String?) {
        emailDraft = ""
        passwordDraft = ""
        loginError = nil
        phase = .idle
        sessionState = .signedOut(reason: reason)
    }

    /// 凭据失效（401/403）：清掉已知无效的 key、回到登录页，**不重试**。
    ///
    /// 这就是 PLAN §4.1.1 推论四：失效语义是「key 未被别处登录顶掉」，探测一次
    /// 就够。把无效 key 留在钥匙串只会让下次冷启动「直进主界面」后再撞一次 403，
    /// 用户看到的是偶发的闪退式体验，而不是一句明确的「请重新登录」。
    private func invalidateSession(reason: String) {
        try? sessionStore.clearSession()
        resetSessionState(reason: reason)
    }

    /// 401/403 → 用户可读的再登录理由。
    ///
    /// 403 是最常发生的那条（网页端登录会覆写同一行 `user_api_keys`），文案里必须
    /// 点明这个可能性，否则用户看到「无权限」只会去查权限。
    static func credentialFailureReason(_ error: APIError) -> String {
        switch error {
        case .unauthorized(let status, _):
            return "登录态已失效（HTTP \(status)）：该账号可能在网页端或其他设备重新登录过，"
                + "旧凭据已被替换。请重新登录。"
        case .missingCredential:
            return "缺少凭据，请重新登录。"
        default:
            return error.displayMessage
        }
    }

    // MARK: - 连接检查

    /// 检查连接。
    ///
    /// **未登录即中止**：没有会话时直接结束本次检查，不再发探针 —— 后端所有业务
    /// 端点（含 `/health`）都要鉴权，发出去只会拿到 401，把「没登录」显示成
    /// 「key 被拒绝」，误导排查方向。
    public func checkConnection() async {
        guard !phase.isChecking else { return }
        guard let authSession = sessionState.session else {
            phase = .blockedByCredential("尚未登录，请先登录。")
            return
        }
        phase = .checking

        let client = APIClient(
            config: AppConfig(baseURL: effectiveBaseURL, apiKey: authSession.apiKey),
            authSession: authSession,
            session: urlSession
        )
        let snapshot = await HealthProbe.snapshot(using: client)

        // 任一步拿到「凭据需修」信号都回登录页。存活探针本身免鉴权、正常不会 401/403，
        // 但两条都判一次，避免将来给它加上鉴权时漏掉这条路径。
        if let failure = [snapshot.healthError, snapshot.liveError]
            .compactMap({ $0 })
            .first(where: \.requiresCredentialFix)
        {
            invalidateSession(reason: Self.credentialFailureReason(failure))
            return
        }

        phase = .done(snapshot)
    }
}
