import BelieveBoyKit
import SwiftUI

/// 应用外壳：`NavigationSplitView` 三栏（分组 / 二级项 / 模块内容）。
///
/// 结构对齐 `frontend/lib/sidebar-config.ts` 的两层语义（PLAN §2.2）：
/// 侧栏 = 8 个分组，内容栏 = 该分组的二级项，详情栏 = 选中项（S3 全是占位视图）。
///
/// 选中态、折叠态都在 `NavigationStore` 里（不是 `@State`）：视图只读，改的时候走
/// `NavigationBindings` 里的命令式 setter，于是「切换选中项时取消上一个模块的任务」
/// 「立即落盘」这类副作用有唯一落点。侧栏折叠、工具栏、`⌘⌥S`、全屏全部交回系统，
/// 不手写窗口 chrome（PLAN §2.1）。
public struct ShellView: View {
    private let model: AppModel
    private let navigation: NavigationStore

    public init(model: AppModel, navigation: NavigationStore) {
        self.model = model
        self.navigation = navigation
    }

    public var body: some View {
        NavigationSplitView(columnVisibility: navigation.splitViewVisibility) {
            sidebar
        } content: {
            itemColumn
        } detail: {
            detailColumn
        }
        .toolbar { toolbarItems }
        // 离开外壳（登出 / 窗口收起）= 模块工作全部作废：继续跑只会在没有会话的情况下
        // 拿一堆 401 回来（而且用户已经把界面交回登录页），与 PLAN §4.1.1 「失效就停」
        // 同口径。任务由 `ModuleTaskScope` 统一收拢，所以这里只需一句话。
        .onDisappear { navigation.tasks.cancelAll() }
    }

    // MARK: - 侧栏：8 个分组

    private var sidebar: some View {
        List(selection: navigation.groupSelection) {
            ForEach(navigation.groups) { group in
                Label(group.label, systemImage: group.symbol)
                    .tag(group.id)
            }
        }
        .navigationSplitViewColumnWidth(min: 180, ideal: 200)
    }

    // MARK: - 内容栏：选中分组的二级项

    @ViewBuilder
    private var itemColumn: some View {
        if let group = navigation.selectedGroup {
            List(selection: navigation.itemSelection) {
                Section {
                    ForEach(group.items) { item in
                        Label(item.title, systemImage: item.symbol)
                            .tag(item.id)
                    }
                } header: {
                    Text("\(group.label) · \(group.items.count) 项")
                }
            }
            .navigationSplitViewColumnWidth(min: 220, ideal: 260)
        } else {
            ContentUnavailableView(
                "未选分组",
                systemImage: "sidebar.left",
                description: Text("在左侧选择一个分组，这里显示它的二级页面。")
            )
        }
    }

    // MARK: - 详情栏

    @ViewBuilder
    private var detailColumn: some View {
        if let group = navigation.selectedGroup, let item = navigation.selectedItem {
            // 已搬运的模块命中路由表（真数据 + 三态）；未命中的仍是占位（零请求）。
            if let module = ModuleRegistry.view(for: item, model: model, navigation: navigation) {
                module
            } else {
                ModulePlaceholderView(group: group, item: item)
            }
        } else if let group = navigation.selectedGroup {
            ContentUnavailableView(
                "\(group.label) 下未选页面",
                systemImage: group.symbol,
                description: Text("在上一个栏里选择一个二级项。")
            )
        } else {
            // 空选中 = 「连接与身份」概览：启动后就位（并顺手跑一次连接检查），
            // 也是桌面端「这条到后端的链路通不通、以谁的身份连」的常驻入口。
            HealthView(model: model)
        }
    }

    // MARK: - 工具栏

    @ToolbarContentBuilder
    private var toolbarItems: some ToolbarContent {
        ToolbarItemGroup(placement: .primaryAction) {
            Button {
                navigation.showOverview()
            } label: {
                Label("连接与身份", systemImage: "person.crop.circle")
            }
            .help("回到连接与身份概览（账户信息 + 连接检查）")

            Button {
                navigation.setPreferencesPresented(!navigation.isPreferencesPresented)
            } label: {
                Label("偏好设置", systemImage: "gearshape")
            }
            .help("后端地址（生产 / 本地）")
            .popover(isPresented: navigation.preferencesPresented, arrowEdge: .bottom) {
                PreferencesPanel(model: model, navigation: navigation)
            }
        }
    }
}
