import BelieveBoyKit
import SwiftUI

/// Stage 1 主界面：连接配置 + 后端健康检查。
///
/// 三栏导航外壳属 Stage 3（见 PLAN.md §8），此处刻意不做 —— 先证明"能起、
/// 能连"，再谈信息架构。
///
/// 视图不使用 `@State` / `@Bindable` 等属性包装器宏（工具链约束，见 Package.swift
/// 顶部说明）：`model` 以普通常量持有，`@Observable` 自带的读取追踪负责失效重绘，
/// 需要双向绑定的控件用显式 `Binding` 构造。
public struct RootView: View {
    private let model: AppModel

    public init(model: AppModel) {
        self.model = model
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header
                endpointSection
                credentialSection
                connectionSection
            }
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(minWidth: 640, minHeight: 520)
        .task { await model.checkConnection() }
    }

    // MARK: - 头部

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Image(systemName: "square.grid.2x2.fill")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(.tint)
                Text("BelieveBoy 桌面端")
                    .font(.title2.weight(.semibold))
                Text("Stage 1 · 骨架")
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

    // MARK: - 后端地址

    private var endpointSection: some View {
        GroupBox("后端地址") {
            VStack(alignment: .leading, spacing: 12) {
                Picker("环境", selection: binding(for: \.environment)) {
                    ForEach(AppConfig.Environment.allCases) { environment in
                        Text(environment.displayName).tag(environment)
                    }
                }
                .pickerStyle(.segmented)
                .disabled(model.customBaseURL.trimmedNonEmpty != nil)
                .onChange(of: model.environment) { _, _ in
                    Task { await model.checkConnection() }
                }

                HStack(spacing: 8) {
                    TextField("自定义地址（根地址、不含路径；留空则用上方环境）", text: binding(for: \.customBaseURL))
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
            }
            .padding(6)
        }
    }

    // MARK: - 凭据

    private var credentialSection: some View {
        GroupBox("API 凭据") {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    SecureField("粘贴 API key（backend/.env 的 API_KEY，或登录下发的 blf_ key）", text: binding(for: \.apiKeyDraft))
                        .textFieldStyle(.roundedBorder)
                    Button("保存到钥匙串") { model.saveCredential() }
                        .disabled(model.apiKeyDraft.trimmedNonEmpty == nil)
                    Button("清除") { model.clearCredential() }
                }

                HStack(spacing: 6) {
                    Image(systemName: model.hasStoredCredential ? "checkmark.seal.fill" : "exclamationmark.triangle.fill")
                        .foregroundStyle(model.hasStoredCredential ? Color.green : Color.orange)
                    Text(model.hasStoredCredential ? "钥匙串中已有凭据" : "尚未配置凭据")
                        .font(.callout)
                    if let message = model.credentialMessage {
                        Text(message)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                }
                Text("凭据存于 macOS 钥匙串（kSecClassGenericPassword），不写入 UserDefaults，也不出现在日志中。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(6)
        }
    }

    // MARK: - 连接检查

    private var connectionSection: some View {
        GroupBox("连接检查") {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 10) {
                    Button {
                        Task { await model.checkConnection() }
                    } label: {
                        Label("检查连接", systemImage: "bolt.horizontal.circle")
                    }
                    .disabled(model.phase.isChecking)

                    if model.phase.isChecking {
                        ProgressView().controlSize(.small)
                    }
                    Spacer()
                    if let snapshot = model.phase.snapshot, let latency = snapshot.healthLatencyMs {
                        Text("\(latency) ms")
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.secondary)
                    }
                }

                if let snapshot = model.phase.snapshot {
                    resultRows(for: snapshot)
                } else if let block = model.phase.credentialBlock {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(Color.orange)
                        Text("检查未发起：\(block)")
                            .font(.callout)
                    }
                } else if !model.phase.isChecking {
                    Text("按 ⌘R 或点击「检查连接」发起探测。")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(6)
        }
    }

    @ViewBuilder
    private func resultRows(for snapshot: HealthSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            statusRow(
                title: "进程存活 /health/live",
                ok: snapshot.live != nil,
                detail: snapshot.live.map { $0.status } ?? snapshot.liveError?.displayMessage ?? "未请求"
            )
            statusRow(
                title: "完整健康 /health（含鉴权）",
                ok: snapshot.health?.isOverallHealthy ?? false,
                detail: snapshot.health.map { health in
                    let summary = "status=\(health.status) · env=\(health.version ?? "unknown")"
                    return health.isOverallHealthy ? summary : summary + " · 存在异常依赖，见下方明细"
                } ?? snapshot.healthError?.displayMessage ?? "未请求"
            )
            if let health = snapshot.health {
                statusRow(title: "主库", ok: health.isDatabaseHealthy, detail: health.database)
                statusRow(title: "只读副本", ok: health.isReplicaHealthy, detail: health.databaseReplica)
                statusRow(title: "Redis", ok: health.isEmptyOrHealthyRedis, detail: health.redis)
                if let memory = health.redisMemory {
                    statusRow(title: "Redis 内存", ok: health.isRedisMemoryUsable, detail: memory)
                }
            }
        }
    }

    private func statusRow(title: String, ok: Bool, detail: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: ok ? "checkmark.circle.fill" : "xmark.octagon.fill")
                .foregroundStyle(ok ? Color.green : Color.red)
            Text(title)
                .font(.callout.weight(.medium))
                .frame(width: 200, alignment: .leading)
            Text(detail)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// 显式双向绑定（替代 `@Bindable`）。`@Observable` 的 setter 会在赋值时通知观察者，
    /// 因此与属性包装器生成的绑定行为一致。
    private func binding<T>(for keyPath: ReferenceWritableKeyPath<AppModel, T>) -> Binding<T> {
        Binding(
            get: { model[keyPath: keyPath] },
            set: { model[keyPath: keyPath] = $0 }
        )
    }
}
