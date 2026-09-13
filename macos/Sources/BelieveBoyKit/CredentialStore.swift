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
