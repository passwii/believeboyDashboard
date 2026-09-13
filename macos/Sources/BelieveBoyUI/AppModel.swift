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
    /// 连接检查的三态。
    public enum ConnectionPhase: Equatable {
        case idle
        case checking
        case done(HealthSnapshot)

        public var isChecking: Bool {
            if case .checking = self { return true }
            return false
        }

        public var snapshot: HealthSnapshot? {
            if case .done(let snapshot) = self { return snapshot }
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
        do {
            hasStoredCredential = try credentialStore.loadAPIKey() != nil
            credentialMessage = nil
        } catch let error as CredentialStoreError {
            hasStoredCredential = false
            credentialMessage = error.displayMessage
        } catch {
            hasStoredCredential = false
            credentialMessage = error.localizedDescription
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

    public func checkConnection() async {
        guard !phase.isChecking else { return }
        phase = .checking

        let storedKey = try? credentialStore.loadAPIKey()
        let config = AppConfig.resolved(baseURL: effectiveBaseURL, apiKey: storedKey ?? nil)
        let client = APIClient(config: config)
        let snapshot = await HealthProbe.snapshot(using: client)
        phase = .done(snapshot)
    }
}
