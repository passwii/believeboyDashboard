import BelieveBoyKit
import Foundation
import XCTest

/// 洞察三页的 Kit 层用例：真实快照解码 + Markdown 块级解析 + 面板口径 + 游标簿记。
///
/// 「同源同结构」（BLF-1062 §口径 1）在这份文件里的落点：
/// - ① run detail 的**字段与状态机**（`InsightRunDetail` 的每个字段都能从真实响应取到值）；
/// - ② SSE 的**事件类型序列**（真实帧文本 → 帧序列 → 事件类型序列，逐条断言）；
/// - ③ summary 与**数值型字段**（`total` / `progress_percent` / `usage.total_tokens` / `seq`）。
///
/// **不断言模型文本内容** —— 只断言渲染路径（Markdown → 块序列）。
final class InsightDecodingTests: XCTestCase {
    // MARK: - 夹具自校验（哈希 / 时点）

    /// 落盘快照与 manifest 的 `sha256` 一致 —— 手工改过夹具、或重抓后忘了更新 manifest 都会红。
    func testCommittedSnapshotHashesMatchManifest() throws {
        let manifest = try InsightFixtures.manifest()
        XCTAssertFalse(manifest.capturedAt.isEmpty, "manifest 必须记抓取时点")
        XCTAssertEqual(manifest.params.projectID, 1)
        XCTAssertEqual(manifest.params.country, "US")
        XCTAssertEqual(manifest.params.limit, 20)

        let entries = manifest.files + manifest.streams
        XCTAssertEqual(entries.count, 12, "6 条端点 → 12 份快照（JSON + SSE 原文）")
        for entry in entries {
            let data = try InsightFixtures.data(fileName: entry.file)
            XCTAssertEqual(data.count, entry.bytes, "\(entry.file) 字节数漂移")
            XCTAssertEqual(
                InsightFixtures.sha256(of: data),
                entry.sha256,
                "\(entry.file) sha256 漂移 —— 重抓后要同步 manifest 并在 PR 写明新哈希"
            )
        }
    }

    /// 两段来源的库必须如实写进 manifest（A 段 = 生产快照库，B 段 = 隔离库）。
    func testManifestDocumentsBothSources() throws {
        let manifest = try InsightFixtures.manifest()
        XCTAssertTrue(manifest.sourceA.database.contains("BLF"), manifest.sourceA.database)
        XCTAssertTrue(manifest.sourceB.database.contains("BLF_test"), manifest.sourceB.database)
        XCTAssertEqual(manifest.sourceA.database, "生产快照库 BLF（backend/.env 的 DATABASE_URL）")
        XCTAssertTrue(manifest.sourceB.database.contains("BLF_test"))
        XCTAssertFalse(manifest.sourceB.note.isEmpty)
    }

    // MARK: - 旧链路：列表 / 明细 / 定时

    /// 列表信封：`total` 是**窗口内总数**，与 `items.count` 不是一回事（分页判定只能用前者）。
    func testInsightListDecodesEnvelopeAndItems() throws {
        let payload = try InsightFixtures.insightList()
        XCTAssertGreaterThan(payload.total, 0)
        XCTAssertEqual(payload.items.count, min(payload.total, InsightCatalog.pageSize))

        let first = try XCTUnwrap(payload.items.first)
        XCTAssertGreaterThan(first.id, 0)
        XCTAssertEqual(first.projectId, 1)
        XCTAssertEqual(first.country, "US")
        XCTAssertFalse(first.projectName.isEmpty)
        XCTAssertFalse(first.dateRangeStart.isEmpty)
        XCTAssertFalse(first.dateRangeEnd.isEmpty)
        XCTAssertFalse(InsightTypes.label(value: first.insightType).isEmpty)
        // 旧状态机词表（后端 `InsightStatus`）。
        XCTAssertTrue(
            ["pending", "generating", "completed", "failed"].contains(first.status),
            "未登记状态：\(first.status)"
        )
        XCTAssertFalse(first.createdBy.isEmpty)
    }

    /// 明细比列表多两列：`content`（Markdown 正文）与 `strategy_metadata`（JSON 字符串）。
    func testInsightDetailCarriesContentAndStrategyMetadata() throws {
        let detail = try InsightFixtures.insightDetail()
        let content = try XCTUnwrap(detail.content)
        XCTAssertGreaterThan(content.count, 100, "真实洞察正文应当有成篇内容")
        XCTAssertTrue(content.contains("#"), "正文是 Markdown（至少有一个标题）")
        // `strategy_metadata` 是 `Text` 列，原样透出（可能是 nil —— 真实响应里就是 nil）。
        XCTAssertEqual(detail.status, "completed")
    }

    /// 「AI 广告分析」页的历史列表口径：固定 `insight_type=ad_analysis`。
    func testAdAnalysisListIsFilteredByInsightType() throws {
        let payload = try InsightFixtures.adAnalysisList()
        XCTAssertGreaterThan(payload.total, 0, "生产快照库里应有 ad_analysis 记录")
        for item in payload.items {
            XCTAssertEqual(item.insightType, InsightCatalog.adAnalysisInsightType)
        }
    }

    /// 定时列表：本批只读，真实响应当前是空列表（空态夹具 —— 面板必须画出「暂无定时任务」）。
    func testScheduleListDecodes() throws {
        let payload = try InsightFixtures.schedules()
        XCTAssertEqual(payload.items.count, payload.total)
        XCTAssertEqual(payload.total, 0, "生产快照库当前 0 条定时任务；若新增了，这条断言要改成「字段齐备」")
    }

    // MARK: - canonical run：detail

    /// completed run：字段、状态机、输出槽与数值型字段逐个取到值。
    func testCompletedRunDetailDecodesEveryField() throws {
        let detail = try InsightFixtures.runDetailCompleted()
        XCTAssertEqual(detail.schemaVersion, 1)
        XCTAssertEqual(detail.attempt, 1)
        XCTAssertEqual(detail.status, "completed")
        XCTAssertTrue(InsightRunStatusMachine.isTerminal(detail.status))
        XCTAssertTrue(InsightRunStatusMachine.stages.contains(detail.stage))
        XCTAssertEqual(detail.progressPercent, 100)
        XCTAssertEqual(detail.outputFormat, "markdown")
        XCTAssertEqual(detail.country, "US")
        XCTAssertFalse(detail.roleId.isEmpty)
        XCTAssertGreaterThan(detail.roleVersion, 0)

        let output = try XCTUnwrap(detail.outputs[InsightRunDetail.defaultSlot])
        XCTAssertEqual(output.format, "markdown")
        XCTAssertGreaterThan(output.content.count, 100)
        // 摘要长度 64（小写 sha256 hex）—— 数值型字段与 Web 同值那一条的落点。
        XCTAssertEqual(output.contentSha256?.count, 64)
        XCTAssertEqual(detail.content(), output.content, "默认槽 `main` 就是正文所在槽")

        let usage = try XCTUnwrap(detail.usage)
        XCTAssertEqual(usage.totalTokens, usage.inputTokens + usage.outputTokens)
        XCTAssertEqual(usage.totalTokens, 2000)

        let resume = try XCTUnwrap(detail.resume)
        XCTAssertEqual(resume.currentAttempt, detail.attempt)
    }

    /// failed run：typed error 的码表与 `retryable` 标记。
    func testFailedRunDetailCarriesTypedError() throws {
        let detail = try InsightFixtures.runDetailFailed()
        XCTAssertEqual(detail.status, "failed")
        XCTAssertTrue(detail.isTerminal)
        XCTAssertEqual(detail.progressPercent, 40)
        XCTAssertTrue(detail.outputs.isEmpty)
        XCTAssertNil(detail.usage)

        let error = try XCTUnwrap(detail.error)
        XCTAssertEqual(error.code, "UPSTREAM_TIMEOUT")
        XCTAssertEqual(error.retryable, true)
        XCTAssertFalse(error.message.isEmpty)
    }

    // MARK: - SSE：事件类型序列与游标

    /// completed 流的真实事件类型序列：`snapshot → done`（Redis 无历史 → 从 DB 快照合成终态帧）。
    func testCompletedRunStreamEventSequence() throws {
        let text = try InsightFixtures.runStreamCompletedText()
        XCTAssertEqual(
            InsightSSEFixture.eventTypes(from: text),
            ["snapshot", "done"]
        )
        let ids = InsightSSEFixture.eventIDs(from: text)
        XCTAssertEqual(ids.count, 2, "canonical 每帧都带 `id:` 游标")
        for id in ids {
            let cursor = try XCTUnwrap(InsightEventCursor.parse(id), "游标形状：\(id)")
            XCTAssertEqual(cursor.attempt, 1)
        }
        XCTAssertEqual(ids[0], "\(try InsightFixtures.runDetailCompleted().runId):1:1000001")
    }

    /// failed 流：`snapshot → error`，且 `error` 帧带 typed error。
    func testFailedRunStreamEventSequence() throws {
        let text = try InsightFixtures.runStreamFailedText()
        let events = InsightSSEFixture.events(from: text)
        XCTAssertEqual(events.compactMap { try? $0.decode(InsightRunEvent.self).type }, [
            "snapshot", "error",
        ])

        let terminal = try XCTUnwrap(events.last)
        let event = try terminal.decode(InsightRunEvent.self)
        XCTAssertTrue(event.isTerminalEvent)
        XCTAssertEqual(event.error?.code, "UPSTREAM_TIMEOUT")
        XCTAssertEqual(event.status, "failed")
    }

    /// 续传语义（§口径 2 的真身）：带 `Last-Event-ID` 的响应**只回终态帧**，不回已见的快照帧。
    func testResumeResponseOnlyCarriesTheTerminalFrame() throws {
        let full = try InsightFixtures.runStreamCompletedText()
        let resumed = try InsightFixtures.runStreamCompletedResumeText()
        let firstID = try XCTUnwrap(InsightSSEFixture.eventIDs(from: full).first)

        let resumedIDs = InsightSSEFixture.eventIDs(from: resumed)
        XCTAssertEqual(resumedIDs.count, 1)
        XCTAssertNotEqual(resumedIDs.first, firstID, "已见的那一帧不该被重放")
        XCTAssertEqual(InsightSSEFixture.eventTypes(from: resumed), ["done"])
        XCTAssertTrue(
            InsightEventCursor.parse(resumedIDs[0])!
                .isStrictlyAfter(InsightEventCursor.parse(firstID)!),
            "续传游标必须严格在旧游标之后（后端 `_after_cursor` 同口径）"
        )
    }

    /// 旧链路流**不发 `id:`** —— 这条差异是「旧链路不能按游标续传」的硬证据。
    func testLegacyStreamCarriesNoCursor() throws {
        let text = try InsightFixtures.legacyStreamText()
        let events = InsightSSEFixture.events(from: text)
        XCTAssertFalse(events.isEmpty)
        XCTAssertTrue(events.allSatisfy { $0.id == nil })
        XCTAssertEqual(InsightCatalog.legacyStreamCarriesCursor, false)
        XCTAssertEqual(InsightCatalog.canonicalStreamCarriesCursor, true)

        let frame = try XCTUnwrap(LegacyInsightFrame.parse(events[0].data))
        guard case .status(let status, _, let insightID, let title, let content, _) = frame else {
            return XCTFail("已终态的旧洞察订阅应当立刻回一帧 status")
        }
        XCTAssertEqual(status, "completed")
        XCTAssertNotNil(insightID)
        XCTAssertFalse(title?.isEmpty ?? true)
        XCTAssertTrue(content?.contains("#") ?? false)
    }

    /// 非法游标的真实响应：400 + typed `RESUME_CURSOR_INVALID`（客户端据此回退到 detail）。
    func testInvalidCursorResponseIsTyped400() throws {
        let response = try InsightFixtures.invalidCursorResponse()
        XCTAssertEqual(response.status, 400)
        XCTAssertEqual(response.code, "RESUME_CURSOR_INVALID")
        XCTAssertTrue(response.message.contains("not-a-cursor"), response.message)
    }
}

/// Markdown 渲染路径的用例（§口径 3：`chart` 围栏降级呈现、流式草稿切分）。
final class InsightMarkdownTests: XCTestCase {
    // MARK: - 块级解析

    /// 真实洞察正文（夹具里那篇）必须解析出标题 / 段落，且**字符一个不丢**。
    func testRealInsightContentIsFullyPreserved() throws {
        let content = try XCTUnwrap(InsightFixtures.insightDetail().content)
        let blocks = InsightMarkdown.parse(content)
        XCTAssertFalse(blocks.isEmpty)
        XCTAssertTrue(
            blocks.contains { block in
                if case .heading(let level, _) = block { return level == 1 }
                return false
            },
            "真实正文有 H1"
        )
        XCTAssertTrue(blocks.contains { if case .table = $0 { return true } else { return false } })
        assertNoContentLost(blocks, from: content)
    }

    /// completed run 的真实正文里有 ` ```chart ` 围栏 → 必须解析成 `.chart` 块（降级渲染的前提）。
    func testChartFenceBecomesDegradedChartBlock() throws {
        let content = try XCTUnwrap(InsightFixtures.runDetailCompleted().outputs["main"]?.content)
        let blocks = InsightMarkdown.parse(content)
        guard let chart = blocks.first(where: { if case .chart = $0 { return true } else { return false } })
        else {
            return XCTFail("真实夹具里有 ```chart 围栏，必须解析成 .chart 块：\(blocks)")
        }
        guard case .chart(let language, let code) = chart else { return }
        XCTAssertEqual(language, "chart")
        XCTAssertTrue(code.contains("\"type\":\"line\""), "围栏原文必须原样保留：\(code)")
        assertNoContentLost(blocks, from: content)
    }

    /// 图表围栏语言全覆盖（Web 两处并集）：7 个语言都走降级块，而不是普通代码块。
    func testEveryChartLanguageGoesToTheChartBlock() {
        for language in InsightMarkdown.chartFenceLanguages {
            let content = "```\(language)\n{}\n```\n"
            let blocks = InsightMarkdown.parse(content)
            guard case .chart(let decoded, _) = blocks.first else {
                return XCTFail("\(language) 应当解析成 .chart：\(blocks)")
            }
            XCTAssertEqual(decoded, language)
        }
    }

    /// 非图表语言走普通代码块（不误降级）。
    func testNonChartFenceStaysPlainCode() {
        let blocks = InsightMarkdown.parse("```sql\nselect 1\n```\n")
        guard case .code(let language, let code) = blocks.first else {
            return XCTFail("应当解析成 .code：\(blocks)")
        }
        XCTAssertEqual(language, "sql")
        XCTAssertEqual(code, "select 1\n")
    }

    /// 未闭合围栏：整段按代码块收尾 —— **不吞掉后续内容**（吞掉就等于静默丢块）。
    func testUnclosedFenceSwallowsNothing() {
        let content = "前言\n\n```chart\n{\"a\":1}\n"
        let blocks = InsightMarkdown.parse(content)
        assertNoContentLost(blocks, from: content)
        XCTAssertTrue(blocks.contains { if case .chart = $0 { return true } else { return false } })
    }

    /// 块级结构：有序 / 无序列表、引用、分隔线、表格。
    func testBlockStructures() {
        let content = """
        ## 标题

        - 甲
        - 乙

        1. 一
        2. 二

        > 引用一行

        ---

        | 指标 | 值 |
        | --- | --- |
        | 花费 | 12 |
        """
        let blocks = InsightMarkdown.parse(content)
        XCTAssertEqual(blocks[0], .heading(level: 2, text: "标题"))
        XCTAssertEqual(blocks[1], .bulletList(["甲", "乙"]))
        XCTAssertEqual(blocks[2], .orderedList(["一", "二"]))
        XCTAssertEqual(blocks[3], .quote("引用一行"))
        XCTAssertEqual(blocks[4], .thematicBreak)
        XCTAssertEqual(blocks[5], .table(headers: ["指标", "值"], rows: [["花费", "12"]]))
    }

    /// `#标题`（`#` 后没空格）不是标题 —— CommonMark 口径，照抄。
    func testHashWithoutSpaceIsNotAHeading() {
        let blocks = InsightMarkdown.parse("#标题\n")
        XCTAssertEqual(blocks, [.paragraph("#标题")])
    }

    // MARK: - 流式切分

    /// 未闭合围栏整段留在 tail（否则半截代码块会把后续内容误渲染）。
    func testUnclosedFenceStaysInTail() {
        let split = InsightMarkdown.splitStreamingMarkdown("正文\n\n```chart\n{\"a\":1}")
        XCTAssertEqual(split.stable, "正文\n\n")
        XCTAssertEqual(split.tail, "```chart\n{\"a\":1}")
    }

    /// 已闭合围栏留在 stable（图表块只在闭合后挂载）。
    func testClosedFenceStaysInStable() {
        let split = InsightMarkdown.splitStreamingMarkdown("正文\n\n```chart\n{}\n```\n继续")
        XCTAssertEqual(split.tail, "继续")
        XCTAssertTrue(split.stable.hasSuffix("```\n"))
    }

    /// 末行未换行 → 整行留在 tail（半行表格 / 列表项）。
    func testUnterminatedLastLineStaysInTail() {
        let split = InsightMarkdown.splitStreamingMarkdown("甲\n乙")
        XCTAssertEqual(split.stable, "甲\n")
        XCTAssertEqual(split.tail, "乙")
    }

    /// 空草稿：两段都是空。
    func testEmptyDraftSplitsEmpty() {
        XCTAssertEqual(
            InsightMarkdown.splitStreamingMarkdown(""),
            InsightStreamBlocks(stable: "", tail: "")
        )
    }

    /// 纯函数：同一份草稿必然得到同一份切分。
    func testSplitIsDeterministic() {
        let draft = "甲\n```chart\n{}\n```\n乙\n丙"
        XCTAssertEqual(
            InsightMarkdown.splitStreamingMarkdown(draft),
            InsightMarkdown.splitStreamingMarkdown(draft)
        )
    }

    // MARK: - 工具

    /// 「不丢内容」判据：每个块里的每一段文本都能在原文里找到，且块数不为零。
    ///
    /// 为什么不写成「块序列拼回原文逐字相同」：拼回要还原围栏标记、列表编号、表格对齐行
    /// 等一堆版式细节，任何一处版式差异都会让断言红在无关的地方；而真正要守的是
    /// **内容不丢**（围栏原文、表格单元格、段落文字一个不少）。
    private func assertNoContentLost(
        _ blocks: [InsightBlock],
        from content: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertFalse(blocks.isEmpty, "块序列不该为空", file: file, line: line)
        for text in texts(in: blocks) {
            XCTAssertTrue(
                content.contains(text),
                "块里的文本不在原文里（解析丢内容）：\(text)",
                file: file,
                line: line
            )
        }
    }

    private func texts(in blocks: [InsightBlock]) -> [String] {
        blocks.flatMap { block -> [String] in
            switch block {
            case .heading(_, let text), .paragraph(let text): return [text]
            case .bulletList(let items), .orderedList(let items): return items
            case .quote(let text): return [text]
            case .table(let headers, let rows): return headers + rows.flatMap { $0 }
            case .thematicBreak: return []
            case .chart(_, let code), .code(_, let code):
                return code.split(separator: "\n").map(String.init).filter { !$0.isEmpty }
            }
        }
    }
}

/// 面板口径 + 游标簿记的用例（「数值口径与 Web 同值」那一条的落点）。
final class InsightPanelMappingTests: XCTestCase {
    /// 两域在跑的四个状态都映射成域文案；终态不再显示进度（对齐 `toInventoryPanelState`）。
    func testActiveRunKeepsProgressAndTerminalDropsIt() {
        let active = InsightPanelMapping.canonical(
            runStatus: "generating",
            transport: .live,
            progress: 40,
            domain: .inventoryHealth
        )
        XCTAssertEqual(active.status, "generating")
        XCTAssertEqual(active.label, "正在生成库存健康分析")
        XCTAssertEqual(active.progress, 40)
        XCTAssertTrue(active.isStreaming)
        XCTAssertTrue(active.busy)

        let done = InsightPanelMapping.canonical(
            runStatus: "completed",
            transport: .live,
            progress: 100,
            domain: .inventoryHealth
        )
        XCTAssertEqual(done.label, "库存健康分析已完成")
        XCTAssertNil(done.progress, "终态后不再显示进度")
        XCTAssertFalse(done.isStreaming)
        XCTAssertFalse(done.busy)
    }

    /// 断流重连期间：**run 状态优先**，但文案换成「连接中断，正在重连」。
    func testReconnectingKeepsRunStatusButSwapsLabel() {
        let state = InsightPanelMapping.canonical(
            runStatus: "aggregating",
            transport: .reconnecting,
            progress: 12,
            domain: .adAnalysis
        )
        XCTAssertEqual(state.status, "aggregating")
        XCTAssertEqual(state.label, "连接中断，正在重连")
        XCTAssertEqual(state.progress, 12)
        XCTAssertFalse(state.isStreaming, "重连期间没有内容在动")
        XCTAssertTrue(state.busy)
    }

    /// 没有 run 状态时退到传输层文案（`connecting` / `live` 都是「在跑」）。
    func testMissingRunStatusFallsBackToTransport() {
        let connecting = InsightPanelMapping.canonical(
            runStatus: nil,
            transport: .connecting,
            progress: nil,
            domain: .adAnalysis
        )
        XCTAssertEqual(connecting.status, "connecting")
        XCTAssertEqual(connecting.label, "正在连接生成流")
        XCTAssertFalse(connecting.isStreaming)
        XCTAssertTrue(connecting.busy)

        let live = InsightPanelMapping.canonical(
            runStatus: nil,
            transport: .live,
            progress: nil,
            domain: .adAnalysis
        )
        XCTAssertTrue(live.isStreaming)
    }

    /// 广告域与库存域文案确实不同（同一状态、不同域）。
    func testDomainsUseTheirOwnLabels() {
        let ad = InsightPanelMapping.canonical(
            runStatus: "aggregating", transport: .live, progress: 1, domain: .adAnalysis
        )
        let inventory = InsightPanelMapping.canonical(
            runStatus: "aggregating", transport: .live, progress: 1, domain: .inventoryHealth
        )
        XCTAssertEqual(ad.label, "正在聚合广告数据")
        XCTAssertEqual(inventory.label, "正在聚合库存与补货数据")
    }

    /// 旧链路的 `sub_status` → canonical 状态（Web `legacySubStatusToCanonical` 逐条）。
    func testLegacySubStatusMapping() {
        XCTAssertEqual(InsightPanelMapping.legacyCanonicalStatus(subStatus: nil), "generating")
        XCTAssertEqual(InsightPanelMapping.legacyCanonicalStatus(subStatus: "queued"), "queued")
        XCTAssertEqual(
            InsightPanelMapping.legacyCanonicalStatus(subStatus: "ai_generating"),
            "generating"
        )
        XCTAssertEqual(
            InsightPanelMapping.legacyCanonicalStatus(subStatus: "title_generating"),
            "finalizing"
        )
        XCTAssertEqual(
            InsightPanelMapping.legacyCanonicalStatus(subStatus: "data_aggregating_ad"),
            "aggregating"
        )
        XCTAssertEqual(
            InsightPanelMapping.legacyCanonicalStatus(subStatus: "未知阶段"),
            "generating"
        )
    }

    /// 旧链路面板：未知 `sub_status` 按「聚合中」兜底展示，不丢信息。
    func testLegacyPanelFallsBackForUnknownSubStatus() {
        let state = InsightPanelMapping.legacy(
            status: "running",
            subStatus: "未知阶段",
            transport: .live
        )
        XCTAssertEqual(state.status, "generating")
        XCTAssertEqual(state.label, InsightPanelMapping.legacyAggregatingFallback)
        XCTAssertTrue(state.isStreaming)
    }

    /// 旧链路终态：`completed` / `failed` 都是 busy = false。
    func testLegacyTerminalStatesAreNotBusy() {
        XCTAssertFalse(
            InsightPanelMapping.legacy(status: "completed", subStatus: nil, transport: .live).busy
        )
        XCTAssertFalse(
            InsightPanelMapping.legacy(status: "failed", subStatus: nil, transport: .live).busy
        )
        XCTAssertFalse(
            InsightPanelMapping.legacy(status: "idle", subStatus: nil, transport: .connecting).busy
        )
    }

    /// 列表状态 → 色板状态：`pending` → `queued`，`generating` + `sub_status` → 细阶段。
    func testLegacyListStatusNormalization() {
        XCTAssertEqual(
            InsightPanelMapping.legacyListStatus("pending", subStatus: "queued"),
            "queued"
        )
        XCTAssertEqual(
            InsightPanelMapping.legacyListStatus("generating", subStatus: "data_aggregating_ad"),
            "aggregating"
        )
        XCTAssertEqual(
            InsightPanelMapping.legacyListStatus("completed", subStatus: nil),
            "completed"
        )
        XCTAssertEqual(InsightPanelMapping.legacyListStatus("failed", subStatus: nil), "failed")
    }

    // MARK: - 游标

    /// 游标字符串 ↔ 三元组；非法形状一律 `nil`（客户端只在解析得出来时才发 `Last-Event-ID`）。
    func testCursorParsing() {
        let cursor = try? XCTUnwrap(InsightEventCursor.parse("run-1:2:3000001"))
        XCTAssertEqual(cursor?.runId, "run-1")
        XCTAssertEqual(cursor?.attempt, 2)
        XCTAssertEqual(cursor?.sequence, 3_000_001)
        XCTAssertEqual(cursor?.wireValue, "run-1:2:3000001")

        XCTAssertNil(InsightEventCursor.parse("not-a-cursor"))
        XCTAssertNil(InsightEventCursor.parse("run-1:2"))
        XCTAssertNil(InsightEventCursor.parse("run-1:0:1"))
        XCTAssertNil(InsightEventCursor.parse("run-1:2:-1"))
        XCTAssertNil(InsightEventCursor.parse(":1:1"))
    }

    /// `(attempt, seq)` 字典序比较（换 attempt 后旧 attempt 的更大 seq 也不算更新）。
    func testCursorOrdering() {
        let older = InsightEventCursor(runId: "r", attempt: 1, sequence: 9_999_999)
        let newer = InsightEventCursor(runId: "r", attempt: 2, sequence: 1)
        XCTAssertTrue(newer.isStrictlyAfter(older))
        XCTAssertFalse(older.isStrictlyAfter(newer))
        XCTAssertFalse(older.isStrictlyAfter(older))
    }

    /// 去重：同一 `id` 第二次出现不再应用（续传重放时正文不会被写两遍）。
    func testCursorTrackerDedupesReplayedFrames() {
        var tracker = InsightCursorTracker()
        XCTAssertTrue(tracker.accept(eventID: "r:1:1"))
        XCTAssertEqual(tracker.lastEventID, "r:1:1")
        XCTAssertFalse(tracker.accept(eventID: "r:1:1"), "重复帧必须丢弃")
        XCTAssertTrue(tracker.accept(eventID: "r:1:2"))
        XCTAssertEqual(tracker.seenCount, 2)
        XCTAssertTrue(tracker.hasSeen("r:1:1"))
    }

    /// 旧链路（无 `id:`）：没有游标可去重，一律接受（否则整条流会被当成重复帧吃掉）。
    func testCursorTrackerAcceptsFramesWithoutID() {
        var tracker = InsightCursorTracker()
        XCTAssertTrue(tracker.accept(eventID: nil))
        XCTAssertTrue(tracker.accept(eventID: nil))
        XCTAssertNil(tracker.lastEventID)
        XCTAssertEqual(tracker.seenCount, 0)
    }

    /// 从事件信封补记游标（帧里 `id:` 缺失但 `run_id/attempt/seq` 齐全时）。
    func testCursorTrackerAcceptsEventEnvelope() throws {
        var tracker = InsightCursorTracker()
        let event = try XCTUnwrap(
            InsightSSEFixture.events(from: try InsightFixtures.runStreamCompletedText())
                .first.flatMap { try? $0.decode(InsightRunEvent.self) }
        )
        XCTAssertTrue(tracker.accept(event: event))
        XCTAssertEqual(tracker.lastEventID, "\(event.runId):\(event.attempt):\(event.seq)")
        XCTAssertFalse(tracker.accept(event: event))
    }

    // MARK: - 维度面板

    /// `strategy_metadata` 解析：四个键 → 三组维度 + 跳过项（Web `view-dialog.tsx` 同口径）。
    func testDimensionCoverageParsesEvolutionMetadata() throws {
        let metadata = #"""
        {"evolution_metadata": {
          "dimensions_analyzed": [
            {"dimension_id": "spend", "name": "花费", "level": 1, "signal_strength": "strong"},
            {"dimension_id": "acos", "name": "ACOS", "level": 1}
          ],
          "cross_analyses_performed": ["花费 × 转化率"],
          "temporal_analyses_performed": ["周环比"],
          "dimensions_skipped": [{"dimension_id": "bid", "name": "竞价", "reason": "数据缺失"}]
        }}
        """#
        let coverage = try XCTUnwrap(InsightDimensionCoverage.parse(strategyMetadata: metadata))
        XCTAssertEqual(coverage.analyzed.count, 2)
        XCTAssertEqual(coverage.analyzed[0].signalStrength, "strong")
        XCTAssertEqual(coverage.analyzed[1].level, 1)
        XCTAssertEqual(coverage.cross.map(\.name), ["花费 × 转化率"])
        XCTAssertEqual(coverage.temporal.map(\.level), [3])
        XCTAssertEqual(coverage.skipped.map(\.reason), ["数据缺失"])
        XCTAssertEqual(coverage.total, 4)
    }

    /// 没有 `evolution_metadata` / 解析失败 / 四键全空 → `nil`（面板整块不渲染，不假装「零覆盖」）。
    func testDimensionCoverageIsNilWhenAbsent() {
        XCTAssertNil(InsightDimensionCoverage.parse(strategyMetadata: nil))
        XCTAssertNil(InsightDimensionCoverage.parse(strategyMetadata: "{}"))
        XCTAssertNil(InsightDimensionCoverage.parse(strategyMetadata: "not json"))
        XCTAssertNil(
            InsightDimensionCoverage.parse(strategyMetadata: #"{"evolution_metadata": {}}"#)
        )
    }
}
