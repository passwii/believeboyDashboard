import Foundation
import XCTest

@testable import BelieveBoyKit

/// 轮询：退避序列、上限、取消。
///
/// 这里断言的是**算出来的等待序列**（注入 sleeper 记录），不是测试框架的定时器：
/// 「等了 1s、2s、4s 然后到上限」是业务语义，「真等 7 秒」只是它的代价。
final class PollingTests: XCTestCase {

    private func sleeper(
        recording sink: RecordingSink<TimeInterval>,
        throwingAt attempt: Int? = nil
    ) -> PollSleeper {
        // 计数用加锁盒子而不是捕获 var：`PollSleeper` 的闭包是 @Sendable，
        // 捕获可变局部变量在 Swift 6 严格并发下直接编译不过。
        let count = LockedBox(0)
        return PollSleeper { seconds in
            count.mutate { $0 += 1 }
            if let attempt, count.value == attempt {
                throw CancellationError()
            }
            sink.record(seconds)
        }
    }

    // MARK: - 退避序列

    func testDelaySequenceBacksOffAndIsCapped() {
        let policy = PollingPolicy(initialDelay: 1, multiplier: 2, maxDelay: 5, maxAttempts: 10)

        XCTAssertEqual(policy.delay(afterAttempt: 1), 1)
        XCTAssertEqual(policy.delay(afterAttempt: 2), 2)
        XCTAssertEqual(policy.delay(afterAttempt: 3), 4)
        XCTAssertEqual(policy.delay(afterAttempt: 4), 5, "超过 maxDelay 必须夹住")
        XCTAssertEqual(policy.delay(afterAttempt: 40), 5, "再多次也不会无限增长")
    }

    func testDefaultJobPolicyIsBoundedInBothDelayAndAttempts() {
        let policy = PollingPolicy.job

        XCTAssertGreaterThan(policy.maxAttempts, 1)
        XCTAssertLessThanOrEqual(policy.delay(afterAttempt: 100), policy.maxDelay)
        XCTAssertGreaterThan(policy.maxDelay, 0)
    }

    func testInvalidInputsAreNormalisedRatherThanAccepted() {
        let policy = PollingPolicy(initialDelay: -5, multiplier: 0.1, maxDelay: -1, maxAttempts: 0)

        XCTAssertEqual(policy.initialDelay, 0)
        XCTAssertEqual(policy.multiplier, 1, "退避系数小于 1 会越等越短 —— 夹到 1")
        XCTAssertEqual(policy.maxAttempts, 1, "至少探测一次")
        XCTAssertGreaterThanOrEqual(policy.maxDelay, policy.initialDelay)
    }

    // MARK: - 轮询行为

    func testFirstProbeHappensImmediatelyAndFinishesWithoutSleeping() async throws {
        let delays = RecordingSink<TimeInterval>()
        let calls = LockedBox(0)
        let policy = PollingPolicy(initialDelay: 1, multiplier: 2, maxDelay: 10, maxAttempts: 5)

        let value = try await policy.run(sleeper: sleeper(recording: delays)) { _ in
            calls.mutate { $0 += 1 }
            return .finished("done")
        }

        XCTAssertEqual(value, "done")
        XCTAssertEqual(calls.value, 1, "第一次探测不该等待")
        XCTAssertEqual(delays.values, [])
    }

    func testPendingResultsSleepPerBackoffSchedule() async throws {
        let delays = RecordingSink<TimeInterval>()
        let calls = LockedBox(0)
        let policy = PollingPolicy(initialDelay: 1, multiplier: 2, maxDelay: 8, maxAttempts: 10)

        let value = try await policy.run(sleeper: sleeper(recording: delays)) { _ in
            calls.mutate { $0 += 1 }
            return calls.value < 4 ? .pending : .finished("终态")
        }

        XCTAssertEqual(value, "终态")
        XCTAssertEqual(calls.value, 4)
        XCTAssertEqual(delays.values, [1, 2, 4], "第 4 次探测前共睡 1+2+4")
    }

    /// 上限：不得无限打后端。到上限时给出明确错误，而不是把最后一次 `pending` 当结果。
    func testExhaustingAttemptsThrowsPollingTimedOutAfterExactlyMaxAttempts() async {
        let delays = RecordingSink<TimeInterval>()
        let calls = LockedBox(0)
        let policy = PollingPolicy(initialDelay: 1, multiplier: 2, maxDelay: 8, maxAttempts: 3)

        do {
            _ = try await policy.run(sleeper: sleeper(recording: delays)) { _ -> PollOutcome<String> in
                calls.mutate { $0 += 1 }
                return .pending
            }
            XCTFail("永远 pending 必须到上限后抛错")
        } catch let error as APIError {
            XCTAssertEqual(error, .pollingTimedOut(attempts: 3))
            XCTAssertFalse(error.requiresCredentialFix, "超时不是凭据问题")
        } catch {
            XCTFail("期望 APIError，实际 \(error)")
        }

        XCTAssertEqual(calls.value, 3, "恰好探测 maxAttempts 次")
        XCTAssertEqual(delays.values, [1, 2], "最后一次之后不再睡（后面没有探测了）")
    }

    // MARK: - 取消

    func testCancellationDuringSleepStopsPollingAndPropagates() async {
        let delays = RecordingSink<TimeInterval>()
        let calls = LockedBox(0)
        let policy = PollingPolicy(initialDelay: 1, multiplier: 2, maxDelay: 8, maxAttempts: 10)

        do {
            _ = try await policy.run(sleeper: sleeper(recording: delays, throwingAt: 1)) { _ -> PollOutcome<String> in
                calls.mutate { $0 += 1 }
                return .pending
            }
            XCTFail("取消必须抛出")
        } catch is CancellationError {
            // 期望：取消原样向上抛，不被包成 APIError（否则 UI 会显示成「任务失败」）。
        } catch {
            XCTFail("期望 CancellationError，实际 \(error)")
        }

        XCTAssertEqual(calls.value, 1, "取消后不得再探测")
    }

    func testCancellingTheCallingTaskStopsPolling() async {
        let calls = LockedBox(0)
        let policy = PollingPolicy(initialDelay: 30, multiplier: 1, maxDelay: 30, maxAttempts: 10)

        let task = Task {
            try await policy.run { _ -> PollOutcome<String> in
                calls.mutate { $0 += 1 }
                return .pending
            }
        }
        // 让出一次，确保任务已经跑到第一次休眠。
        try? await Task.sleep(for: .milliseconds(50))
        task.cancel()

        do {
            _ = try await task.value
            XCTFail("取消必须抛出")
        } catch is CancellationError {
            // 期望
        } catch {
            XCTFail("期望 CancellationError，实际 \(error)")
        }
        XCTAssertEqual(calls.value, 1, "任务取消后不得继续轮询")
    }

    func testOperationErrorPropagatesUnchanged() async {
        let policy = PollingPolicy(initialDelay: 0, multiplier: 1, maxDelay: 0, maxAttempts: 5)

        do {
            _ = try await policy.run { _ -> PollOutcome<String> in
                throw APIError.unauthorized(status: 403, body: "Invalid API key")
            }
            XCTFail("操作抛错必须向上传播")
        } catch let error as APIError {
            XCTAssertEqual(error, .unauthorized(status: 403, body: "Invalid API key"))
        } catch {
            XCTFail("期望 APIError，实际 \(error)")
        }
    }
}
