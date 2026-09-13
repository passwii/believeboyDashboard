import BelieveBoyKit
import SwiftUI

/// 登录页：邮箱 + 密码 → `POST /api/v1/auth/login` → `blf_` key 入钥匙串。
///
/// 页面刻意只有一件事：换到一把可用的凭据。服务器地址放在卡片底部作为次要信息
/// （默认生产，本地调试才需要改），不与主操作抢层级。
public struct LoginView: View {
    private let model: AppModel

    public init(model: AppModel) {
        self.model = model
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                AppBrandHeader(subtitle: "登录")
                loginCard
            }
            .frame(maxWidth: 460, alignment: .leading)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 48)
            .padding(.horizontal, 28)
        }
        .frame(minWidth: 640, minHeight: 520)
    }

    // MARK: - 卡片

    private var loginCard: some View {
        VStack(alignment: .leading, spacing: 16) {
            // 被动回到登录页时（凭据被顶掉），先讲清"为什么在这里"。
            // 没有这句话，用户只会看到登录表单，不知道自己刚被踢掉。
            if let reason = model.sessionState.signedOutReason {
                NoticeRow(kind: .warning, message: reason)
            }
            if let notice = model.sessionNotice {
                NoticeRow(kind: .warning, message: notice)
            }

            field(title: "邮箱", hint: "yawei@believeboy.com") {
                TextField("", text: model.binding(for: \.emailDraft))
                    .textFieldStyle(.roundedBorder)
                    .textContentType(.username)
                    .onSubmit(submit)
            }

            field(title: "密码", hint: "与网页端一致") {
                SecureField("", text: model.binding(for: \.passwordDraft))
                    .textFieldStyle(.roundedBorder)
                    .textContentType(.password)
                    .onSubmit(submit)
            }

            Button(action: submit) {
                HStack(spacing: 8) {
                    if model.isSigningIn {
                        ProgressView().controlSize(.small)
                    }
                    Text(model.isSigningIn ? "登录中…" : "登录")
                        .frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(model.isSigningIn || !canSubmit)

            if let error = model.loginError {
                NoticeRow(kind: .failure, message: error)
            }

            Text("密码只用于本次登录请求，不落盘、不进日志。登录下发的 `blf_` 凭据存入 macOS 钥匙串。")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            Divider()
            serverSection
        }
        .padding(18)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12).strokeBorder(.separator)
        )
    }

    private var canSubmit: Bool {
        model.emailDraft.trimmedNonEmpty != nil && !model.passwordDraft.isEmpty
    }

    private func field<Content: View>(
        title: String,
        hint: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(title).font(.callout.weight(.medium))
                Text(hint)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            content()
        }
    }

    // MARK: - 服务器

    private var serverSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Picker("服务器", selection: model.binding(for: \.environment)) {
                ForEach(AppConfig.Environment.allCases) { environment in
                    Text(environment.displayName).tag(environment)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .disabled(model.customBaseURL.trimmedNonEmpty != nil)

            HStack(spacing: 8) {
                TextField(
                    "自定义地址（根地址、不含路径；留空则用上方服务器）",
                    text: model.binding(for: \.customBaseURL)
                )
                .textFieldStyle(.roundedBorder)
                .font(.callout)
                Button("清除") { model.customBaseURL = "" }
                    .disabled(model.customBaseURL.isEmpty)
            }

            Text("登录将发往：\(model.effectiveBaseURL.absoluteString)\(APIClient.apiPrefix)/auth/login")
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
        }
    }

    private func submit() {
        guard !model.isSigningIn else { return }
        Task { await model.signIn() }
    }
}
