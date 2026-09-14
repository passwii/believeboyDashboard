import BelieveBoyKit
import SwiftUI

/// `ShellColumnVisibility`（Kit 层）↔ `NavigationSplitViewVisibility`（SwiftUI）映射。
///
/// Kit 不 `import SwiftUI`（分层铁律，见 PLAN §7），所以持久化用的是自带枚举；
/// 两边只在这一处对接，加 case 时会编译报错而不是静默丢状态。
extension NavigationSplitViewVisibility {
    init(_ visibility: ShellColumnVisibility) {
        switch visibility {
        case .automatic: self = .automatic
        case .all: self = .all
        case .doubleColumn: self = .doubleColumn
        case .detailOnly: self = .detailOnly
        }
    }

    var shellVisibility: ShellColumnVisibility {
        switch self {
        case .all: return .all
        case .doubleColumn: return .doubleColumn
        case .detailOnly: return .detailOnly
        default: return .automatic
        }
    }
}

/// 视图 → store 的显式 `Binding` 集合。
///
/// 视图层不用属性包装器宏（CLT 约束，见 Package.swift 顶部）：选择态、折叠态都住在
/// `NavigationStore`，视图只读 + 通过这里的绑定回调走 store 的**命令式**方法。
/// 因此每次 set 都能带上副作用（切换时取消上一个模块的任务、立即落盘），这是
/// `@State` 方案做不到的 —— 也是本 stage 探针要验证的点（PLAN §8 S3）。
@MainActor
extension NavigationStore {
    /// 侧栏分组选择。`List` 会写入 `nil`（点空白处取消选择），这里当作「回到概览」。
    var groupSelection: Binding<String?> {
        Binding(
            get: { self.selectedGroupID },
            set: { newValue in
                if let newValue {
                    self.select(groupID: newValue)
                } else {
                    self.showOverview()
                }
            }
        )
    }

    /// 内容栏二级项选择。
    var itemSelection: Binding<String?> {
        Binding(
            get: { self.selectedRouteID },
            set: { newValue in
                guard let newValue else { return }
                self.select(routeID: newValue)
            }
        )
    }

    /// 三栏可见性（侧栏折叠态由此落盘，`⌘⌥S` 也在内）。
    var splitViewVisibility: Binding<NavigationSplitViewVisibility> {
        Binding(
            get: { NavigationSplitViewVisibility(self.columnVisibility) },
            set: { self.setColumnVisibility($0.shellVisibility) }
        )
    }

    /// 偏好设置浮层开关。
    var preferencesPresented: Binding<Bool> {
        Binding(
            get: { self.isPreferencesPresented },
            set: { self.setPreferencesPresented($0) }
        )
    }
}
