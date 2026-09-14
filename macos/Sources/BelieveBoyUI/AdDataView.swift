import BelieveBoyKit
import SwiftUI

/// 「广告 → 广告数据」只读页（Web `/dashboard/advertising/ad-data`）。
///
/// 11 个 GET 端点一个都不少（`AdDataCatalog` 的 10 个报表类型 + `ad-upload-files`），全部共用
/// 顶部的项目 / 站点 / 日期筛选条；切报表类型不重置筛选（状态住在 `NavigationStore.adData`）。
///
/// 视图不使用属性包装器宏（工具链约束，见 `Package.swift` 顶部）：需要双向绑定的地方走显式
/// `Binding`（见 `AdDataControls` 的 Picker / TextField）。
///
/// 正文分支口径在 `AdDataContent.resolve`（含「空态必须画出提示」那条）。
public struct AdDataView: View {
    /// Web 路由 —— 模块路由表的命中键，也是模块任务作用域的 key。
    public static let routeID = AdDataCatalog.routeID

    private let model: AppModel
    private let navigation: NavigationStore

    public init(model: AppModel, navigation: NavigationStore) {
        self.model = model
        self.navigation = navigation
    }

    private var store: AdDataStore { navigation.adData }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            scrollableBody
        }
        .frame(minWidth: 520, minHeight: 420)
        // 报表类型 / 筛选 / 刷新票号任一变化 → 重新加载。请求登记在
        // `navigation.selectionTaskKey`（= 当前 route id）下：同 key 的新请求会先取消上一个
        // （切类型、改筛选），切模块时由外壳按 route id 整体取消。
        .task(id: store.loadKey) { await reload() }
    }

    private var scrollableBody: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 14) {
                stateBanners
                AdDataControls(store: store)
                content
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: - 页头

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Image(systemName: "cylinder.split.1x2")
                    .font(.title3)
                    .foregroundStyle(.secondary)
                Text("广告数据")
                    .font(.title2.weight(.semibold))
                Text("只读")
                    .font(.caption.weight(.medium))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(.quaternary, in: Capsule())
                Spacer()
                Text("11 个端点 · 10 种报表类型")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            AdFilterBar(
                store: store,
                isRefreshing: store.isRefreshing,
                onRefresh: { store.requestRefresh() }
            )
        }
        .padding(.horizontal, 20)
        .padding(.top, 16)
        .padding(.bottom, 10)
    }

    // MARK: - 状态提示（项目失败 / 无项目 / 内容失败 / 刷新失败）

    @ViewBuilder
    private var stateBanners: some View {
        switch store.projectGate {
        case .failed(let message):
            VStack(alignment: .leading, spacing: 8) {
                NoticeRow(kind: .failure, message: "项目列表加载失败：\(message)")
                Button {
                    store.requestRefresh()
                } label: {
                    Label("重试", systemImage: "arrow.clockwise")
                }
            }
        case .noProjects:
            NoticeRow(
                kind: .warning,
                message: "当前账号在这个后端上没有可见项目（`/projects/manage` 返回空列表）——"
                    + "广告数据的所有端点都要求项目（在路径里），没有项目就没有可查的原始行。"
            )
        case .pending, .ready:
            if let failure = store.failureMessage {
                VStack(alignment: .leading, spacing: 8) {
                    NoticeRow(kind: .failure, message: failure)
                    Button {
                        store.requestRefresh()
                    } label: {
                        Label("重试", systemImage: "arrow.clockwise")
                    }
                }
            }
            if let refreshFailure = store.refreshFailure {
                NoticeRow(
                    kind: .warning,
                    message: "本次刷新失败，下表仍是上一次的数据：\(refreshFailure)"
                )
            }
        }
    }

    // MARK: - 正文

    @ViewBuilder
    private var content: some View {
        switch AdDataContent.resolve(
            gate: store.projectGate,
            content: store.contentState,
            reportLabel: store.selectedReportType.label
        ) {
        case .loading(let text):
            loadingRow(text)
        case .notice(let message):
            NoticeRow(kind: .warning, message: message)
        case .blocked:
            EmptyView()
        case .ready:
            readyContent
        }
    }

    private func loadingRow(_ text: String) -> some View {
        HStack(spacing: 10) {
            ProgressView().controlSize(.small)
            Text(text)
                .font(.callout)
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(.vertical, 30)
    }

    /// 有数据时的正文（只由 `AdDataContent.ready` 进入；空态在 `content` 里就已经走掉
    /// `notice` 那一支，不会到这里）。
    @ViewBuilder
    private var readyContent: some View {
        let page = store.tablePage

        VStack(alignment: .leading, spacing: 10) {
            if store.isTruncated {
                // 口径 2：顶到上限就明说可能被截断，不静默当作完整数据。
                NoticeRow(
                    kind: .warning,
                    message: "本页已顶到单次拉取上限 \(AdDataCatalog.pageLimit) 行 —— 可能被截断"
                        + "（按 `report_end_date DESC` 取前 \(AdDataCatalog.pageLimit) 行，"
                        + "服务端不返回窗口内总行数）。要完整数据请缩小日期范围后重试。"
                )
            }
            if page.isEmpty {
                // 有数据但被搜索过滤空了：搜索是客户端行为，与「该类型无数据」是两回事。
                NoticeRow(
                    kind: .warning,
                    message: "本页 \(store.returnedRowCount) 行里没有匹配「\(store.search)」的内容"
                        + "（搜索只在已拉取的这一页数据上做，不改变后端查询）。"
                )
            } else {
                GroupBox {
                    AdDataTable(store: store, page: page)
                        .padding(4)
                } label: {
                    Text("\(store.selectedReportType.label)原始行")
                }
                AdDataPagingBar(store: store, page: page)
            }
        }
    }

    // MARK: - 加载

    private func reload() async {
        guard let provider = model.adDataProvider() else {
            store.failWithoutCredential()
            return
        }
        await store.load(
            using: provider,
            scope: navigation.tasks,
            key: navigation.selectionTaskKey
        )
    }
}

extension AppModel {
    /// 广告数据源：用当前会话（key + 账号上下文）构造；未登录返回 nil。
    ///
    /// 与 S5.1 的 `adAnalysisProvider()` 同样复用 `AppModel` 的 `URLSession` ——
    /// 单测用打桩 session 跑通链路时，模块请求必须走同一个 session。
    func adDataProvider() -> AdDataClient? {
        guard let client = makeAPIClient() else { return nil }
        return AdDataClient(client: client)
    }
}
