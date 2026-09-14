import BelieveBoyKit
import Foundation
import Observation

/// 「观察一条 canonical run」的视图状态（`/insight/runs/{run_id}` + `/{run_id}/stream`）。
///
/// 供「AI 广告分析」与「AI 库存健康」两页共用（同一份底座、换一份文案表）。
///
/// **为什么是「按 run id 观察」而不是「run 列表」**：canonical 侧**只有**
/// `POST /insight/runs`（建）/ `GET /insight/runs/{id}`（读）/ `/{id}/stream` /
/// `cancel` / `retry` —— **没有 list 端点**（`backend/app/api/v1/endpoints/insight_runs.py`
/// 全量路由就这些）。而本批不做写链路（§口径 4），因此「列表」这一侧只能由旧链路的
/// `/ai-insights?insight_type=…` 承担，「canonical run 明细 + 流式」则由用户给出的
/// run id 进入。Web 侧的 run id 来自台账行的 `insight_run_id`（`ledger-insight.ts`），
/// 桌面端本批还没有台账页，故用显式输入框 —— 这是**如实**的入口，不是把「不可达」藏起来。
///
/// 三条口径的落点：
///
/// 1. **游标续传是真的**（§口径 2）：帧上的 `id: {run_id}:{attempt}:{seq}` 记进
///    `InsightCursorTracker`，断线重连时作为 `Last-Event-ID` 回传，并按 `id` 去重 ——
///    不把「重连即重放全量」当续传。
/// 2. **detail 是权威**（后端注释原话：Page reopen / SSE expiry / post-completion）：
///    订阅前先取一次 detail，终态后（或流接不上时）再取一次，把状态与正文定住。
/// 3. **取消不落错误态**：切模块 / 换 run id 会取消整条观察链，被取消的任务在写入前判 token。
@MainActor
@Observable
public final class CanonicalRunStore {
    public typealias Phase = AdLoadPhase

    /// 观察链的流状态。
    public struct RunStream: Equatable {
        public var transport: InsightTransportState = .connecting
        /// 当前正文（`content.delta` 累积 / `content.snapshot` / `done.outputs` 覆盖）。
        public var content: String = ""
        /// 当前正文是草稿还是终态正文（决定尾部是否按纯文本呈现）。
        public var contentState: InsightContentStateAdapter = .draft
        /// 断线重连次数。
        public var reconnects: Int = 0
        /// 收到的**事件类型序列**（`snapshot` / `status` / `content.delta` / `done` …）——
        /// 这是跨端漂移防护里与 Web 对齐的那一条（§口径 1 的第 ② 项）。
        public var eventTypes: [String] = []
        /// 最近一次帧上的 `id:`（下次重连的 `Last-Event-ID`）。
        public var lastEventID: String?
        /// 已去重的游标数。
        public var seenCount: Int = 0
        public var errorMessage: String?
        public var isFinished: Bool = false

        public init() {}
    }

    /// 视图 `.task(id:)` 的驱动键。
    public struct WatchKey: Equatable, Sendable {
        public let runID: String?
        public let ticket: Int
    }

    /// 页面归属（决定文案表与输出槽；数值口径两域都是「`progress_percent` 直通」）。
    public let domain: InsightPanelDomain

    /// 输入框里的 run id（未提交）。
    public private(set) var runIDInput = ""
    /// 已提交正在观察的 run id。
    public private(set) var runID: String?
    public private(set) var watchTicket = 0
    public private(set) var detailPhase: Phase = .idle
    public private(set) var detail: InsightRunDetail?
    public private(set) var stream = RunStream()
    /// 输入校验失败 / 未提交时的提示（不是请求错误）。
    public private(set) var inputNotice: String?

    private var watchToken: UUID?
    private let reconnectDelay: Duration
    private let maxReconnects: Int

    public init(
        domain: InsightPanelDomain,
        reconnectDelay: Duration = .milliseconds(1500),
        maxReconnects: Int = 3
    ) {
        self.domain = domain
        self.reconnectDelay = reconnectDelay
        self.maxReconnects = maxReconnects
    }

    // MARK: - 派生

    public var watchKey: WatchKey { WatchKey(runID: runID, ticket: watchTicket) }

    /// 面板状态（canonical 口径）。
    public var panel: InsightPanelState {
        InsightPanelMapping.canonical(
            runStatus: detail?.status,
            transport: stream.transport,
            progress: detail?.progressPercent,
            domain: domain
        )
    }

    /// 当前要展示的正文：流式正文优先，其次 detail 的输出槽。
    public var content: String {
        if !stream.content.isEmpty { return stream.content }
        return detail.map { $0.content() } ?? ""
    }

    public var contentState: InsightContentStateAdapter {
        if detail?.isTerminal == true, stream.isFinished { return .final }
        return stream.contentState
    }

    /// 内容摘要（`done.content_sha256` 或 detail 输出槽的 digest）。
    public var digest: String? {
        detail?.outputs[InsightRunDetail.defaultSlot]?.contentSha256
    }

    /// 明细里的 typed error 文案（`error.message`）。
    public var detailErrorMessage: String? { detail?.error?.message }

    // MARK: - 命令

    /// 输入框回调（视图无 `@State`，输入值住在 store）。
    public func setRunIDInput(_ value: String) {
        guard runIDInput != value else { return }
        runIDInput = value
        inputNotice = nil
    }

    /// 提交观察：校验成 UUID 才接受（后端路径参数是 `UUID`，非 UUID 直接 422）。
    public func submit() {
        let trimmed = runIDInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            inputNotice = "请先填入要观察的 run id（UUID）。"
            return
        }
        guard UUID(uuidString: trimmed) != nil else {
            inputNotice = "run id 必须是 UUID（后端路径参数按 `UUID` 解析，否则 422）。"
            return
        }
        guard runID != trimmed else {
            watchTicket += 1
            return
        }
        runID = trimmed
        watchTicket += 1
        detail = nil
        detailPhase = .idle
        stream = RunStream()
        inputNotice = nil
    }

    /// 停止观察（清空选中；已跑的服务端 run 不受影响）。
    public func clear() {
        runID = nil
        runIDInput = ""
        inputNotice = nil
        detail = nil
        detailPhase = .idle
        stream = RunStream()
        watchTicket += 1
    }

    /// 没有可用凭据时的失败态（不发请求）。
    public func failWithoutCredential() {
        detailPhase = .failed("尚未登录，无法读取 Insight run。")
    }

    // MARK: - 观察

    public func watch(
        using provider: InsightDataProviding,
        scope: ModuleTaskScope,
        key: String
    ) async {
        guard let runID else { return }
        await scope.run(key: key) { [weak self] in
            await self?.performWatch(runID: runID, using: provider)
        }.value
    }

    func performWatch(runID: String, using provider: InsightDataProviding) async {
        let token = UUID()
        watchToken = token
        detailPhase = .loading

        let outcome = await Self.capture { try await provider.runDetail(runID: runID) }
        guard isCurrent(token) else { return abandonDetail() }
        switch outcome {
        case .success(let payload):
            detail = payload
            detailPhase = .loaded
            stream = RunStream()
            stream.content = payload.content()
            stream.contentState = payload.isTerminal ? .final : .draft
            stream.isFinished = payload.isTerminal
            stream.transport = payload.isTerminal ? .live : .connecting
        case .failure(let message):
            detailPhase = .failed(message)
            return
        }

        guard detail?.isTerminal == false else { return }
        await consumeStream(runID: runID, using: provider, token: token)
    }

    /// 消费一条 canonical 流：游标续传 + 按 `id` 去重 + 断线重连（有上限）。
    private func consumeStream(
        runID: String,
        using provider: InsightDataProviding,
        token: UUID
    ) async {
        var tracker = InsightCursorTracker()
        var attempt = 0

        while isCurrent(token), !Task.isCancelled, !stream.isFinished {
            stream.transport = attempt == 0 ? .live : .reconnecting
            var terminalSeen = false

            do {
                for try await frame in provider.runStream(
                    runID: runID,
                    lastEventID: tracker.lastEventID
                ) {
                    try Task.checkCancellation()
                    guard isCurrent(token) else { return }
                    // 游标登记 + 去重：续传可能重放已见帧（后端按 `(attempt, seq)` 过滤，
                    // 但检查点 / 快照帧仍可能重复），按 `id` 去重是客户端这一侧的责任。
                    guard tracker.accept(eventID: frame.id) else { continue }
                    stream.lastEventID = tracker.lastEventID
                    stream.seenCount = tracker.seenCount

                    guard let event = try? frame.decode(InsightRunEvent.self) else { continue }
                    // 帧无 `id:` 时用信封字段补记（同一份规范，见 `InsightEventCursor`）。
                    if frame.id == nil {
                        stream.lastEventID = InsightEventCursor(event: event).wireValue
                    }
                    stream.eventTypes.append(event.type)
                    apply(event: event)
                    if event.isTerminalEvent {
                        terminalSeen = true
                        break
                    }
                }
            } catch is CancellationError {
                return
            } catch {
                // 断流：交给下面的重连策略（**不**把 run 判成失败 —— run 由后端继续跑）。
                if !isCurrent(token) { return }
            }

            guard isCurrent(token) else { return }

            if terminalSeen || stream.isFinished {
                await refreshSnapshot(runID: runID, using: provider, token: token)
                return
            }

            attempt += 1
            stream.reconnects = attempt
            if attempt > maxReconnects {
                stream.errorMessage =
                    "生成流已断开且重连 \(attempt - 1) 次未成功；run 仍在后端运行，可稍后刷新查看。"
                await refreshSnapshot(runID: runID, using: provider, token: token)
                return
            }
            // 带游标重连：`tracker.lastEventID` 即 `Last-Event-ID`（后端据此从断点续传）。
            try? await Task.sleep(for: reconnectDelay)
        }
    }

    /// 把一帧 canonical 事件应用到面板（正文 / 状态 / 终态）。
    private func apply(event: InsightRunEvent) {
        if let text = event.textContent() {
            switch event.type {
            case InsightEventType.contentDelta:
                stream.content += text
                stream.contentState = .draft
            default:
                // 快照 / done 是权威全量，直接覆盖（免得把半截增量留在正文里）。
                stream.content = text
            }
        }

        switch event.type {
        case InsightEventType.done, InsightEventType.error:
            stream.isFinished = true
            stream.contentState = .final
            stream.transport = .live
            if let error = event.error { stream.errorMessage = error.message }
        case InsightEventType.snapshot:
            if event.isTerminal == true {
                stream.isFinished = true
                stream.contentState = .final
                stream.transport = .live
            }
        default:
            break
        }

        if stream.errorMessage == nil, let error = event.error {
            stream.errorMessage = error.message
        }
    }

    /// 回读 detail 权威快照（订阅前 / 终态后 / 流接不上时）。
    private func refreshSnapshot(
        runID: String,
        using provider: InsightDataProviding,
        token: UUID
    ) async {
        let outcome = await Self.capture { try await provider.runDetail(runID: runID) }
        guard isCurrent(token) else { return }
        guard case .success(let payload) = outcome else { return }
        detail = payload
        detailPhase = .loaded
        if payload.isTerminal {
            stream.isFinished = true
            stream.transport = .live
            stream.contentState = .final
            let authoritative = payload.content()
            if !authoritative.isEmpty { stream.content = authoritative }
        }
    }

    // MARK: - 取消归位

    private func isCurrent(_ token: UUID) -> Bool {
        watchToken == token && !Task.isCancelled
    }

    private func abandonDetail() {
        guard detailPhase.isLoading else { return }
        detailPhase = .idle
    }

    // MARK: - 工具

    enum LoadOutcome<Value: Sendable>: Sendable {
        case success(Value)
        case failure(String)
    }

    static func message(for error: Error) -> String {
        if let apiError = error as? APIError { return apiError.displayMessage }
        return error.localizedDescription
    }

    private static func capture<T: Sendable>(
        _ operation: @Sendable () async throws -> T
    ) async -> LoadOutcome<T> {
        do {
            return .success(try await operation())
        } catch {
            return .failure(message(for: error))
        }
    }
}
