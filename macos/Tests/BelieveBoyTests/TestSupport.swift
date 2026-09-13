import BelieveBoyKit
import Foundation

/// 内存会话存储：测试专用。
///
/// 为什么不用真钥匙串跑单测：`swift test` 常在没有签名 / GUI 会话的环境里跑，
/// `SecItemAdd` 会以 `errSecMissingEntitlement` / `errSecInteractionNotAllowed`
/// 失败，让「登录逻辑」的用例变成「钥匙串环境」的用例。「登录成功是否入库」在
/// 这一层用内存实现断言，真钥匙串另有一条单独的真实往返用例（见
/// `SessionStoreTests.testKeychainRoundTripStoresAndRestoresSession`）。
///
/// `@unchecked Sendable` + 锁：`SessionStore` 的方法签名是同步 `throws`，用不了
/// actor；测试会从 `@MainActor` 与 `Task` 两侧访问，故显式加锁。
final class InMemorySessionStore: SessionStore, @unchecked Sendable {
    /// 注入失败用：验证失败路径（读不到 / 写不进钥匙串）不会污染登录逻辑。
    enum InjectedFailure: Error, Equatable {
        case load
        case save
        case clear
    }

    private let lock = NSLock()
    private var stored: AuthSession?
    private var loadFailure: Error?
    private var saveFailure: Error?
    private var clearFailure: Error?
    private var saveCount = 0
    private var clearCount = 0

    /// 注入读取失败。
    func failLoading(with error: Error) { setFailure(error, to: \.loadFailure) }
    /// 注入写入失败。
    func failSaving(with error: Error) { setFailure(error, to: \.saveFailure) }
    /// 注入清除失败。
    func failClearing(with error: Error) { setFailure(error, to: \.clearFailure) }

    var session: AuthSession? { withLock { stored } }
    var saveCalls: Int { withLock { saveCount } }
    var clearCalls: Int { withLock { clearCount } }

    func loadSession() throws -> AuthSession? {
        let failure = withLock { loadFailure }
        if let failure { throw failure }
        return withLock { stored }
    }

    func saveSession(_ session: AuthSession) throws {
        let failure = withLock { saveFailure }
        if let failure { throw failure }
        withLock {
            saveCount += 1
            stored = session
        }
    }

    func clearSession() throws {
        let failure = withLock { clearFailure }
        if let failure { throw failure }
        withLock {
            clearCount += 1
            stored = nil
        }
    }

    private func setFailure(_ error: Error, to keyPath: ReferenceWritableKeyPath<InMemorySessionStore, Error?>) {
        withLock { self[keyPath: keyPath] = error }
    }

    private func withLock<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}

extension AuthenticatedUser {
    /// 测试用管理员档案（字段取自测试库 `test_admin@believeboy.com` 的形态）。
    static let fixtureAdmin = AuthenticatedUser(
        id: "0f7d5c9a-1b2c-3d4e-5f60-718293a4b5c6",
        name: "测试管理员",
        email: "test_admin@believeboy.com",
        operatorNameZh: "测试管理员",
        isAdmin: true,
        roleType: "admin"
    )

    /// 测试用非管理员档案。
    static let fixtureOperator = AuthenticatedUser(
        id: "1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809",
        name: "李四",
        email: "test_operator@believeboy.com",
        operatorNameZh: nil,
        isAdmin: false,
        roleType: "operator"
    )
}
