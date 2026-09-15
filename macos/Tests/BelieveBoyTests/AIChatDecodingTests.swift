import BelieveBoyKit
import Foundation
import XCTest

@testable import BelieveBoyUI

/// 「AI 会话片」的解码与纯逻辑口径：真实快照 → 模型 → 事件序列 → 累加器 → Markdown 切分。
///
/// 这一层回答三个问题：
/// 1. **后端吐的键名，解码器认得吗** —— 拿真响应断言（不是自己编的 JSON）；
/// 2. **事件序列折出来的草稿对不对** —— `id:` 游标、增量拼接、终态判定；
/// 3. **两端拼接规则是否一字不差** —— prompt 预设 / 场景 system prompt / user content
///    （这三份逻辑在 Web 里有第二份实现，漂移了用户看到的就是两种结果）。
final class AIChatDecodingTests: XCTestCase {

    // MARK: - 快照完整性（sha256 与 manifest 对账）

    /// 提交进仓库的快照必须与 `manifest.json` 记录的哈希一致 —— 快照不许悄悄换。
    func testCommittedSnapshotHashesMatchManifest() throws {
        let manifest = try AIChatFixtures.manifest()
        XCTAssertFalse(manifest.files.isEmpty)
        for file in manifest.files {
            let data = try AIChatFixtures.data(fileName: file.file)
            XCTAssertEqual(data.count, file.bytes, "\(file.file) 字节数与 manifest 不一致")
            XCTAssertEqual(
                AIChatFixtures.sha256(of: data),
                file.sha256,
                "\(file.file) 的 sha256 与 manifest 不一致（重抓后要同步 manifest 并在 PR 写明）"
            )
        }
    }

    // MARK: - 配置（端点 1）

    func testConfigSnapshotDecodesShape() throws {
        let config = try AIChatFixtures.config()

        // 抓取环境没有配置 provider —— 这正是要钉住的一条契约：**未配置是合法状态**，
        // 且此时 `models` / `default_model` 会是空的（UI 必须据此提示，而不是发一个必然失败的请求）。
        XCTAssertFalse(config.providerConfigured)
        XCTAssertFalse(config.webSearchConfigured)
        XCTAssertTrue(config.models.isEmpty)
        XCTAssertTrue(config.defaultModel.isEmpty)
        XCTAssertEqual(config.defaultReasoningEffort, "medium")
        XCTAssertEqual(config.timeoutSeconds, 90)
        XCTAssertEqual(config.maxConversationTurns, 10)
        XCTAssertEqual(config.webSearchMaxResults, 20)
    }

    // MARK: - 会话列表（端点 2）

    func testConversationSnapshotDecodesShape() throws {
        let conversations = try AIChatFixtures.conversations()
        let manifest = try AIChatFixtures.manifest()
        XCTAssertFalse(conversations.isEmpty, "夹具账号应当至少有一个会话")

        for conversation in conversations {
            XCTAssertGreaterThan(conversation.id, 0)
            XCTAssertFalse(conversation.title.isEmpty)
            // 时间戳保持字符串（Pydantic 的 ISO8601 带 offset / 小数秒，解成 Date 会崩）。
            XCTAssertNotNil(AgentOpsFormatting.parseISO8601(conversation.createdAt))
            XCTAssertNotNil(AgentOpsFormatting.parseISO8601(conversation.updatedAt))
            XCTAssertGreaterThanOrEqual(conversation.totalTokens, 0)
        }
        // 夹具里那条会话就是脚本插入的那条（同一账号、可核对）。
        XCTAssertEqual(conversations.first?.id, manifest.params.conversationID)
        XCTAssertEqual(conversations.first?.title, manifest.params.conversationTitle)
    }

    /// **跨端可见性**的静态一半：夹具账号的会话列表与消息历史来自同一个 `user_id`
    /// （动态一半在 `AIChatStoreTests` 与 `AIChatClientTests` 里，断言请求真的带 `X-User-Id`）。
    func testFixtureConversationAndMessagesShareOneAccount() throws {
        let manifest = try AIChatFixtures.manifest()
        let conversations = try AIChatFixtures.conversations()
        let messages = try AIChatFixtures.messages()

        XCTAssertGreaterThan(manifest.params.userID, 0)
        XCTAssertTrue(
            conversations.contains { $0.id == manifest.params.conversationID },
            "会话列表里必须有夹具会话 —— 否则「同账号可见」无从断言"
        )
        XCTAssertTrue(messages.allSatisfy { $0.conversationId == manifest.params.conversationID })
    }

    // MARK: - 消息历史（端点 6）

    func testMessageSnapshotDecodesShapeAndSearchSources() throws {
        let messages = try AIChatFixtures.messages()
        XCTAssertFalse(messages.isEmpty)

        let roles = Set(messages.map(\.role))
        XCTAssertTrue(roles.contains("user"))
        XCTAssertTrue(roles.contains("assistant"))

        for message in messages {
            XCTAssertGreaterThan(message.id, 0)
            XCTAssertFalse(message.content.isEmpty)
            XCTAssertGreaterThanOrEqual(message.promptTokens, 0)
            XCTAssertGreaterThanOrEqual(message.completionTokens, 0)
            XCTAssertGreaterThanOrEqual(message.totalTokens, 0)
            XCTAssertNotNil(AgentOpsFormatting.parseISO8601(message.createdAt))
            // `search_sources` 是 `list[dict]`，空列表与有内容都合法 —— 但绝不能解成 nil。
            XCTAssertFalse(message.searchSources.isEmpty == false && message.content.isEmpty)
        }

        // 至少一条消息带来源卡片：`title/url/snippet/domain/score` 五个键都要读到值。
        let withSources = try XCTUnwrap(
            messages.first { !$0.searchSources.isEmpty },
            "夹具必须覆盖 search_sources（否则「声明宽实际窄」的宽容解码没被验证）"
        )
        let source = try XCTUnwrap(withSources.searchSources.first)
        XCTAssertNotNil(source.title)
        XCTAssertNotNil(source.url)
        XCTAssertNotNil(source.snippet)
        XCTAssertNotNil(source.domain)
        XCTAssertNotNil(source.score, "score 是数字，不能读成 nil")
        XCTAssertFalse(source.displayTitle.isEmpty)
    }

    /// 宽容解码的两条判据：`score` 是数字、其余是字符串；形状漂移（数字出现在文本位、
    /// 文本出现在数字位）不致命 —— 一条来源坏掉不该让整段历史解不开。
    func testSearchSourceDecodingIsLenient() throws {
        let payload = """
        [
          {"title": 123, "score": "0.5", "url": null},
          {"domain": "example.com"}
        ]
        """
        let sources = try AIChatFixtures.apiDecoder().decode(
            [AIChatSearchSource].self,
            from: Data(payload.utf8)
        )
        XCTAssertEqual(sources.count, 2)
        XCTAssertEqual(sources[0].title, "123", "数字出现在文本位要能读出来")
        XCTAssertEqual(sources[0].score, 0.5, "字符串数字要能读成 Double")
        XCTAssertNil(sources[0].url)
        XCTAssertEqual(sources[1].displayTitle, "example.com", "无标题时退回域名")
    }

    // MARK: - token 用量（端点 12）

    func testUsageStatsSnapshotDecodesShape() throws {
        let stats = try AIChatFixtures.usageStats()
        let manifest = try AIChatFixtures.manifest()

        XCTAssertEqual(stats.range, manifest.params.usageRange)
        XCTAssertEqual(stats.rangeOption?.rawValue, manifest.params.usageRange)
        XCTAssertNotNil(AgentOpsFormatting.parseISO8601(stats.startDate + "T00:00:00Z"))
        XCTAssertNotNil(AgentOpsFormatting.parseISO8601(stats.endDate + "T00:00:00Z"))
        // 30d 档必须补满 30 行（后端「缺失日期补 0」，前端可拉直时间轴）。
        XCTAssertEqual(stats.daily.count, 30)
        XCTAssertEqual(stats.daily.first?.date, stats.startDate)
        XCTAssertEqual(stats.daily.last?.date, stats.endDate)
        // 物化表为空时是「全 0 + by_model 空」，不是错误。
        XCTAssertEqual(stats.totals.totalTokens, stats.daily.reduce(0) { $0 + $1.totalTokens })
    }

    // MARK: - 流事件序列（端点 9）

    /// 事件类型序列 + `id:` 游标 + JSON 键名，一次钉死。
    func testStreamTurnEventSequenceFromSnapshot() throws {
        let frames = AIChatFixtures.parse(frames: try AIChatFixtures.streamTurn())
        XCTAssertGreaterThan(frames.count, 5)

        // 每一帧都带 `id:`（Redis Stream entry id），且形如 `<ms>-<seq>`。
        for frame in frames where frame.id != nil {
            let parts = try XCTUnwrap(frame.id).split(separator: "-")
            XCTAssertEqual(parts.count, 2, "游标形状是 <ms>-<seq>：\(frame.id ?? "")")
            XCTAssertNotNil(Int(parts[0]))
            XCTAssertNotNil(Int(parts[1]))
        }

        let events = AIChatFixtures.decodedStreamEvents(try AIChatFixtures.streamTurn())
        let kinds = events.map(\.kind)

        XCTAssertEqual(kinds.first, "message_start")
        XCTAssertEqual(kinds.last, "done")
        XCTAssertTrue(kinds.contains("content_block_start"))
        XCTAssertTrue(kinds.contains("content_block_stop"))
        XCTAssertTrue(kinds.contains("message_delta"))
        XCTAssertTrue(kinds.contains("message_stop"))
        XCTAssertTrue(kinds.contains("ping"))
        XCTAssertFalse(kinds.contains(""), "不该有解不开的帧：\(kinds)")
        XCTAssertEqual(events.filter { $0.kind == "message_start" }.count, 1)
        XCTAssertEqual(events.filter { $0.kind == "done" }.count, 1)
        // `message_stop` 之后只剩 `ping` 与 `done`。
        let stopIndex = try XCTUnwrap(kinds.firstIndex(of: "message_stop"))
        XCTAssertTrue(
            kinds[(stopIndex + 1)...].allSatisfy { $0 == "ping" || $0 == "done" },
            "message_stop 之后的序列：\(kinds[(stopIndex + 1)...])"
        )
    }

    /// 累计器：增量拼回原文、用量取 `done` 的权威值、终态判定、未知事件不静默丢。
    func testAccumulatorRebuildsDraftFromSnapshot() throws {
        let events = AIChatFixtures.decodedStreamEvents(try AIChatFixtures.streamTurn())
        var accumulator = AIChatTurnAccumulator()
        for (index, event) in events.enumerated() {
            let frame = AIChatFixtures.parse(frames: try AIChatFixtures.streamTurn())[index]
            accumulator.apply(event, lastEventID: frame.id)
        }

        XCTAssertEqual(accumulator.outcome, .completed)
        XCTAssertFalse(accumulator.text.isEmpty, "text_delta 拼出来的正文不该是空")
        XCTAssertNotNil(accumulator.messageID)
        XCTAssertEqual(accumulator.model, "capture")
        XCTAssertNotNil(accumulator.lastEventID, "续传游标要留下来")
        XCTAssertEqual(accumulator.toolCallCount, 0)
        XCTAssertFalse(accumulator.isSearching)
        XCTAssertTrue(accumulator.unknownEventTypes.isEmpty)

        // `done` 载荷里的两条消息来自真实 `ai_messages` 行 —— 与消息历史快照对得上。
        let done = try XCTUnwrap(accumulator.done)
        let messages = try AIChatFixtures.messages()
        XCTAssertEqual(done.assistantMessage?.id, messages.first { $0.isAssistant }?.id)
        XCTAssertEqual(done.userMessage?.id, messages.first { $0.isUser }?.id)
        XCTAssertEqual(done.assistantMessage?.content, accumulator.text, "增量拼起来必须等于落库正文")
        XCTAssertEqual(accumulator.conversationTitle, try AIChatFixtures.manifest().params.conversationTitle)
        XCTAssertFalse(accumulator.sources.isEmpty, "来源卡片只从 done 载荷来")
    }

    /// 续传帧：`message_stop` 之后**没有** `done`（`_resume_stream` 不合成）——
    /// 这条合法路径必须落成 `stoppedWithoutDone`，不能报错。
    func testResumeFramesWithoutDoneAreLegitimate() throws {
        let events = AIChatFixtures.decodedStreamEvents(try AIChatFixtures.streamResume())
        XCTAssertEqual(events.map(\.kind), ["content_block_delta", "message_stop"])

        var accumulator = AIChatTurnAccumulator()
        for event in events { accumulator.apply(event) }
        XCTAssertEqual(accumulator.outcome, .stoppedWithoutDone)
        XCTAssertEqual(accumulator.text, "（续传补上的尾段）")
        XCTAssertNil(accumulator.done)
    }

    /// `error` 事件 → `.failed`，文案里带后端的 message 与 code。
    func testErrorEventBecomesFailure() throws {
        let events = AIChatFixtures.decodedStreamEvents(try AIChatFixtures.streamError())
        XCTAssertEqual(events.count, 1)

        var accumulator = AIChatTurnAccumulator()
        for event in events { accumulator.apply(event) }
        guard case .failed(let message) = accumulator.outcome else {
            return XCTFail("应当是失败态，实际 \(accumulator.outcome)")
        }
        XCTAssertTrue(message.contains("请求过于频繁"))
        XCTAssertTrue(message.contains("rate_limit"))
    }

    /// 未知事件类型记账而不是解码报错（后端加事件类型时桌面端要看得见，不能表现成卡住）。
    func testUnknownEventTypeIsRecordedNotFatal() {
        var accumulator = AIChatTurnAccumulator()
        accumulator.apply(.unknown(type: "content_block_annotate"))
        accumulator.apply(.unknown(type: "content_block_annotate"))
        XCTAssertEqual(accumulator.unknownEventTypes, ["content_block_annotate"])
        XCTAssertEqual(accumulator.outcome, .running)
        XCTAssertNil(accumulator.errorMessage)
    }

    /// 终态（`done` / `error`）之后到来的帧只记账、不改状态（重连会重放旧帧）。
    ///
    /// 注意终态**不是** `message_stop`：项目的 `done` 扩展跟在它后面（见
    /// `testStreamTurnEventSequenceFromSnapshot` 里的顺序断言）—— 把 `message_stop` 当终态
    /// 会把 `done` 连同里面的用量、消息 id、标题一并丢掉（本批实测踩到过）。
    func testFramesAfterTerminalAreIgnored() {
        var accumulator = AIChatTurnAccumulator()
        accumulator.apply(.done(AIChatStreamDone(conversationTitle: "完成")))
        XCTAssertEqual(accumulator.outcome, .completed)
        XCTAssertTrue(accumulator.hasReachedTerminalState)

        let textBefore = accumulator.text
        accumulator.apply(.contentBlockDelta(index: 0, delta: .text("迟到")))
        XCTAssertEqual(accumulator.text, textBefore, "终态后不再累积正文")
        XCTAssertEqual(accumulator.outcome, .completed)

        var failed = AIChatTurnAccumulator()
        failed.apply(.error(code: "internal", message: "炸了"))
        XCTAssertTrue(failed.hasReachedTerminalState)
        failed.apply(.messageDelta(usage: nil, stopReason: "end_turn"))
        XCTAssertNil(failed.stopReason, "error 之后的帧不改状态")

        var stopped = AIChatTurnAccumulator()
        stopped.apply(.messageStop)
        XCTAssertFalse(stopped.hasReachedTerminalState, "message_stop 还没收尾（done 在后面）")
        stopped.apply(.done(AIChatStreamDone()))
        XCTAssertEqual(stopped.outcome, .completed)
    }

    /// 内容块 / 增量的分类（含 `tool_use` → 搜索中 与 `tool_result` 的两种拼写）。
    func testContentBlockAndDeltaClassification() {
        var accumulator = AIChatTurnAccumulator()
        accumulator.apply(.contentBlockStart(index: 1, block: .toolUse(id: "t1", name: "web_search", input: [:])))
        XCTAssertTrue(accumulator.isSearching)
        XCTAssertEqual(accumulator.toolCallCount, 1)
        accumulator.apply(.contentBlockDelta(index: 1, delta: .inputJSON("{\"q\":")))
        XCTAssertTrue(accumulator.text.isEmpty, "工具入参不进正文")
        accumulator.apply(.contentBlockStop(index: 1))
        XCTAssertFalse(accumulator.isSearching)

        accumulator.apply(.messageDelta(usage: AIChatDeltaUsage(inputTokens: 3, outputTokens: 4, totalTokens: 7), stopReason: "cancelled"))
        XCTAssertEqual(accumulator.effectiveUsage?.promptTokens, 3, "in/out 映射到 prompt/completion")
        XCTAssertEqual(accumulator.stopReason, "cancelled")
    }

    // MARK: - Markdown 口径（复用 S5.3 的解析器）

    /// 未闭合围栏整段留在 tail（否则后面的块会被吞进代码块）。
    func testStreamingSplitKeepsUnclosedFenceInTail() {
        let blocks = AIChatMarkdown.splitDraft("先说明一句\n\n```json\n{\"a\": 1}\n")
        XCTAssertEqual(blocks.stable, "先说明一句\n\n")
        XCTAssertEqual(blocks.tail, "```json\n{\"a\": 1}\n")

        let closed = AIChatMarkdown.splitDraft("说明\n\n```json\n{}\n```\n")
        XCTAssertEqual(closed.tail, "")
        XCTAssertTrue(closed.stable.contains("```json"))
    }

    /// 半行留在 tail（半张表格 / 半条列表项）。
    func testStreamingSplitKeepsPartialLastLineInTail() {
        let blocks = AIChatMarkdown.splitDraft("| a | b |\n| - | - |\n| 1 |")
        XCTAssertEqual(blocks.tail, "| 1 |")
    }

    /// 块级解析：标题 / 列表 / 表格 / 代码围栏都认得，且**不丢内容**。
    func testMarkdownParsesBlocksWithoutDroppingContent() {
        let markdown = """
        # 标题

        段落 **粗体** 与 `代码`。

        - 一
        - 二

        1. 甲
        2. 乙

        > 引用

        | 列 A | 列 B |
        | --- | --- |
        | 1 | 2 |

        ---

        ```python
        print(1)
        ```

        ```chart
        {"type":"line"}
        ```
        """
        let blocks = AIChatMarkdown.blocks(markdown)
        XCTAssertTrue(blocks.contains { if case .heading(1, "标题") = $0 { return true } else { return false } })
        XCTAssertTrue(blocks.contains { if case .bulletList(let items) = $0 { return items == ["一", "二"] } else { return false } })
        XCTAssertTrue(blocks.contains { if case .orderedList(let items) = $0 { return items == ["甲", "乙"] } else { return false } })
        XCTAssertTrue(blocks.contains { if case .quote("引用") = $0 { return true } else { return false } })
        XCTAssertTrue(blocks.contains { if case .table(let h, let r) = $0 { return h == ["列 A", "列 B"] && r == [["1", "2"]] } else { return false } })
        XCTAssertTrue(blocks.contains { $0 == .thematicBreak })
        XCTAssertTrue(blocks.contains { if case .code(let language, let code) = $0 { return language == "python" && code.contains("print(1)") } else { return false } })
        // `chart` 围栏在**会话页**按普通代码块呈现（Web 会话页没有图表渲染器）——
        // 解析层认得它是 chart，呈现层用 `codeText` 一视同仁。
        XCTAssertTrue(blocks.contains { if case .chart = $0 { return true } else { return false } })
        XCTAssertEqual(AIChatMarkdown.codeText(.chart(language: "chart", code: "{}"))?.language, "chart")
        XCTAssertEqual(AIChatMarkdown.codeLanguageLabel(nil), "text", "无语言时 Web 显示 text")
    }

    // MARK: - 两端拼接规则（prompt 预设 / 场景 / 用户内容）

    /// 通用 system prompt：基础指令 + 命中项，按 Web 的顺序与空行拼接。
    func testBuildSystemPromptMatchesWeb() {
        let none = AIChatPresetCatalog.buildSystemPrompt(overviewID: nil, detailID: nil)
        XCTAssertEqual(none, AIChatPresetCatalog.baseInstruction)
        XCTAssertEqual(
            AIChatPresetCatalog.buildSystemPrompt(overviewID: "none", detailID: "none"),
            AIChatPresetCatalog.baseInstruction,
            "`none` 与 nil 等价"
        )

        let both = AIChatPresetCatalog.buildSystemPrompt(
            overviewID: "overview-brief",
            detailID: "detail-stepped"
        )
        let parts = both.components(separatedBy: "\n\n")
        XCTAssertEqual(parts.count, 3)
        XCTAssertEqual(parts[0], AIChatPresetCatalog.baseInstruction)
        XCTAssertEqual(parts[1], AIChatPresetCatalog.overviewOptions[1].content)
        XCTAssertEqual(parts[2], AIChatPresetCatalog.detailOptions[1].content)

        // 未知 id 会被后端代理 400 拒 —— 本地要先判成非法。
        XCTAssertTrue(AIChatPresetCatalog.isValidPromptIDs(overviewID: "none", detailID: nil))
        XCTAssertFalse(AIChatPresetCatalog.isValidPromptIDs(overviewID: "overview-nope", detailID: nil))
        XCTAssertFalse(AIChatPresetCatalog.isValidPromptIDs(overviewID: nil, detailID: "detail-nope"))
    }

    /// 场景 system prompt：基础指令 + 语气 + 篇幅 + 语言，顺序与 Web 一致。
    func testBuildScenarioSystemPromptMatchesWeb() {
        XCTAssertEqual(
            AIChatPresetCatalog.buildScenarioSystemPrompt(
                scenarioID: nil,
                toneID: nil,
                language: nil,
                length: nil
            ),
            AIChatPresetCatalog.fallbackSystemPrompt
        )

        let fallbackOnly = AIChatPresetCatalog.buildScenarioSystemPrompt(
            scenarioID: "ops-report",
            toneID: nil,
            language: nil,
            length: nil
        )
        XCTAssertEqual(fallbackOnly, AIChatPresetCatalog.scenario(id: "ops-report")?.systemPrompt)

        let full = AIChatPresetCatalog.buildScenarioSystemPrompt(
            scenarioID: "ops-report",
            toneID: "verbal",
            language: .en,
            length: .brief
        )
        let parts = full.components(separatedBy: "\n\n")
        XCTAssertEqual(parts.count, 4)
        XCTAssertEqual(parts[0], AIChatPresetCatalog.scenario(id: "ops-report")?.systemPrompt)
        XCTAssertEqual(parts[1], AIChatPresetCatalog.tone(scenarioID: "ops-report", toneID: "verbal")?.promptSuffix)
        XCTAssertEqual(parts[2], AIChatLength.brief.instruction)
        XCTAssertEqual(parts[3], AIChatLanguage.en.instruction)
    }

    /// 场景校验：停用场景 / 不属于该场景的语气都要被本地拦下（Web 代理同样 400）。
    func testScenarioValidationMatchesWebRules() {
        XCTAssertTrue(AIChatPresetCatalog.isValidScenarioIDs(scenarioID: nil, toneID: nil))
        XCTAssertTrue(AIChatPresetCatalog.isValidScenarioIDs(scenarioID: "ops-report", toneID: "brief"))
        XCTAssertFalse(AIChatPresetCatalog.isValidScenarioIDs(scenarioID: "email-compose", toneID: nil), "停用场景不可生成")
        XCTAssertFalse(AIChatPresetCatalog.isValidScenarioIDs(scenarioID: "nope", toneID: nil))
        XCTAssertFalse(AIChatPresetCatalog.isValidScenarioIDs(scenarioID: "ops-report", toneID: "nope"))
        XCTAssertEqual(AIChatPresetCatalog.defaultScenarioID, "ops-report")
        XCTAssertTrue(AIChatPresetCatalog.scenarios.contains { $0.isDisabled }, "「邮件撰写」保持置灰（Web 同口径）")
    }

    /// user content：两段拼接、只收非空字段、逐字与 Web 的 `buildUserContent` 一致。
    func testBuildUserContentMatchesWeb() {
        let schema = AIChatPresetCatalog.scenario(id: "ops-report")?.inputSchema ?? []

        XCTAssertEqual(
            AIChatPresetCatalog.buildUserContent(freeText: "  ", guidedFields: [:], schema: schema),
            ""
        )

        let onlyFree = AIChatPresetCatalog.buildUserContent(
            freeText: "本周数据",
            guidedFields: [:],
            schema: schema
        )
        XCTAssertEqual(onlyFree, "【原始内容】\n本周数据")

        let full = AIChatPresetCatalog.buildUserContent(
            freeText: "本周数据",
            guidedFields: ["period": "本周", "metrics": "  ", "risks": "库存告警"],
            schema: schema
        )
        XCTAssertEqual(
            full,
            "【原始内容】\n本周数据\n\n【补充信息】\n- 汇报周期：本周\n- 重点事项或异常：库存告警"
        )

        // 字段顺序按 schema（不是字典序）—— Web 用 `schema.map`，顺序漂移会让 prompt 变。
        let ordered = AIChatPresetCatalog.buildUserContent(
            freeText: "",
            guidedFields: ["next": "c", "period": "a", "risks": "b"],
            schema: schema
        )
        XCTAssertEqual(
            ordered,
            "【补充信息】\n- 汇报周期：a\n- 重点事项或异常：b\n- 下一步计划：c"
        )
    }

    // MARK: - 展示口径

    func testFormattingMatchesWebConventions() {
        XCTAssertEqual(AIChatFormatting.tokenCount(999), "999")
        XCTAssertEqual(AIChatFormatting.tokenCount(1_500), "1.5K")
        XCTAssertEqual(AIChatFormatting.tokenCount(150_000), "150K")
        XCTAssertEqual(AIChatFormatting.tokenCount(2_500_000), "2.5M")
        XCTAssertEqual(AIChatFormatting.integer(1234567), "1,234,567")
        XCTAssertEqual(AIChatFormatting.duration(950), "950ms")
        XCTAssertEqual(AIChatFormatting.duration(1_200), "1.2s")
        XCTAssertNil(AIChatFormatting.duration(nil))
        XCTAssertNil(AIChatFormatting.duration(0))
        XCTAssertEqual(AIChatFormatting.searchTimeRangeLabel("week"), "近 7 天")
        XCTAssertNil(AIChatFormatting.searchTimeRangeLabel("all"), "`all` 与 nil 都不显示 chip")
        XCTAssertNil(AIChatFormatting.searchTimeRangeLabel(nil))
    }

    func testTokenFooterNeedsRealUsage() {
        let plain = AIChatMessage(
            id: 1, conversationId: 1, role: "assistant", content: "x"
        )
        XCTAssertNil(AIChatFormatting.tokenFooter(plain), "没有用量就不显示脚注")

        let withUsage = AIChatMessage(
            id: 2, conversationId: 1, role: "assistant", content: "x",
            promptTokens: 1_000, completionTokens: 500, totalTokens: 1_500, durationMs: 1_200
        )
        let footer = try? XCTUnwrap(AIChatFormatting.tokenFooter(withUsage))
        XCTAssertEqual(footer, "↑1.0K ↓500 = 1.5K · 1.2s")
    }
}
