import BelieveBoyKit
import SwiftUI

/// 二级项的占位视图：把「这条在 Web 上是什么」和「桌面端现在是什么状态」讲清楚。
///
/// 三条刻意的约定：
/// - **不发任何请求**。占位期后端契约还没被逐个核对（S4+ 才逐模块搬），此时发请求只会
///   把「未实现」伪装成「加载中 / 加载失败」。副作用正好是验收 2 的强保证：占位视图
///   在切换时根本没有可泄漏的请求。
/// - **不伪造端点表**。Web 路由（`item.route`）是从权威文件抄来的事实，而「这条对应哪个
///   后端端点」需要逐模块核对（同一个 Web 页可能打多个端点）—— 先不写，S4 起随模块一起
///   落地，免得把猜出来的映射当契约传播。
/// - **动态徽标只留语义位**（`requiresLiveData`）。CRM「待跟进」的真实数字要拉数据才有，
///   占位期显示一个编造的 `0` 比不显示更糟。
struct ModulePlaceholderView: View {
    let group: NavigationGroup
    let item: NavigationItem

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header
                facts
                if item.requiresLiveData {
                    NoticeRow(
                        kind: .warning,
                        message: "该条目在 Web 端标题右侧挂动态徽标（待跟进逾期数）。占位期只保留语义位，"
                            + "不显示编造的数字；接数据在 S4+ 与本模块一起做。"
                    )
                }
                nextStepNote
            }
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(minWidth: 420, minHeight: 360)
        // 故意没有 `.task` / 没有 store 调用：占位视图不发起任何请求。
        // S4 起模块自己的加载必须走 `NavigationStore.tasks`（按 route id 登记），
        // 这样切换模块时由外壳统一取消，而不是靠每个模块自觉。
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(group.label)
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
            HStack(spacing: 10) {
                Image(systemName: item.symbol)
                    .font(.title3)
                    .foregroundStyle(.secondary)
                Text(item.title)
                    .font(.title2.weight(.semibold))
                Text("未实现")
                    .font(.caption.weight(.medium))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(.quaternary, in: Capsule())
            }
        }
    }

    private var facts: some View {
        GroupBox("对照信息") {
            VStack(alignment: .leading, spacing: 10) {
                LabeledContent("Web 路由") {
                    Text(item.route)
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                }
                if !item.matchPrefixes.isEmpty {
                    LabeledContent("高亮前缀") {
                        Text(item.matchPrefixes.joined(separator: " · "))
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }
                LabeledContent("桌面端状态") {
                    Text("未实现（占位视图，不发请求）")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(6)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var nextStepNote: some View {
        Text("这个页面在 Web 端已存在；桌面端按 PLAN §8 逐模块搬运（S4 起）。")
            .font(.caption)
            .foregroundStyle(.secondary)
    }
}
