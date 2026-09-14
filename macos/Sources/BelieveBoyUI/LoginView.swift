import BelieveBoyKit
import SwiftUI

/// 登录页：邮箱 + 密码 → `POST /api/v1/auth/login` → `blf_` key 入钥匙串。
///
/// 版式刻意贴近 macOS 自己的登录窗口：**窄栏居中、无说明性长文案**。页面上只留两类
/// 文字，且都只在需要时出现 —— 「为什么回到了登录页」（凭据被网页端顶掉，不解释用户
/// 会以为是自己没权限）与「登录为什么失败」。其余解释性内容（凭据存哪、密码去向、
/// 服务器地址）都收进折叠区、脚注或文档，不与主操作抢层级。
public struct LoginView: View {
    private let model: AppModel

    public init(model: AppModel) {
        self.model = model
    }

    public var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 24)
            header
                .padding(.bottom, 28)
            form
            Spacer(minLength: 24)
            footer
        }
        .frame(maxWidth: 340)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, 32)
        .padding(.vertical, 24)
        .frame(minWidth: 420, minHeight: 480)
    }

    // MARK: - 品牌区

    private var header: some View {
        VStack(spacing: 12) {
            BrandMark(size: 64)
            VStack(spacing: 3) {
                Text("BelieveBoy")
                    .font(.title2.weight(.semibold))
                Text("登录以继续")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - 表单

    private var form: some View {
        VStack(alignment: .leading, spacing: 14) {
            // 被动回到登录页时（凭据被顶掉）必须先讲清"为什么在这里"，否则用户只会
            // 看到一张凭空出现的登录表单。
            if let reason = model.sessionState.signedOutReason {
                NoticeRow(kind: .warning, message: reason)
            }
            if let notice = model.sessionNotice {
                NoticeRow(kind: .warning, message: notice)
            }

            LabeledField("邮箱") {
                TextField("", text: model.binding(for: \.emailDraft))
                    .textFieldStyle(.roundedBorder)
                    .controlSize(.large)
                    .textContentType(.username)
                    .onSubmit(submit)
            }

            LabeledField("密码") {
                SecureField("", text: model.binding(for: \.passwordDraft))
                    .textFieldStyle(.roundedBorder)
                    .controlSize(.large)
                    .textContentType(.password)
                    .onSubmit(submit)
            }

            Toggle(
                "记住密码",
                isOn: Binding(
                    get: { model.rememberPassword },
                    set: { model.setRememberPassword($0) }
                )
            )
            .toggleStyle(.checkbox)
            .font(.callout)

            if let error = model.loginError {
                NoticeRow(kind: .failure, message: error)
            }

            Button(action: submit) {
                HStack(spacing: 8) {
                    if model.isSigningIn {
                        ProgressView().controlSize(.small)
                    }
                    Text(model.isSigningIn ? "登录中…" : "登录")
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .keyboardShortcut(.defaultAction)
            .disabled(model.isSigningIn || !canSubmit)
            .padding(.top, 2)
        }
    }

    private var canSubmit: Bool {
        model.emailDraft.trimmedNonEmpty != nil && !model.passwordDraft.isEmpty
    }

    // MARK: - 页脚：服务器选择（默认折叠）+ 一句话交代凭据去向

    private var footer: some View {
        VStack(spacing: 10) {
            serverOptions
            Text("凭据保存在 macOS 钥匙串。")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    @ViewBuilder
    private var serverOptions: some View {
        DisclosureGroup(isExpanded: model.binding(for: \.isServerOptionsExpanded)) {
            VStack(alignment: .leading, spacing: 10) {
                Picker("服务器", selection: model.binding(for: \.environment)) {
                    ForEach(AppConfig.Environment.allCases) { environment in
                        Text(environment.shortName).tag(environment)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .disabled(model.customBaseURL.trimmedNonEmpty != nil)

                HStack(spacing: 8) {
                    TextField(
                        "自定义地址（根地址，留空用上方服务器）",
                        text: model.binding(for: \.customBaseURL)
                    )
                    .textFieldStyle(.roundedBorder)
                    .controlSize(.small)
                    Button("清除") { model.customBaseURL = "" }
                        .controlSize(.small)
                        .disabled(model.customBaseURL.isEmpty)
                }

                Text(model.effectiveBaseURL.absoluteString + APIClient.apiPrefix)
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .textSelection(.enabled)
            }
            .padding(.top, 10)
        } label: {
            Text("服务器：\(model.serverDisplayName)")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func submit() {
        guard !model.isSigningIn else { return }
        Task { await model.signIn() }
    }
}
