import Foundation

/// 长任务轮询的退避策略。
///
/// 后端的 `/api/v1/jobs` 是「入队 + 轮询」模型（`backend/app/api/v1/endpoints/jobs.py`）：
/// 建任务立刻返回 `pending`，后端 worker 跑完才有终态。客户端唯一的进度来源是轮询，
/// 所以**必须有上限与退避**：
///
/// - 固定间隔（如 1s 死循环）会在任务卡住时变成对后端的持续压力，且用户永远等下去；
/// - 本地计数器与后端状态不同步时，无限轮询会把「任务失败」伪装成「还在跑」。
///
/// 语义：**第一次探测立即发生**，之后按 `delay(afterAttempt:)` 睡觉。
public struct PollingPolicy: Sendable, Equatable {
    /// 第一次等待的时长。
    public let initialDelay: TimeInterval
    /// 每次等待的放大系数（≥ 1）。
    public let multiplier: Double
    /// 单次等待上限 —— 退避不能无限涨，否则「等 10 分钟才有下一次探测」比不做还糟。
    public let maxDelay: TimeInterval
    /// 探测次数上限（含第一次）。
    public let maxAttempts: Int

    public init(
        initialDelay: TimeInterval = 1,
        multiplier: Double = 1.5,
        maxDelay: TimeInterval = 10,
        maxAttempts: Int = 40
    ) {
        self.initialDelay = max(0, initialDelay)
        self.multiplier = max(1, multiplier)
        self.maxDelay = max(self.initialDelay, maxDelay)
        self.maxAttempts = max(1, maxAttempts)
    }

    /// 长任务默认档：1s 起、×1.5、单次最多 10s、最多 40 次。
    ///
    /// 上限换算成时间是「约 5 分半」，比后端 worker 的常规耗时（分钟级）宽，
    /// 又不至于让用户面对一个永远转圈的界面。
    public static let job = PollingPolicy()

    /// 第 `attempt` 次探测（1 起）之后应等待的时长。
    ///
    /// `initialDelay * multiplier^(attempt-1)`，再夹到 `maxDelay`。
    public func delay(afterAttempt attempt: Int) -> TimeInterval {
        guard attempt >= 1 else { return initialDelay }
        var delay = initialDelay
        for _ in 1..<attempt {
            delay *= multiplier
            if delay >= maxDelay { return maxDelay }
        }
        return min(delay, maxDelay)
    }
}

/// 一次探测的结果。
public enum PollOutcome<Value: Sendable>: Sendable {
    /// 到达终态 / 拿到目标值，停止轮询。
    case finished(Value)
    /// 还没好，按策略等待后再探测。
    case pending
}

/// 睡觉的注入点。
///
/// 单测不能真等（40 次 × 1.5 倍退避 = 真实等待几分钟），但「等待序列」恰恰是要断言的
/// 东西。把「怎么睡」抽出来，测试就能立刻返回并记录每次请求的时长 —— 断言的是
/// **策略算出来的等待序列**，不是测试框架的定时器。
public struct PollSleeper: Sendable {
    public let sleep: @Sendable (TimeInterval) async throws -> Void

    public init(_ sleep: @escaping @Sendable (TimeInterval) async throws -> Void) {
        self.sleep = sleep
    }

    /// 生产实现：`Task.sleep`，且**可取消**（取消时抛 `CancellationError`，
    /// 由 `poll` 原样向上抛，而不是被包成 `APIError`）。
    public static let task = PollSleeper { seconds in
        try await Task.sleep(for: .seconds(seconds))
    }
}

public extension PollingPolicy {

    /// 按策略轮询到 `operation` 返回 `.finished`。
    ///
    /// 取消语义：调用任务被取消 → `Task.checkCancellation()` 或 `Task.sleep` 抛
    /// `CancellationError` → 轮询立刻停止（不会多探一次、也不会吞掉取消）。
    ///
    /// 达到 `maxAttempts` 仍未终态 → `APIError.pollingTimedOut`（明确「我们不再等」，
    /// 而不是把最后一次的 `pending` 当成结果）。
    func run<Value: Sendable>(
        sleeper: PollSleeper = .task,
        operation: @Sendable (Int) async throws -> PollOutcome<Value>
    ) async throws -> Value {
        var attempt = 0
        while true {
            try Task.checkCancellation()
            attempt += 1

            switch try await operation(attempt) {
            case .finished(let value):
                return value
            case .pending:
                if attempt >= maxAttempts {
                    throw APIError.pollingTimedOut(attempts: attempt)
                }
                try await sleeper.sleep(delay(afterAttempt: attempt))
            }
        }
    }
}
