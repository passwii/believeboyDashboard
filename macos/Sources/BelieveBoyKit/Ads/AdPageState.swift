import Foundation

/// 一个数据格的加载阶段（广告两页共用：广告分析的「按 Tab」、广告数据的「按报表类型」）。
public enum AdLoadPhase: Equatable, Sendable {
    case idle
    case loading
    case loaded
    case failed(String)

    public var isLoading: Bool { self == .loading }

    public var failureMessage: String? {
        if case .failed(let message) = self { return message }
        return nil
    }
}

/// 项目列表这道闸门。
///
/// 广告两页的**每一个**端点都要求 `project_id`（广告分析在查询串、广告数据在路径里），
/// 所以「项目列表」不是页面里的一块内容，而是所有请求的前置条件：它没就绪时不该发出任何
/// 明细请求（发了也是 400/404，只会把界面变成一个错误页）。
public enum AdProjectGate: Equatable, Sendable {
    /// 正在取项目列表。
    case pending
    /// 项目列表加载失败（可重试）。
    case failed(String)
    /// 项目列表取到了，但这个账号一个可见项目都没有。
    case noProjects
    case ready
}
