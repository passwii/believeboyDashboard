import Foundation

/// 后端请求失败的全部形态。UI 只在一处把错误映射为文案。
public enum APIError: Error, Sendable, Equatable {
    /// 路径无法拼成合法 URL（相对路径与 baseURL 组合失败）。
    case invalidURL(String)
    /// 传输层失败（DNS / 连接被拒 / 超时 / TLS）。
    case transport(String)
    /// 缺少凭据 —— 请求尚未发出。
    case missingCredential
    /// 401 / 403：key 缺失、无效或已吊销。
    case unauthorized(status: Int, body: String)
    /// 其它非 2xx 状态码。
    case http(status: Int, body: String)
    /// 响应体与预期模型不匹配。
    case decoding(String)
}

extension APIError: LocalizedError {
    public var errorDescription: String? { displayMessage }

    /// 面向用户的一句话说明（中文，可直接展示）。
    public var displayMessage: String {
        switch self {
        case .invalidURL(let path):
            return "后端地址或路径不合法：\(path)"
        case .transport(let detail):
            return "无法连接后端：\(detail)"
        case .missingCredential:
            return "缺少 API key，请先在设置中填写。"
        case .unauthorized(let status, _):
            return "API key 被拒绝（HTTP \(status)）。请确认 key 有效且未吊销。"
        case .http(let status, let body):
            let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty
                ? "后端返回 HTTP \(status)。"
                : "后端返回 HTTP \(status)：\(trimmed.prefix(200))"
        case .decoding(let detail):
            return "响应解析失败：\(detail)"
        }
    }

    /// 是否需要重新登录 / 重新填 key（UI 据此决定是否提示回到凭据输入）。
    public var requiresCredentialFix: Bool {
        switch self {
        case .missingCredential, .unauthorized: return true
        case .invalidURL, .transport, .http, .decoding: return false
        }
    }
}
