import Foundation
import XCTest

import BelieveBoyKit

/// 「没配 key」与「读不到 key」必须可区分 —— UI 对两者的措辞与处置都不同。
final class CredentialAvailabilityTests: XCTestCase {
    private struct ThrowingStore: CredentialStore {
        var error: Error

        func loadAPIKey() throws -> String? { throw error }
        func saveAPIKey(_ key: String) throws { throw error }
        func deleteAPIKey() throws { throw error }
    }

    func testKeychainReadFailureIsNotReportedAsMissingCredential() {
        let store = ThrowingStore(
            error: CredentialStoreError.keychain(status: -25308, message: "User interaction is not allowed.")
        )

        let resolution = CredentialAvailability.resolve(store)

        XCTAssertEqual(
            resolution,
            .unavailable("钥匙串操作失败（OSStatus -25308）：User interaction is not allowed.")
        )
        XCTAssertNil(resolution.key)
        XCTAssertNotNil(resolution.failureMessage)
        XCTAssertNotEqual(resolution, .missing, "读失败不得退化成「没配 key」")
    }

    func testBlankEnvironmentKeyIsMissingNotUnavailable() {
        XCTAssertEqual(
            CredentialAvailability.resolve(EnvironmentCredentialStore(environment: ["BELIEVEBOY_API_KEY": "   "])),
            .missing
        )
        XCTAssertEqual(
            CredentialAvailability.resolve(EnvironmentCredentialStore(environment: [:])),
            .missing
        )
    }

    func testConfiguredKeyIsAvailableAndTrimmed() {
        let resolution = CredentialAvailability.resolve(
            EnvironmentCredentialStore(environment: ["BELIEVEBOY_API_KEY": " blf_abc "])
        )

        XCTAssertEqual(resolution, .available("blf_abc"))
        XCTAssertEqual(resolution.key, "blf_abc")
        XCTAssertNil(resolution.failureMessage)
    }
}
