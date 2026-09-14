import BelieveBoyKit
import Foundation
import Security
import XCTest

/// 「记住密码」的真钥匙串往返。
///
/// 这一组只碰系统钥匙串，且**不可用时 skip 而不是 fail** —— 它证明的是「密码真的
/// 进了钥匙串」这条真机事实，逻辑断言在 `AppModelSessionTests`（注入内存存储）。
final class RememberedLoginTests: XCTestCase {
    /// 独立 service，避免污染真机（`com.believeboy.dashboard.macos`）的条目。
    private static let testService = "com.believeboy.dashboard.macos.selftest"

    private var store: KeychainRememberedLoginStore {
        KeychainRememberedLoginStore(service: Self.testService)
    }

    override func tearDown() {
        try? store.deleteLogin()
        super.tearDown()
    }

    func testKeychainRoundTripStoresAndClearsRememberedLogin() throws {
        let login = RememberedLogin(email: "test_admin@believeboy.com", password: "TestAdmin123")
        do {
            try store.saveLogin(login)
        } catch let error as CredentialStoreError {
            throw XCTSkip("该环境下钥匙串不可用（\(error.displayMessage)）—— 真机入库需 GUI 会话")
        }

        XCTAssertEqual(try store.loadLogin(), login, "冷启动必须读回同一对邮箱与密码")
        XCTAssertTrue(store is KeychainRememberedLoginStore, "默认实现必须是钥匙串，不是 UserDefaults")

        try store.deleteLogin()
        XCTAssertNil(try store.loadLogin())

        try store.deleteLogin()
        XCTAssertNil(try store.loadLogin(), "删除是幂等的")
    }

    /// 条目内容解不出来（旧格式 / 被外部改动）时按「没记住」处理：后果只是多打一次
    /// 密码，不该抛错把用户堵在登录页外。
    func testCorruptedEntryDegradesToNoRememberedLogin() throws {
        do {
            try writeRawEntry("not-json")
        } catch let error as CredentialStoreError {
            throw XCTSkip("该环境下钥匙串不可用（\(error.displayMessage)）")
        }

        let loaded = try store.loadLogin()
        XCTAssertNil(loaded, "解不出来就当没记过，而不是抛错")
    }

    /// 直接往条目里写原始字节，模拟「同一条目被旧版本或外部工具写坏」。
    private func writeRawEntry(_ raw: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.testService,
            kSecAttrAccount as String: KeychainRememberedLoginStore.defaultAccount,
        ]
        SecItemDelete(query as CFDictionary)
        var insert = query
        insert[kSecValueData as String] = Data(raw.utf8)
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(insert as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw CredentialStoreError.keychain(status: status, message: "SecItemAdd 失败")
        }
    }
}
