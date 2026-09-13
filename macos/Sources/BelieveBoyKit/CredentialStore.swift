import Foundation

/// 凭据存储抽象。API key 只经此读写，UI 与网络层都不直接接触持久化细节。
public protocol CredentialStore: Sendable {
    /// 读取当前 key；未配置返回 `nil`。
    func loadAPIKey() throws -> String?
    /// 写入并覆盖已有 key。
    func saveAPIKey(_ key: String) throws
    /// 删除已存 key（幂等）。
    func deleteAPIKey() throws
}

/// 凭据存储失败。
public enum CredentialStoreError: Error, Sendable, Equatable {
    case readOnly
    case keychain(status: Int32, message: String)

    public var displayMessage: String {
        switch self {
        case .readOnly:
            return "该凭据来源为只读（由环境变量提供），无法写入。"
        case .keychain(let status, let message):
            return "钥匙串操作失败（OSStatus \(status)）：\(message)"
        }
    }
}

extension CredentialStoreError: LocalizedError {
    public var errorDescription: String? { displayMessage }
}

/// 「能否用现有凭据发请求」的判定结果。
///
/// 把 `CredentialStore` 的三种结果收敛成一处：**没配 key** 与 **读不到 keychain**
/// 是两件事（后者可能是钥匙串被锁 / 权限被拒），把它们都折叠成"缺少凭据"会让用户
/// 反复重填一个其实已经存在的 key。
public enum CredentialAvailability: Equatable, Sendable {
    /// 有可用 key。
    case available(String)
    /// 确实没有配置 key。
    case missing
    /// 读取失败，`message` 已可直接展示给用户。
    case unavailable(String)

    /// 读取凭据并归类；不抛错 —— 失败也是一种结果。
    public static func resolve(_ store: CredentialStore) -> CredentialAvailability {
        do {
            guard let key = try store.loadAPIKey()?.trimmedNonEmpty else { return .missing }
            return .available(key)
        } catch let error as CredentialStoreError {
            return .unavailable(error.displayMessage)
        } catch {
            return .unavailable(error.localizedDescription)
        }
    }

    /// 可用的 key；未就绪为 `nil`。
    public var key: String? {
        if case .available(let key) = self { return key }
        return nil
    }

    /// 不可用时的展示文案（`missing` 无文案，由调用方决定措辞）。
    public var failureMessage: String? {
        if case .unavailable(let message) = self { return message }
        return nil
    }
}

/// 只读凭据源：由环境变量提供。
///
/// 用途：无 GUI 的连通性排查（`BELIEVEBOY_API_KEY=… swift run …`）与 CI。
/// 环境变量是进程级输入，不落盘、不可改 —— 因此写操作明确失败而非静默忽略。
public struct EnvironmentCredentialStore: CredentialStore {
    private let environment: [String: String]

    public init(environment: [String: String] = ProcessInfo.processInfo.environment) {
        self.environment = environment
    }

    public func loadAPIKey() throws -> String? {
        environment["BELIEVEBOY_API_KEY"]?.trimmedNonEmpty
    }

    public func saveAPIKey(_ key: String) throws { throw CredentialStoreError.readOnly }

    public func deleteAPIKey() throws { throw CredentialStoreError.readOnly }
}
