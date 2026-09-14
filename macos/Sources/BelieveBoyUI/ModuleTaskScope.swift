import Foundation

/// 模块级 Task 作用域：每个「当前选中项」的后台任务（请求 / 轮询 / 刷新）都登记在
/// 一个显式 key（= route id）下，选中项一换就整段取消 —— 这是「切换模块无泄漏 Task」
/// 的机制落点。
///
/// 为什么不能只靠视图 `.task`：`.task` 只管「视图自己发起、由 SwiftUI 管理」的那一个
/// 任务，视图一销毁它就取消。但模块的轮询与用户触发的刷新是**非结构化** Task
/// （`Task { }`），视图销毁不会连坐 —— S4+ 每个模块都记得自己取消，迟早会漏一个。
/// 把归属写成显式 key、由外壳统一取消，漏取消就不再取决于模块自觉。
///
/// `@MainActor`：登记表与 `NavigationStore` 同域（都在主 actor），视图与 store 直接从
/// 主 actor 调用，不必加锁；被取消的任务自己会收到 `Task.isCancelled` 并在下一个
/// 挂起点退出。
@MainActor
public final class ModuleTaskScope {
    private struct Entry {
        /// 每次 `run` 的唯一标记：用来识别「这条登记还是我那次 run 留下的吗」。
        let token: UUID
        let task: Task<Void, Never>
    }

    private var entries: [String: Entry] = [:]

    public init() {}

    /// 当前仍在跑的任务 key（测试与调试用）。
    public var activeKeys: Set<String> { Set(entries.keys) }

    /// 是否已经没有在跑的任务 —— 切换模块后它应当最终回到 `true`。
    public var isEmpty: Bool { entries.isEmpty }

    /// 登记并启动一个任务。同 key 上已有的任务会被**先取消**（同一个模块重复加载时
    /// 只保留最后一次）。
    @discardableResult
    public func run(key: String, operation: @escaping @MainActor () async -> Void) -> Task<Void, Never> {
        cancel(key: key)
        let token = UUID()
        let task = Task { @MainActor [weak self] in
            await operation()
            self?.finish(key: key, token: token)
        }
        entries[key] = Entry(token: token, task: task)
        return task
    }

    /// 取消某个 key 下的任务（幂等）。
    public func cancel(key: String) {
        guard let entry = entries.removeValue(forKey: key) else { return }
        entry.task.cancel()
    }

    /// 取消某个 key **以及它的子 key** 下的任务（幂等）。
    ///
    /// 为什么需要（S5.4 补，AI 会话片）：一个模块可以有**多条互不相干的在跑任务** ——
    /// 会话列表、消息历史、用量统计、以及一条可能活很久的 SSE 流。它们必须各自可取消
    /// （切会话只该拆掉会话相关的两条），又必须整体可取消（切模块要全拆）。
    ///
    /// 子 key 的写法是 `"\(父 key):\(用途)"`：`run(key:)` 仍按子 key 精确去重
    /// （同一用途重复发起只留最后一次），而外壳切模块时用本方法把 `"\(route id)"`
    /// 整棵树收掉。
    ///
    /// 分隔符用 `:` 是安全的：所有 key 的根都是 route id（`/dashboard/...`），
    /// 路径里不会有冒号，所以「父 key + `:`」不会误匹配到另一条 route id。
    public func cancelTree(key: String) {
        let prefix = key + ":"
        let matched = entries.keys.filter { $0 == key || $0.hasPrefix(prefix) }
        for childKey in matched { cancel(key: childKey) }
    }

    /// 取消全部任务（如登出：会话都不在了，挂着轮询只会 401）。
    public func cancelAll() {
        let running = entries.values
        entries.removeAll()
        for entry in running { entry.task.cancel() }
    }

    private func finish(key: String, token: UUID) {
        // 旧任务的收尾是异步的，可能在 `run` 已经登记了新任务之后才跑到这里：
        // 只清理属于自己那次 run 的登记，否则会把新任务从表里抹掉（假「空」）。
        guard entries[key]?.token == token else { return }
        entries[key] = nil
    }
}
