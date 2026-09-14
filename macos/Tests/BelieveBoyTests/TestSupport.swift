import BelieveBoyKit
import Foundation

/// 内存外壳状态存储：测试专用（理由同 `InMemorySessionStore`：不要把开发机的真实
/// `UserDefaults` 卷进来，也不要让用例之间互相污染）。
final class InMemoryShellPreferencesStore: ShellPreferencesStore, @unchecked Sendable {
    private let lock = NSLock()
    private var stored: ShellPreferences?
    private var saveCount = 0

    init(seeded: ShellPreferences? = nil) {
        stored = seeded
    }

    var preferences: ShellPreferences? { withLock { stored } }
    /// 写入次数 —— 用于断言「值没变就不重复写」。
    var saveCalls: Int { withLock { saveCount } }

    func loadPreferences() -> ShellPreferences? { withLock { stored } }

    func savePreferences(_ preferences: ShellPreferences) {
        withLock {
            stored = preferences
            saveCount += 1
        }
    }

    private func withLock<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}

/// 取消事件记录器：跨 actor 写、断言里读，故加锁。
///
/// 不用 `XCTestExpectation`：它要在 `@Sendable` 的 `onCancel` 闭包里被捕获，
/// Swift 6 严格并发下会直接报错，而这里只需要一个 bool。
final class CancellationRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    var isCancelled: Bool { withLock { count > 0 } }
    var cancellationCount: Int { withLock { count } }

    func markCancelled() {
        withLock { count += 1 }
    }

    private func withLock<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}

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

/// 内存「记住密码」存储：测试专用（理由同 `InMemorySessionStore`）。
final class InMemoryRememberedLoginStore: RememberedLoginStore, @unchecked Sendable {
    private let lock = NSLock()
    private var stored: RememberedLogin?
    private var loadFailure: Error?
    private var saveFailure: Error?
    private var deleteCount = 0

    init(seeded: RememberedLogin? = nil) {
        stored = seeded
    }

    /// 注入读取失败（验证「钥匙串读不到」不得挡住登录）。
    func failLoading(with error: Error) { withLock { loadFailure = error } }
    /// 注入写入失败。
    func failSaving(with error: Error) { withLock { saveFailure = error } }

    var login: RememberedLogin? { withLock { stored } }
    var deleteCalls: Int { withLock { deleteCount } }

    func loadLogin() throws -> RememberedLogin? {
        let failure = withLock { loadFailure }
        if let failure { throw failure }
        return withLock { stored }
    }

    func saveLogin(_ login: RememberedLogin) throws {
        let failure = withLock { saveFailure }
        if let failure { throw failure }
        withLock { stored = login }
    }

    func deleteLogin() throws {
        withLock {
            deleteCount += 1
            stored = nil
        }
    }

    private func withLock<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }
}

/// 内存设备标识存储：测试专用（理由同 `InMemorySessionStore`）。
///
/// 「同一台机器重启进程后仍用同一个标识」这类用例靠它把「盘」留下来：用例之间
/// 传同一个实例即可，不必碰开发机真实钥匙串（真钥匙串另有一条往返用例，见
/// `ClientIdentifierTests`）。
final class InMemoryClientIdentifierStore: ClientIdentifierStore, @unchecked Sendable {
    private let lock = NSLock()
    private var stored: String?
    private var loadFailure: Error?
    private var saveFailure: Error?
    private var saveCount = 0

    init(seeded: String? = nil) {
        stored = seeded
    }

    /// 注入读取失败（钥匙串被锁 / 权限被拒）。
    func failLoading(with error: Error) { withLock { loadFailure = error } }
    /// 注入写入失败。
    func failSaving(with error: Error) { withLock { saveFailure = error } }

    var clientID: String? { withLock { stored } }
    var saveCalls: Int { withLock { saveCount } }

    func loadClientID() throws -> String? {
        let failure = withLock { loadFailure }
        if let failure { throw failure }
        return withLock { stored }
    }

    func saveClientID(_ clientID: String) throws {
        let failure = withLock { saveFailure }
        if let failure { throw failure }
        withLock {
            saveCount += 1
            stored = clientID
        }
    }

    func deleteClientID() throws {
        withLock { stored = nil }
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
