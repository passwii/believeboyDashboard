import BelieveBoyKit
import XCTest

/// 矩阵上的「相对量」口径 —— 时区、档位边界、四舍五入三处最容易错的地方。
///
/// 这些全是纯函数并且显式吃 `now` / `timeZone`，就是为了能在这里把边界逐条钉死：
/// 一旦有人把 `Date()` 藏回函数体，这些用例会立刻失效（也就等价于「口径不再可验证」）。
final class AgentOpsFormattingTests: XCTestCase {
    private func date(_ iso: String) -> Date {
        guard let parsed = AgentOpsFormatting.parseISO8601(iso) else {
            XCTFail("测试自身的 ISO 串写错了：\(iso)")
            return Date()
        }
        return parsed
    }

    // MARK: - 美西今天

    /// 关键边界：北京 2026-09-14 07:30 = 美西 2026-09-13 16:30 —— 若按本机时区算
    /// 「今天」，`?date=` 会指向 09-14（后端那天还没有 run / 没有上传记录 → 整列「—」）。
    func testUsTodayUsesLosAngelesNotLocalTimeZone() {
        let beijingMorning = date("2026-09-14T07:30:00+08:00")

        XCTAssertEqual(AgentOpsFormatting.usToday(now: beijingMorning), "2026-09-13")
        XCTAssertNotEqual(
            AgentOpsFormatting.usToday(now: beijingMorning),
            AgentOpsFormatting.usToday(now: beijingMorning, timeZone: TimeZone(identifier: "Asia/Shanghai")!),
            "美西与北京在这条边界上必须给出不同的日期，否则用例没测到东西"
        )
    }

    func testUsTodayRollsOverAtLosAngelesMidnight() {
        // 美西 2026-09-13 23:59 与 2026-09-14 00:01
        XCTAssertEqual(AgentOpsFormatting.usToday(now: date("2026-09-14T06:59:00Z")), "2026-09-13")
        XCTAssertEqual(AgentOpsFormatting.usToday(now: date("2026-09-14T07:01:00Z")), "2026-09-14")
    }

    /// 输出必须是后端能吃的 `YYYY-MM-DD`（不能本地化成 `2026/09/14`）。
    func testUsTodayIsIsoDateShape() {
        let value = AgentOpsFormatting.usToday(now: date("2026-01-05T20:00:00Z"))
        XCTAssertEqual(value, "2026-01-05")
        XCTAssertEqual(value.count, 10)
        XCTAssertFalse(value.contains("/"))
    }

    // MARK: - ISO 解析

    /// 后端真实形态：6 位小数秒 + `+08:00` 偏移 / `Z`，两种都要认。
    func testParsesBackendTimestampShapes() {
        XCTAssertNotNil(AgentOpsFormatting.parseISO8601("2026-09-11T18:31:32.647904+08:00"))
        XCTAssertNotNil(AgentOpsFormatting.parseISO8601("2026-09-14T08:31:33.689918Z"))
        XCTAssertNotNil(AgentOpsFormatting.parseISO8601("2026-09-11T18:31:32+08:00"))
        XCTAssertEqual(
            AgentOpsFormatting.parseISO8601("2026-09-11T18:31:32.647904+08:00"),
            AgentOpsFormatting.parseISO8601("2026-09-11T10:31:32.647904Z"),
            "偏移量必须被算进去（同一时刻的不同写法）"
        )
    }

    func testRejectsMissingOrUnparsableTimestamps() {
        XCTAssertNil(AgentOpsFormatting.parseISO8601(nil))
        XCTAssertNil(AgentOpsFormatting.parseISO8601(""))
        XCTAssertNil(AgentOpsFormatting.parseISO8601("   "))
        XCTAssertNil(AgentOpsFormatting.parseISO8601("not-a-time"))
    }

    // MARK: - 新鲜度

    func testFreshnessBuckets() {
        let now = date("2026-09-14T00:00:00Z")

        XCTAssertEqual(
            AgentOpsFormatting.freshness(lastActiveAt: "2026-09-13T12:00:00Z", now: now),
            .green
        )
        // 边界：正好 24h → 黄（`< 24` 才算绿）
        XCTAssertEqual(
            AgentOpsFormatting.freshness(lastActiveAt: "2026-09-13T00:00:00Z", now: now),
            .yellow
        )
        XCTAssertEqual(
            AgentOpsFormatting.freshness(lastActiveAt: "2026-09-08T01:00:00Z", now: now),
            .yellow
        )
        // 边界：正好 7 天 → 灰（`< 7*24` 才算黄）
        XCTAssertEqual(
            AgentOpsFormatting.freshness(lastActiveAt: "2026-09-07T00:00:00Z", now: now),
            .grey
        )
        XCTAssertEqual(AgentOpsFormatting.freshness(lastActiveAt: nil, now: now), .grey)
        XCTAssertEqual(AgentOpsFormatting.freshness(lastActiveAt: "bad", now: now), .grey)
    }

    // MARK: - 相对时间

    func testRelativeTimeBranches() {
        let now = date("2026-09-14T12:00:00Z")

        XCTAssertEqual(AgentOpsFormatting.relativeTime(lastActiveAt: "2026-09-14T11:59:30Z", now: now), "刚刚")
        XCTAssertEqual(AgentOpsFormatting.relativeTime(lastActiveAt: "2026-09-14T11:15:00Z", now: now), "45 分钟前")
        XCTAssertEqual(AgentOpsFormatting.relativeTime(lastActiveAt: "2026-09-14T07:00:00Z", now: now), "5 小时前")
        XCTAssertEqual(AgentOpsFormatting.relativeTime(lastActiveAt: "2026-09-11T12:00:00Z", now: now), "3 天前")
        XCTAssertEqual(AgentOpsFormatting.relativeTime(lastActiveAt: nil, now: now), "从未")
        XCTAssertEqual(AgentOpsFormatting.relativeTime(lastActiveAt: "bad", now: now), "从未")
    }

    /// 超过 30 天退回 `M/D`（Web 的最后一段），用系统时区取月/日。
    func testRelativeTimeFallsBackToMonthDay() {
        let now = date("2026-09-14T12:00:00Z")
        let timeZone = TimeZone(identifier: "Asia/Shanghai")!

        XCTAssertEqual(
            AgentOpsFormatting.relativeTime(
                lastActiveAt: "2026-07-04T10:00:00+08:00",
                now: now,
                timeZone: timeZone
            ),
            "7/4"
        )
    }

    /// 未来时间戳（时钟漂移）在 Web 上落进「< 1 分钟」分支 → 刚刚；桌面端同口径。
    func testRelativeTimeTreatsFutureAsJustNow() {
        let now = date("2026-09-14T12:00:00Z")
        XCTAssertEqual(AgentOpsFormatting.relativeTime(lastActiveAt: "2026-09-14T12:05:00Z", now: now), "刚刚")
    }

    // MARK: - 错误率

    /// 与 Web `Math.round` 同口径：38/353 = 10.76% → 11%。
    func testErrorRateRoundsLikeWeb() {
        XCTAssertEqual(AgentOpsFormatting.errorRateText(errors7d: 38, calls7d: 353), "11%")
        XCTAssertEqual(AgentOpsFormatting.errorRateText(errors7d: 0, calls7d: 100), "0%")
        XCTAssertEqual(AgentOpsFormatting.errorRateText(errors7d: 1, calls7d: 3), "33%")
        XCTAssertEqual(AgentOpsFormatting.errorRateText(errors7d: 2, calls7d: 3), "67%")
    }

    /// 无调用 → 占位「—」（不是 `0%`：那会把「没数据」说成「零错误」）。
    func testErrorRatePlaceholderWhenNoCalls() {
        XCTAssertEqual(AgentOpsFormatting.errorRateText(errors7d: 0, calls7d: 0), "—")
        XCTAssertEqual(AgentOpsFormatting.errorRateText(errors7d: 5, calls7d: 0), "—")
    }

    // MARK: - 绝对时间与时刻

    func testAbsoluteTimeIsStableAndUnlocalized() {
        let value = AgentOpsFormatting.absoluteTime(
            lastActiveAt: "2026-09-11T18:31:32.647904+08:00",
            timeZone: TimeZone(identifier: "Asia/Shanghai")!
        )
        XCTAssertEqual(value, "2026-09-11 18:31:32")
        XCTAssertEqual(
            AgentOpsFormatting.absoluteTime(lastActiveAt: nil, timeZone: TimeZone(identifier: "Asia/Shanghai")!),
            "从未活动"
        )
    }

    func testClockTimeIsZeroPadded() {
        let value = AgentOpsFormatting.clockTime(
            date("2026-09-14T01:02:03Z"),
            timeZone: TimeZone(identifier: "UTC")!
        )
        XCTAssertEqual(value, "01:02:03")
    }
}
