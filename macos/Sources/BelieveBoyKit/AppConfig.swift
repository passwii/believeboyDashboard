import Foundation

/// 后端地址与凭据的运行时配置。
///
/// 优先级：进程环境变量 > 传入值 > 内置默认。
/// 环境变量入口让「同一份构建指向本地/生产」无需改代码，也便于无 GUI 的连通性排查。
public struct AppConfig: Sendable, Equatable {
    /// 已知部署环境。`local` 对应 `backend/run_api.sh` 的监听地址。
    public enum Environment: String, Sendable, CaseIterable, Identifiable {
        case production
        case local

        public var id: String { rawValue }

        public var displayName: String {
            switch self {
            case .production: return "生产（dash-api.believeboy.com）"
            case .local: return "本地（127.0.0.1:8100）"
            }
        }

        public var baseURL: URL {
            switch self {
            case .production: return URL(string: "https://dash-api.believeboy.com")!
            case .local: return URL(string: "http://127.0.0.1:8100")!
            }
        }

        /// 由 baseURL 反查环境；未知地址返回 nil（自定义地址场景）。
        public static func matching(_ url: URL) -> Environment? {
            allCases.first { $0.baseURL == url }
        }
    }

    /// 后端根地址，不含 `/api/v1`（路径前缀由 `APIClient` 统一拼接）。
    public var baseURL: URL
    /// 账号专属 key（`blf_` 前缀，登录下发）或主 key。`nil` = 尚未配置。
    public var apiKey: String?

    public init(baseURL: URL, apiKey: String?) {
        self.baseURL = baseURL
        self.apiKey = apiKey
    }

    public static let defaultBaseURL = Environment.production.baseURL

    /// 应用环境变量覆盖后的配置。
    ///
    /// - Parameters:
    ///   - baseURL: 默认地址；`BELIEVEBOY_BASE_URL` 存在时被其覆盖。
    ///   - apiKey: 默认凭据；`BELIEVEBOY_API_KEY` 存在且非空时被其覆盖。
    public static func resolved(
        baseURL: URL = AppConfig.defaultBaseURL,
        apiKey: String? = nil,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> AppConfig {
        var resolvedURL = baseURL
        if let raw = environment["BELIEVEBOY_BASE_URL"]?.trimmedNonEmpty,
           let parsed = URL(string: raw) {
            resolvedURL = parsed
        }
        let resolvedKey = environment["BELIEVEBOY_API_KEY"]?.trimmedNonEmpty ?? apiKey
        return AppConfig(baseURL: resolvedURL, apiKey: resolvedKey)
    }
}

extension String {
    /// 去除首尾空白后的非空值；全空白返回 nil。
    public var trimmedNonEmpty: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
