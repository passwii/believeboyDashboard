import BelieveBoyKit
import SwiftUI

/// 显式双向绑定（替代 `@Bindable`）。
///
/// 视图层不使用属性包装器宏（`@State` / `@Bindable` / `@Environment`）—— 它们的宏
/// 实现在仅完整 Xcode 提供的 `SwiftUIMacros` 插件里，而本包要求 CLT 下也能构建
/// （见 Package.swift 顶部与 PLAN.md §9）。`@Observable` 的 setter 会在赋值时
/// 通知观察者，因此手写 `Binding` 与属性包装器生成的绑定行为一致。
///
/// 放在 `AppModel` 的扩展上而不是各处私有方法：S2 起登录页与主界面都要绑定同一批
/// 字段，复制两份 `binding(for:)` 只会让两者各自漂移。
extension AppModel {
    func binding<T>(for keyPath: ReferenceWritableKeyPath<AppModel, T>) -> Binding<T> {
        Binding(
            get: { self[keyPath: keyPath] },
            set: { self[keyPath: keyPath] = $0 }
        )
    }
}

/// 顶端品牌区（登录页与主界面共用），保证换页面时视觉基线不跳。
struct AppBrandHeader: View {
    let subtitle: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Image(systemName: "square.grid.2x2.fill")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(.tint)
                Text("BelieveBoy 桌面端")
                    .font(.title2.weight(.semibold))
                Text(subtitle)
                    .font(.caption.weight(.medium))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(.quaternary, in: Capsule())
            }
            Text("原生 macOS 客户端，复用 backend/ 现有 FastAPI 接口。业务模块尚未接入。")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
    }
}

/// 一行状态图标 + 文案，用于错误 / 提示 / 失效说明。
struct NoticeRow: View {
    enum Kind {
        case failure
        case warning
        case success

        var symbol: String {
            switch self {
            case .failure: return "xmark.octagon.fill"
            case .warning: return "exclamationmark.triangle.fill"
            case .success: return "checkmark.seal.fill"
            }
        }

        var color: Color {
            switch self {
            case .failure: return .red
            case .warning: return .orange
            case .success: return .green
            }
        }
    }

    let kind: Kind
    let message: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: kind.symbol)
                .foregroundStyle(kind.color)
            Text(message)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
    }
}
