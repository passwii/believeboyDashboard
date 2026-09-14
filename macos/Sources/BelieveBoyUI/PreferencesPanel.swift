import BelieveBoyKit
import SwiftUI

/// 偏好设置浮层：后端地址（生产 / 本地）+ 自定义地址。
///
/// **不新增能力**（BLF-1051 口径一）：这块 UI 与 `LoginView` 页脚的服务器选择同源，
/// 是 S1 起就存在的「收编」——只是把它从主界面正文挪进外壳的偏好设置，不再占用
/// 连接检查那一屏的层级。因此本 stage 不扩期、不做独立偏好设置窗口（PLAN §2.1）。
struct PreferencesPanel: View {
    private let model: AppModel
    private let navigation: NavigationStore

    init(model: AppModel, navigation: NavigationStore) {
        self.model = model
        self.navigation = navigation
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("偏好设置")
                .font(.headline)

            Picker("环境", selection: model.binding(for: \.environment)) {
                ForEach(AppConfig.Environment.allCases) { environment in
                    Text(environment.shortName).tag(environment)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .disabled(model.customBaseURL.trimmedNonEmpty != nil)

            HStack(spacing: 8) {
                TextField(
                    "自定义地址（根地址、不含路径；留空则用上方环境）",
                    text: model.binding(for: \.customBaseURL)
                )
                .textFieldStyle(.roundedBorder)
                Button("清除") { model.customBaseURL = "" }
                    .disabled(model.customBaseURL.isEmpty)
            }

            LabeledContent("请求前缀") {
                Text(model.effectiveBaseURL.absoluteString + APIClient.apiPrefix)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }

            Text("切换环境后会重新检查连接。")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(16)
        .frame(width: 380)
        // 换环境 = 换后端，之前的检查结果立刻过期。这次刷新挂在**当前选中项**的任务
        // key 下：用户切走（去别的模块）时由外壳统一取消，不会有一个「旧环境的探测」
        // 在后台跑完再覆盖新环境的结果。
        .onChange(of: model.environment) { _, _ in
            navigation.tasks.run(key: navigation.selectionTaskKey) {
                await model.checkConnection()
            }
        }
    }
}
