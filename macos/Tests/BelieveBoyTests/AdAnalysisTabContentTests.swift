import BelieveBoyKit
import XCTest

@testable import BelieveBoyUI

/// `AdAnalysisView` 正文分支（`AdAnalysisTabContent.resolve`）的口径核对。
///
/// 为什么单拎出来、不做离屏渲染：这一支是**纯判定**，而审查抓到的缺陷正落在这里 ——
/// 首版把 `emptyNotice` 写在 `readyContent` 里，`.empty` 却是先命中外层 `EmptyView()`，
/// 于是「项目存在但报表为空」时整个 Tab 一片空白。离屏渲染断言只能证明「画了东西」
/// （页头 / 筛选条 / Tab 栏本来就在画），证明不了「画的是这条提示」，所以文案口径在这里钉。
final class AdAnalysisTabContentTests: XCTestCase {
    /// 空态：必须落到 `notice` 且文案要说明「无数据 / 不是失败 / 是哪个 Tab」。
    func testEmptyContentResolvesToNotice() {
        let branch = AdAnalysisTabContent.resolve(
            gate: .ready,
            content: .empty,
            tabLabel: "总览"
        )
        guard case .notice(let message) = branch else {
            return XCTFail("空态必须渲染提示而不是空白（验收标准 3），实际落到：\(branch)")
        }
        XCTAssertTrue(message.contains("没有数据"), "空态要说「无数据」，实际：\(message)")
        XCTAssertTrue(message.contains("不是加载失败"), "空态不是错误态，文案要写明，实际：\(message)")
        XCTAssertTrue(message.contains("总览"), "空态文案要指明是哪个 Tab，实际：\(message)")
    }

    /// 10 个 Tab 的空态都带自己的 Tab 名（不是只有「总览」写对了）。
    func testEveryTabEmptyStateCarriesItsOwnLabel() {
        for tab in AdAnalysisCatalog.tabs {
            let branch = AdAnalysisTabContent.resolve(
                gate: .ready,
                content: .empty,
                tabLabel: tab.label
            )
            guard case .notice(let message) = branch else {
                return XCTFail("\(tab.key) 的空态没有提示，实际落到：\(branch)")
            }
            XCTAssertTrue(message.contains(tab.label), "\(tab.key) 的空态文案丢了 Tab 名：\(message)")
            XCTAssertEqual(message, AdAnalysisTabContent.emptyNoticeMessage(tabLabel: tab.label))
        }
    }

    /// 有数据 → `ready`（空态那一支不能把正常内容也吃掉）。
    func testReadyContentStaysOnReadyBranch() {
        XCTAssertEqual(
            AdAnalysisTabContent.resolve(gate: .ready, content: .ready, tabLabel: "总览"),
            .ready
        )
    }

    /// 加载态 → 一行加载提示，且写明加载的是什么。
    func testLoadingBranchNamesWhatIsLoading() {
        XCTAssertEqual(
            AdAnalysisTabContent.resolve(gate: .pending, content: .loading, tabLabel: "总览"),
            .loading("正在加载项目列表…")
        )
        XCTAssertEqual(
            AdAnalysisTabContent.resolve(gate: .ready, content: .loading, tabLabel: "搜索词"),
            .loading("正在加载「搜索词」…")
        )
    }

    /// 失败态 → 正文留空（提示与重试在 `stateBanners`），**不能**被当成空态提示。
    func testFailureStaysOnBlockedBranch() {
        XCTAssertEqual(
            AdAnalysisTabContent.resolve(
                gate: .ready,
                content: .failed("boom"),
                tabLabel: "总览"
            ),
            .blocked,
            "内容失败要留空给错误横幅，别渲染成「无数据」"
        )
    }

    /// 项目闸门优先：项目列表还在加载 / 不可用时，正文不看 Tab 状态。
    func testProjectGateTakesPrecedenceOverTabState() {
        XCTAssertEqual(
            AdAnalysisTabContent.resolve(gate: .pending, content: .ready, tabLabel: "总览"),
            .loading("正在加载项目列表…")
        )
        XCTAssertEqual(
            AdAnalysisTabContent.resolve(gate: .failed("boom"), content: .empty, tabLabel: "总览"),
            .blocked
        )
        XCTAssertEqual(
            AdAnalysisTabContent.resolve(gate: .noProjects, content: .empty, tabLabel: "总览"),
            .blocked
        )
    }
}
