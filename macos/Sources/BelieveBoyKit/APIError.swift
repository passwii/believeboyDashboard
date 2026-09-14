import Foundation

/// 后端请求失败的全部形态。UI 只在一处把错误映射为文案。
public enum APIError: Error, Sendable, Equatable {
    /// 路径无法拼成合法 URL（相对路径与 baseURL 组合失败）。
    case invalidURL(String)
    /// `baseURL` 不是根地址（带路径前缀 / query / fragment）——`/api/v1` 前缀无法安全拼接。
    case invalidBaseURL(String)
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
    /// 长任务轮询到上限仍未到终态（不再继续打后端）。
    case pollingTimedOut(attempts: Int)
    /// 长任务终态为 failed（`status` 是后端给的状态，`detail` 取最近一次 run 的
    /// `error_message`，可能为空）。
    case jobFailed(status: String, detail: String?)
    /// 响应体落盘失败（磁盘满 / 无权限 / 目标路径不可写）。
    ///
    /// 与 `.transport` 分开：网络断了和磁盘写不进，处置方式完全不同。
    case fileWrite(String)
    /// 待上传的本地文件读不到（被删 / 无权限 / 读属性失败）。
    ///
    /// 同样是本地 I/O 与网络无关：请求甚至还没发出去。
    case fileRead(String)
}

extension APIError: LocalizedError {
    public var errorDescription: String? { displayMessage }

    /// 面向用户的一句话说明（中文，可直接展示）。
    public var displayMessage: String {
        switch self {
        case .invalidURL(let path):
            return "后端地址或路径不合法：\(path)"
        case .invalidBaseURL(let value):
            return "后端地址必须是根地址（不含路径 / 查询参数）：\(value)"
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
        case .pollingTimedOut(let attempts):
            return "任务在 \(attempts) 次轮询后仍未完成，已停止等待。"
        case .jobFailed(let status, let detail):
            let trimmed = detail?.trimmingCharacters(in: .whitespacesAndNewlines)
            let reason = (trimmed?.isEmpty == false) ? "：\(trimmed!)" : ""
            return "任务执行失败（\(status)）\(reason)"
        case .fileWrite(let detail):
            return "文件写入失败：\(detail)"
        case .fileRead(let detail):
            return "文件读取失败：\(detail)"
        }
    }

    /// 是否需要重新登录 / 重新填 key（UI 据此决定是否提示回到凭据输入）。
    public var requiresCredentialFix: Bool {
        switch self {
        case .missingCredential, .unauthorized: return true
        // `.jobFailed` / `.pollingTimedOut` / `.fileWrite` 都是「请求已按身份通过、
        // 事情本身没成」，与凭据无关：不得把用户赶回登录页。
        case .invalidURL, .invalidBaseURL, .transport, .http, .decoding,
             .pollingTimedOut, .jobFailed, .fileWrite, .fileRead:
            return false
        }
    }
}
