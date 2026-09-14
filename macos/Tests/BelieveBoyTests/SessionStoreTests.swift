import Foundation
import XCTest

import BelieveBoyKit

/// 会话持久化：真钥匙串往返 + 凭据失效时的清理语义。
///
/// 这一组里只有钥匙串用例会碰系统钥匙串，且**不可用时 skip 而不是 fail** ——
/// 它证明的是「登录成功后 key 真的进了钥匙串」这条真机事实，不是逻辑断言；
/// 逻辑断言在 `AppModelSessionTests`（注入内存存储）里。
final class SessionStoreTests: XCTestCase {
    /// 独立 service，避免污染真机（`com.believeboy.dashboard.macos`）的会话条目。
    private static let testService = "com.believeboy.dashboard.macos.selftest"

    private var store: KeychainSessionStore {
        KeychainSessionStore(service: Self.testService)
    }

    override func tearDown() {
        try? store.clearSession()
        super.tearDown()
    }

    func testKeychainRoundTripStoresAndRestoresSession() throws {
        let session = AuthSession(apiKey: "blf_roundtrip_123", user: .fixtureAdmin)

        do {
            try store.saveSession(session)
        } catch let error as CredentialStoreError {
            throw XCTSkip("该环境下钥匙串不可用（\(error.displayMessage)）—— 真机入库需 GUI 会话")
        }

        let restored = try store.loadSession()
        XCTAssertEqual(restored, session, "冷启动必须读回同一份会话（key + 账号档案）")
        XCTAssertEqual(restored?.user?.operatorNameZh, "测试管理员")
        XCTAssertEqual(restored?.user?.isAdmin, true)

        try store.clearSession()
        XCTAssertNil(try store.loadSession())
    }

    /// 登出 / 凭据失效后必须干净：`clearSession` 幂等，且不留下「有 key 没档案」的
    /// 半登录态。
    func testClearSessionIsIdempotentAndLeavesNothingBehind() throws {
        do {
            try store.saveSession(AuthSession(apiKey: "blf_to_clear", user: .fixtureOperator))
        } catch let error as CredentialStoreError {
            throw XCTSkip("该环境下钥匙串不可用（\(error.displayMessage)）")
        }

        try store.clearSession()
        try store.clearSession()
        XCTAssertNil(try store.loadSession())

        // 清干净之后再存一份只带 key（无账号档案）的会话 —— 环境变量 / 主 key 场景。
        try store.saveSession(AuthSession(apiKey: "blf_key_only", user: nil))
        let keyOnly = try store.loadSession()
        XCTAssertEqual(keyOnly?.apiKey, "blf_key_only")
        XCTAssertNil(keyOnly?.user, "无账号档案时 user 必须为 nil，而不是伪造一个空档案")
    }

    /// key 存在但档案缺失（旧版本写的 / 被外部改动）不得让登录态失效 —— 退化成
    /// 「无账号上下文」总比把用户挡在登录页外好。
    func testKeyWithoutProfileStillYieldsASession() throws {
        let credentials = KeychainCredentialStore(service: Self.testService)
        do {
            try credentials.saveAPIKey("blf_no_profile")
            try KeychainSessionStore(service: Self.testService).clearSession()
            try credentials.saveAPIKey("blf_no_profile")
        } catch let error as CredentialStoreError {
            throw XCTSkip("该环境下钥匙串不可用（\(error.displayMessage)）")
        }

        let session = try store.loadSession()
        XCTAssertEqual(session?.apiKey, "blf_no_profile")
        XCTAssertNil(session?.user)
    }
}
