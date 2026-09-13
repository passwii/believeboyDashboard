import BelieveBoyKit
import SwiftUI

/// 根视图：按登录态选页面。
///
/// `.restoring` 分支**绝不能渲染登录表单** —— 验收 1 要求「冷启动凭据有效 →
/// 直进主界面（不闪登录页）」。目前 `AppModel` 的会话恢复在 `init` 里同步完成
/// （钥匙串读取是同步 API），该状态实际不可达；保留它是为了让这条契约**结构上**
/// 成立：将来若把恢复改成异步（例如启动时先验一次 key），也不会顺手把登录页
/// 闪给已登录用户。
public struct RootView: View {
    private let model: AppModel

    public init(model: AppModel) {
        self.model = model
    }

    public var body: some View {
        switch model.sessionState {
        case .restoring:
            restoringPlaceholder
        case .signedOut:
            LoginView(model: model)
        case .signedIn:
            HealthView(model: model)
        }
    }

    private var restoringPlaceholder: some View {
        VStack(spacing: 10) {
            ProgressView()
            Text("正在恢复登录状态…")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .frame(minWidth: 640, minHeight: 520)
    }
}
