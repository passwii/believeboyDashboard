import BelieveBoyKit
import Foundation
import Observation

/// 应用级状态容器（Stage 1：只承载连接配置与健康检查）。
///
/// 为什么不用 TCA / Redux：当前状态图只有「配置 + 一次探针」，引入 reducer 框架
/// 是为尚未出现的复杂度付费。后续模块各自新增 store，共享这里的 `config` 组装方式。
///
/// 放在 UI target 而非 Kit：它持有视图状态，且被 `RootView` 直接观察；
/// Kit 保持纯逻辑、无 UI 依赖。
@MainActor
@Observable
public final class AppModel {
    /// 连接检查的状态。
    public enum ConnectionPhase: Equatable {
        case idle
        case checking
        case done(HealthSnapshot)
        /// 检查**尚未发起** —— 没有可用凭据（未配置，或钥匙串读取失败）。
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

    /// 内置环境选择。自定义地址非空时由 `customBaseURL` 覆盖。
    public var environment: AppConfig.Environment
    public var customBaseURL: String = ""
    /// 输入框草稿。仅在「保存到钥匙串」时写入钥匙串，避免每次击键都碰 Security API。
    public var apiKeyDraft: String = ""
    /// 凭据是否已存在（不展示明文）。
    public private(set) var hasStoredCredential = false
    public private(set) var credentialMessage: String?
    public private(set) var phase: ConnectionPhase = .idle

    private let credentialStore: CredentialStore

    public init(
        credentialStore: CredentialStore = KeychainCredentialStore(),
        environment: AppConfig.Environment = .production
    ) {
        self.credentialStore = credentialStore
        self.environment = environment
        // 环境变量提供的 base URL 若命中内置环境，直接选中，省去用户手贴。
        let resolvedURL = AppConfig.resolved().baseURL
        if let matched = AppConfig.Environment.matching(resolvedURL) {
            self.environment = matched
        } else if resolvedURL != AppConfig.defaultBaseURL {
            self.customBaseURL = resolvedURL.absoluteString
        }
        refreshCredentialState()
    }

    // MARK: - 派生值

    /// 当前生效的后端地址。自定义字段非空时优先。
    public var effectiveBaseURL: URL {
        if let custom = customBaseURL.trimmedNonEmpty, let url = URL(string: custom) {
            return url
        }
        return environment.baseURL
    }

    // MARK: - 凭据

    public func refreshCredentialState() {
        switch CredentialAvailability.resolve(credentialStore) {
        case .available:
            hasStoredCredential = true
            credentialMessage = nil
        case .missing:
            hasStoredCredential = false
            credentialMessage = nil
        case .unavailable(let reason):
            hasStoredCredential = false
            credentialMessage = reason
        }
    }

    public func saveCredential() {
        do {
            try credentialStore.saveAPIKey(apiKeyDraft)
            apiKeyDraft = ""
            credentialMessage = "已保存到钥匙串。"
            refreshCredentialState()
        } catch let error as CredentialStoreError {
            credentialMessage = error.displayMessage
        } catch {
            credentialMessage = error.localizedDescription
        }
    }

    public func clearCredential() {
        do {
            try credentialStore.deleteAPIKey()
            credentialMessage = "已清除钥匙串中的 API key。"
            refreshCredentialState()
        } catch let error as CredentialStoreError {
            credentialMessage = error.displayMessage
        } catch {
            credentialMessage = error.localizedDescription
        }
    }

    // MARK: - 连接检查

    /// 检查连接。
    ///
    /// **无凭据即中止**：找不到 key 时直接结束本次检查，不再发探针 —— 后端所有业务
    /// 端点（含 `/health`）都要鉴权，发出去只会拿到 401，把「没填 key」显示成
    /// 「key 被拒绝」，误导排查方向。UI 改看「未配置凭据」，与启动时一致。
    public func checkConnection() async {
        guard !phase.isChecking else { return }
        phase = .checking

        switch CredentialAvailability.resolve(credentialStore) {
        case .available(let key):
            hasStoredCredential = true
            credentialMessage = nil
            let config = AppConfig.resolved(baseURL: effectiveBaseURL, apiKey: key)
            let client = APIClient(config: config)
            let snapshot = await HealthProbe.snapshot(using: client)
            phase = .done(snapshot)
        case .missing:
            failCheck(message: "尚未配置 API key，请先在上方保存到钥匙串。")
        case .unavailable(let reason):
            // 读钥匙串失败 ≠ 没配 key，两者的处置文案不同。
            failCheck(message: reason)
        }
    }

    /// 本次检查未发起，原因对用户可见。
    private func failCheck(message: String) {
        hasStoredCredential = false
        credentialMessage = message
        phase = .blockedByCredential(message)
    }
}
