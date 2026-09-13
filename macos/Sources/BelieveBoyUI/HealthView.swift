import BelieveBoyKit
import SwiftUI

/// 登录后的主界面：账号信息 + 后端地址 + 连接检查。
///
/// 三栏导航外壳属 Stage 3（见 PLAN.md §8），此处刻意不做 —— 先证明"能起、
/// 能连、以谁的身份连"，再谈信息架构。
///
/// 视图不使用 `@State` / `@Bindable` 等属性包装器宏（工具链约束，见 Package.swift
/// 顶部说明）：`model` 以普通常量持有，`@Observable` 自带的读取追踪负责失效重绘，
/// 需要双向绑定的控件用显式 `Binding` 构造。
public struct HealthView: View {
    private let model: AppModel

    public init(model: AppModel) {
        self.model = model
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                AppBrandHeader(subtitle: "Stage 2 · 登录与会话")
                accountSection
                endpointSection
                connectionSection
            }
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(minWidth: 640, minHeight: 520)
        // 冷启动带有效凭据时，本视图直接就位，`.task` 顺手发起首次探测 ——
        // 用户看不到登录页，也不需要手动点一下。
        .task { await model.checkConnection() }
    }

    // MARK: - 账号

    private var accountSection: some View {
        GroupBox("当前身份") {
            VStack(alignment: .leading, spacing: 12) {
                if let user = model.currentUser {
                    LabeledContent("账号") {
                        Text("\(user.operatorNameZh?.trimmedNonEmpty ?? user.name) · \(user.email)")
                            .font(.system(.caption, design: .monospaced))
                            .textSelection(.enabled)
                    }
                    LabeledContent("角色") {
                        Text(user.isAdmin ? "\(user.roleType)（管理员）" : user.roleType)
                            .font(.system(.caption, design: .monospaced))
                    }
                    LabeledContent("用户 ID") {
                        Text(user.id)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                    Text("请求会带上 X-Operator / X-User-Id / X-Is-Admin，后端据此按账号过滤可见数据。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    // 环境变量凭据（BELIEVEBOY_API_KEY）：有 key，没有账号档案。
                    NoticeRow(
                        kind: .warning,
                        message: "当前凭据来自环境变量 BELIEVEBOY_API_KEY：可发请求，但没有账号上下文，"
                            + "因此不发 X-Operator 一族请求头，后端会按「未声明操作员」过滤数据。"
                            + "改用登录可拿到完整账号身份。"
                    )
                }

                if let notice = model.sessionNotice {
                    NoticeRow(kind: .warning, message: notice)
                }

                HStack(spacing: 10) {
                    Button {
                        model.signOut()
                    } label: {
                        Label("退出登录", systemImage: "rectangle.portrait.and.arrow.right")
                    }
                    Text("退出会清除钥匙串中的凭据。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(6)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: - 后端地址

    private var endpointSection: some View {
        GroupBox("后端地址") {
            VStack(alignment: .leading, spacing: 12) {
                Picker("环境", selection: model.binding(for: \.environment)) {
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
                    NoticeRow(kind: .warning, message: "检查未发起：\(block)")
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
}
