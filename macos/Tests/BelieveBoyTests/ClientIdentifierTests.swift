import Foundation
import XCTest

import BelieveBoyKit

/// 设备标识（BLF-1060）：生成一次、此后不变、非法存量值不得发出去、钥匙串不可用时
/// **不挡登录**。
///
/// 「重启进程后仍是同一个标识」这条验收在此有两条证据：内存存储的跨实例用例（逻辑
/// 断言）与真钥匙串的往返用例（真机事实，钥匙串不可用时 skip 而非 fail，口径同
/// `SessionStoreTests`）。
final class ClientIdentifierTests: XCTestCase {
    /// 独立 service，避免污染真机的会话条目（`com.believeboy.dashboard.macos`）。
    private static let testService = "com.believeboy.dashboard.macos.selftest"
    /// 独立条目名同理：与真机的 `client-id` 分开。
    private static let testAccount = "client-id-selftest"

    private var keychainStore: KeychainClientIdentifierStore {
        KeychainClientIdentifierStore(service: Self.testService, account: Self.testAccount)
    }

    override func tearDown() {
        try? keychainStore.deleteClientID()
        try? KeychainSessionStore(service: Self.testService).clearSession()
        try? KeychainRememberedLoginStore(service: Self.testService).deleteLogin()
        super.tearDown()
    }

    // MARK: - 生成与稳定

    /// 首次解析：生成一个合法标识并落盘（不是只放在内存里 —— 下次启动必须读回它）。
    func testFirstResolveGeneratesAndPersistsAnIdentifier() {
        let store = InMemoryClientIdentifierStore()

        let identifier = ClientIdentifier.resolve(store: store)

        XCTAssertEqual(store.clientID, identifier.value, "生成的标识必须落盘，否则每次启动都会换一个设备槽")
        XCTAssertEqual(store.saveCalls, 1)
        XCTAssertNil(identifier.persistenceWarning)
        XCTAssertTrue(ClientIdentifier.isValid(identifier.value), "生成的标识必须能过后端校验：\(identifier.value)")
        XCTAssertEqual(identifier.value, identifier.value.lowercased(), "统一小写，避免大小写差异被后端当成两个槽")
        XCTAssertEqual(identifier.value.count, 36, "UUID 字符串形态（8-4-4-4-12）")
        XCTAssertEqual(UUID(uuidString: identifier.value)?.uuidString.lowercased(), identifier.value)
    }

    /// **「重启进程后不变」**：新一次解析（新对象 / 新进程）读回同一个值，且不重写。
    func testResolveReusesTheStoredIdentifierAcrossInstances() {
        let store = InMemoryClientIdentifierStore()
        let first = ClientIdentifier.resolve(store: store)

        let second = ClientIdentifier.resolve(store: store)

        XCTAssertEqual(second.value, first.value, "同一台机器（同一份存储）必须复用同一个设备槽")
        XCTAssertEqual(store.saveCalls, 1, "已有合法值不得反复覆写")
        XCTAssertNil(second.persistenceWarning)
    }

    /// 真钥匙串往返：写进去的标识能被**新的存储实例**读回同一个值 —— 这是「关掉 App
    /// 再打开仍是同一台设备」的真机证据（不是重新生成一个新的）。
    func testKeychainRoundTripKeepsTheSameIdentifier() throws {
        do {
            try keychainStore.deleteClientID()
        } catch let error as CredentialStoreError {
            throw XCTSkip("该环境下钥匙串不可用（\(error.displayMessage)）—— 真机入库需 GUI 会话")
        }

        let first = ClientIdentifier.resolve(store: keychainStore)
        XCTAssertNil(first.persistenceWarning, "该用例的前提是钥匙串可写")
        XCTAssertEqual(try keychainStore.loadClientID(), first.value)

        // 「重启」= 换一个存储实例再解析一次。
        let second = ClientIdentifier.resolve(
            store: KeychainClientIdentifierStore(service: Self.testService, account: Self.testAccount)
        )
        XCTAssertEqual(second.value, first.value, "钥匙串里的标识必须被复用，不得重新生成")
    }

    /// 同一台机器两次登录（退出再登 / 被顶后重登）用的都是同一个标识 —— 登录路径本身
    /// 不该改动它。
    func testRepeatedResolvesAreStableForManyLogins() {
        let store = InMemoryClientIdentifierStore()
        let values = (0..<5).map { _ in ClientIdentifier.resolve(store: store).value }

        XCTAssertEqual(Set(values).count, 1, "五次「登录」必须命中同一个设备槽：\(values)")
        XCTAssertEqual(store.saveCalls, 1)
    }

    /// 设备标识是钥匙串里的**独立条目**：与 key / 账号档案 / 「记住密码」分槽互相不碰。
    ///
    /// 同一 service 下的三个旧条目共存时写入 / 删除标识，其他三个必须逐字不变 ——
    /// 条目名重复（如 account 少一个后缀）会把 key 覆盖掉，而这种错发生一次就是
    /// 「登录后凭据没了」的偶发灵异。
    func testKeychainEntryDoesNotCollideWithTheOtherThreeSlots() throws {
        let credentials = KeychainCredentialStore(service: Self.testService)
        let sessionStore = KeychainSessionStore(service: Self.testService)
        let remembered = KeychainRememberedLoginStore(service: Self.testService)
        let login = RememberedLogin(email: "test_admin@believeboy.com", password: "TestAdmin123")

        do {
            try credentials.saveAPIKey("blf_slot_isolation")
            try remembered.saveLogin(login)
        } catch let error as CredentialStoreError {
            throw XCTSkip("该环境下钥匙串不可用（\(error.displayMessage)）")
        }

        let identifier = ClientIdentifier.resolve(store: keychainStore)

        XCTAssertEqual(try keychainStore.loadClientID(), identifier.value)
        XCTAssertEqual(try credentials.loadAPIKey(), "blf_slot_isolation", "写设备标识不得碰 key 条目")
        XCTAssertEqual(try remembered.loadLogin(), login, "写设备标识不得碰「记住密码」条目")
        XCTAssertEqual(try sessionStore.loadSession()?.apiKey, "blf_slot_isolation")

        // 反向：删掉标识不得连带删掉另外三个。
        try keychainStore.deleteClientID()
        XCTAssertNil(try keychainStore.loadClientID())
        XCTAssertEqual(try credentials.loadAPIKey(), "blf_slot_isolation")
        XCTAssertEqual(try remembered.loadLogin(), login)
    }

    // MARK: - 非法存量值

    /// 钥匙串里的值非法（旧格式 / 被外部改写 / 含空白）时**重新生成**而不是原样发出去
    /// —— 后端对非法 `X-Client-Id` 一律 400，照发等于把用户钉在「登录永远失败」上，
    /// 而用户没有任何界面手段去改这个值。
    func testInvalidStoredIdentifierIsReplacedInsteadOfSentVerbatim() {
        let illegalValues = [
            " 1a2b3c4d ",            // 首尾空白（后端不再 strip）
            "bad id",                // 内部空白
            "bad\tid",               // 制表符
            "bad\nid",               // 换行
            "设备-86a1",              // 非 ASCII
            String(repeating: "a", count: 65),  // 超 64 字符
            "with/slash",            // 不在允许字符集内
        ]

        for illegal in illegalValues {
            let store = InMemoryClientIdentifierStore(seeded: illegal)

            let identifier = ClientIdentifier.resolve(store: store)

            XCTAssertNotEqual(identifier.value, illegal, "非法存量值不得被当成设备标识发出去：\(illegal.debugDescription)")
            XCTAssertNotEqual(
                identifier.value,
                illegal.trimmingCharacters(in: .whitespacesAndNewlines),
                "不得翻默 trim 成另一个合法槽（那会顶掉真正那台设备）：\(illegal.debugDescription)"
            )
            XCTAssertTrue(ClientIdentifier.isValid(identifier.value))
            XCTAssertEqual(store.clientID, identifier.value, "必须把合法值写回，替换掉非法值")
            XCTAssertNil(identifier.persistenceWarning)
        }
    }

    /// 合法存量值原样复用 —— 判据要与后端同口径（`[A-Za-z0-9._:-]`，≤64）。
    func testValidStoredValuesAreReusedVerbatim() {
        let legalValues = [
            "default",
            "macos-01a09fa8-6311-76a4-bcf2-44873b83f75f",
            "UPPER_and.lower:99",
            String(repeating: "a", count: 64),
        ]

        for legal in legalValues {
            let store = InMemoryClientIdentifierStore(seeded: legal)

            let identifier = ClientIdentifier.resolve(store: store)

            XCTAssertEqual(identifier.value, legal)
            XCTAssertEqual(store.saveCalls, 0, "合法值不该被覆写")
        }
    }

    /// 合法性判定的边界与后端 `normalize_client_id` 逐条对齐（空串在后端 = 没带该头，
    /// 故也不算合法设备标识）。
    func testValidityMirrorsTheBackendRule() {
        for legal in ["a", "0", ".", "-", "_", ":", "a.b-c_d:e", String(repeating: "a", count: 64)] {
            XCTAssertTrue(ClientIdentifier.isValid(legal), "\(legal.debugDescription) 应合法")
        }
        for illegal in ["", " ", "\t", "\n", "a b", "中文", "a/b", "a+b", "a@b", String(repeating: "a", count: 65)] {
            XCTAssertFalse(ClientIdentifier.isValid(illegal), "\(illegal.debugDescription) 应非法")
        }
    }

    /// 空串存量值（写过空内容 / 被清过）也不能当成设备标识用 —— 它会把登录发回
    /// `default` 槽（= 网页端那个槽），于是又变成互顶。
    func testEmptyStoredValueIsTreatedAsMissingAndReplaced() {
        let store = InMemoryClientIdentifierStore(seeded: "")

        let identifier = ClientIdentifier.resolve(store: store)

        XCTAssertTrue(ClientIdentifier.isValid(identifier.value))
        XCTAssertEqual(store.clientID, identifier.value)
        XCTAssertEqual(store.saveCalls, 1)
    }

    // MARK: - 钥匙串不可用时不挡登录

    /// 读不出来（被锁 / 权限被拒）：本次进程给一个可用标识 + 明确提示；**不覆写**
    /// 存储 —— 里面可能有一条此刻读不到的合法标识，盖掉它才是真的丢槽。
    func testUnreadableStoreStillYieldsAUsableIdentifierWithoutOverwriting() {
        let store = InMemoryClientIdentifierStore(seeded: "existing-device")
        store.failLoading(
            with: CredentialStoreError.keychain(status: -25308, message: "User interaction is not allowed.")
        )

        let identifier = ClientIdentifier.resolve(store: store)

        XCTAssertTrue(ClientIdentifier.isValid(identifier.value))
        XCTAssertNotEqual(identifier.value, "existing-device")
        XCTAssertEqual(store.clientID, "existing-device", "读失败不得顺手覆写可能存在的标识")
        XCTAssertEqual(store.saveCalls, 0)
        let warning = identifier.persistenceWarning ?? ""
        XCTAssertTrue(warning.contains("读取失败"), "必须说清是读失败：\(warning)")
        XCTAssertTrue(warning.contains("重启后会变"), "必须点出代价：\(warning)")
    }

    /// 写不进去（存储为空且不可写）：仍返回一个新标识（**不回退成「不带标识」** ——
    /// 那会让后端按 `default` 槽下发，把网页端那把 key 顶掉，正是本 stage 要修的问题），
    /// 并明确告知重启后会变。
    func testUnwritableStoreStillYieldsAnIdentifierWithAWarning() {
        let store = InMemoryClientIdentifierStore()
        store.failSaving(with: CredentialStoreError.keychain(status: -34018, message: "Missing entitlement"))

        let identifier = ClientIdentifier.resolve(store: store)

        XCTAssertTrue(ClientIdentifier.isValid(identifier.value), "写不进也必须给出一个可用的标识")
        XCTAssertNil(store.clientID)
        let warning = identifier.persistenceWarning ?? ""
        XCTAssertTrue(warning.contains("写入钥匙串失败"), "必须说清是写失败：\(warning)")
        XCTAssertTrue(warning.contains("重启后会变"), "必须点出代价：\(warning)")
    }

    /// 标识不是凭据，但也不能落到明文可执行的存储里 —— 这一条钉住「默认实现是钥匙串」
    /// 这个事实（默认参数只在一处，改错会让全部登录路径静默降级）。
    func testDefaultStoreIsTheKeychain() throws {
        let store = KeychainClientIdentifierStore()

        XCTAssertEqual(KeychainClientIdentifierStore.defaultAccount, "client-id")
        XCTAssertEqual(ClientIdentifier.headerName, "X-Client-Id")
        // 不假设本机钥匙串里有什么：只断言默认构造指向真钥匙串条目（可读或抛出
        // 钥匙串错误），不触网、不写值。
        _ = store
    }
}
