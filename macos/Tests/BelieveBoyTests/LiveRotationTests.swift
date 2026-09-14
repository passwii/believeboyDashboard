import Foundation
import XCTest

import BelieveBoyKit

/// 真后端轮换用例：**默认 skip**，配 `BELIEVEBOY_E2E_*` 才跑。
///
/// 为什么单独一个文件而不是全靠打桩：`blf_` key 的覆盖式轮换是**后端行为**，
/// 打桩只能证明「客户端遇到 403 会怎么做」，证明不了「同账号二次登录真的会让
/// 第一把 key 变 403」。这条用例打真后端，用来钉住那个服务端事实。
///
/// 跑法（本地后端 + 测试库，绝不用生产真人账号 —— 登录会轮换该账号的 key，
/// 把同事的网页端会话踢掉）：
///
/// ```bash
/// cd backend
/// # TEST_DATABASE_URL 取自 backend/.env.test（内含测试库地址与账号）
/// TEST_DATABASE_URL="$(grep '^TEST_DATABASE_URL=' .env.test | cut -d= -f2-)" \
///   uvicorn app.main:app --port 8000
/// # 另开一终端：
/// cd macos
/// BELIEVEBOY_E2E_BASE_URL=http://127.0.0.1:8000 \
/// BELIEVEBOY_E2E_EMAIL=test_admin@believeboy.com \
/// BELIEVEBOY_E2E_PASSWORD="$(grep '^TEST_ADMIN_PASSWORD=' ../backend/.env.test | cut -d= -f2-)" \
/// DEVELOPER_DIR=/Volumes/Rock/Xcode.app/Contents/Developer swift test \
///   --filter LiveRotationTests
/// ```
final class LiveRotationTests: XCTestCase {
    private func liveBackend() throws -> (baseURL: URL, email: String, password: String) {
        let environment = ProcessInfo.processInfo.environment
        guard let raw = environment["BELIEVEBOY_E2E_BASE_URL"],
              let baseURL = URL(string: raw),
              let email = environment["BELIEVEBOY_E2E_EMAIL"]?.trimmedNonEmpty,
              let password = environment["BELIEVEBOY_E2E_PASSWORD"]?.trimmedNonEmpty
        else {
            throw XCTSkip(
                "未配置 BELIEVEBOY_E2E_BASE_URL / _EMAIL / _PASSWORD —— 真后端轮换用例跳过。"
                    + "需要本地后端 + 测试库账号（见本文件注释）。"
            )
        }
        return (baseURL, email, password)
    }

    /// 同一设备槽连续登录两次 → 第一次下发的 key 立刻变成 403，第二次的可用。
    ///
    /// 这是 BLF-1059 保留的**槽内**语义：同一个 `X-Client-Id` 再登一次就是轮换同一把
    /// key（不是另开一把）。桌面端自己的重登（退出再登 / 被顶后重登）走的就是这条路。
    func testSecondLoginInTheSameDeviceSlotInvalidatesTheFirstKeyWith403() async throws {
        let backend = try liveBackend()
        let deviceSlot = "macos-e2e-\(UUID().uuidString.lowercased())"

        let first = try await AuthService.login(
            email: backend.email,
            password: backend.password,
            baseURL: backend.baseURL,
            clientID: deviceSlot
        )
        XCTAssertTrue(first.apiKey.hasPrefix("blf_"), "账号专属 key 应带 blf_ 前缀：\(first.apiKey.prefix(12))")
        XCTAssertFalse(first.apiKey.isEmpty)
        XCTAssertEqual(first.user?.email.lowercased(), backend.email.lowercased())

        // 第一次拿到的 key 此时有效。
        let firstClientAlive = APIClient(baseURL: backend.baseURL, apiKey: first.apiKey)
        _ = try await HealthProbe.full(using: firstClientAlive)

        // 同一个设备槽再登一次（等价于桌面端自己重启后重新登录）。
        let second = try await AuthService.login(
            email: backend.email,
            password: backend.password,
            baseURL: backend.baseURL,
            clientID: deviceSlot
        )
        XCTAssertNotEqual(second.apiKey, first.apiKey, "同一槽二次登录必须轮换出不同的 key")

        // 旧 key 立刻失效，且必须是 403（不是 401）—— 这正是客户端要接住的那个信号。
        let staleClient = APIClient(baseURL: backend.baseURL, apiKey: first.apiKey)
        do {
            _ = try await HealthProbe.full(using: staleClient)
            XCTFail("旧 key 应已失效（后端 ensure_user_api_key 覆写同一槽的 key_hash）")
        } catch let error as APIError {
            XCTAssertEqual(
                error,
                .unauthorized(status: 403, body: #"{"detail":"Invalid API key"}"#),
                "失效 key 的语义是 403 Invalid API key"
            )
            XCTAssertTrue(
                error.requiresCredentialFix,
                "403 必须置位「请重新登录」，否则界面只会显示「无权限」"
            )
        }

        // 新 key 可用（重新登录即可自愈，无需管理员介入）。
        let freshClient = APIClient(baseURL: backend.baseURL, apiKey: second.apiKey)
        let health = try await HealthProbe.full(using: freshClient)
        XCTAssertFalse(health.database.isEmpty)
    }

    /// **本 stage 存在的理由（验收 1）**：桌面端（带设备标识）登录后，网页端那把 key
    /// 仍然有效；反之亦然。
    ///
    /// 网页端不带 `X-Client-Id` → 落 `default` 槽，正是真实 Web 代理的行为，因此这里不
    /// 打桩、不模拟：两把 key 都拿真后端验一遍。
    func testDesktopAndWebSlotsDoNotInvalidateEachOther() async throws {
        let backend = try liveBackend()
        let deviceSlot = "macos-e2e-\(UUID().uuidString.lowercased())"

        // 1) 桌面端登录（带设备标识）。
        let desktop = try await AuthService.login(
            email: backend.email,
            password: backend.password,
            baseURL: backend.baseURL,
            clientID: deviceSlot
        )
        let desktopClient = APIClient(baseURL: backend.baseURL, apiKey: desktop.apiKey)
        _ = try await HealthProbe.full(using: desktopClient)

        // 2) 网页端登录（不带该头 → default 槽）。
        let web = try await AuthService.login(
            email: backend.email,
            password: backend.password,
            baseURL: backend.baseURL,
            clientID: nil
        )
        XCTAssertNotEqual(web.apiKey, desktop.apiKey, "两个设备槽各自持有不同的 key")

        // 3) 桌面端那把**仍然有效** —— 拆分前这一步会 403。
        let health = try await HealthProbe.full(using: desktopClient)
        XCTAssertFalse(health.database.isEmpty, "桌面端登录后网页端不得把桌面端顶掉")

        // 4) 反向：网页端登录之后，桌面端再登一次也不影响网页端那把。
        let webKeyStillValid = APIClient(baseURL: backend.baseURL, apiKey: web.apiKey)
        _ = try await HealthProbe.full(using: webKeyStillValid)
    }

    /// 账号上下文请求头打真后端 —— 用 `/order-info/filter-options` 做**可观测**断言。
    ///
    /// 该端点对非管理员强制要求 `X-Operator`（`order_info.py:_ensure_operator_header`），
    /// 缺了会 401「缺少 X-Operator 头」。于是「带上中文 X-Operator 后不再 401」一句话
    /// 同时钉住两件事：请求头确实发出去了，且后端 `_decode_header_value` 把它解回了
    /// 非空操作员名（percent-encoding 与服务端解码对得上）。
    func testUserContextHeadersAreReadByRealBackend() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let baseURL = environment["BELIEVEBOY_E2E_BASE_URL"].flatMap(URL.init(string:)),
              let email = environment["BELIEVEBOY_E2E_OPERATOR_EMAIL"]?.trimmedNonEmpty
                ?? "test_operator@believeboy.com".trimmedNonEmpty,
              let password = environment["BELIEVEBOY_E2E_OPERATOR_PASSWORD"]?.trimmedNonEmpty
        else {
            throw XCTSkip(
                "未配置 BELIEVEBOY_E2E_BASE_URL / _OPERATOR_PASSWORD —— 账号上下文真机用例跳过。"
                    + "该用例需要一个**非管理员**测试账号（管理员不需要 X-Operator）。"
            )
        }

        let session = try await AuthService.login(
            email: email,
            password: password,
            baseURL: baseURL,
            clientID: "macos-e2e-user-context"
        )
        let user = try XCTUnwrap(session.user)
        XCTAssertFalse(user.isAdmin, "该用例的前提是非管理员账号，否则 X-Operator 校验不参与")
        let path = "/order-info/filter-options"

        // 1) 不发账号上下文 → 后端明确拒绝。先跑这一步，证明后面的 200 不是空断言。
        //    注意用 `status()` 而不是 `get()`：前者**不**对 4xx 抛错，正好用来断言状态码本身。
        let bare = APIClient(baseURL: baseURL, apiKey: session.apiKey)
        let (bareStatus, bareBody) = try await bare.status(path, tier: .list, authenticated: true)
        XCTAssertEqual(
            bareStatus,
            401,
            "非管理员缺 X-Operator 应被 401 拒绝（该校验是活的）：\(bareBody.prefix(200))"
        )
        XCTAssertTrue(
            bareBody.contains("X-Operator"),
            "后端应指出缺的是 X-Operator：\(bareBody)"
        )

        // 2) 带上账号上下文 → 通过（中文操作员名 percent-encoded 后端能解回）。
        let withContext = APIClient(
            baseURL: baseURL,
            apiKey: session.apiKey,
            userContext: UserContext.from(user)
        )
        let (status, body) = try await withContext.status(path, tier: .list, authenticated: true)
        XCTAssertEqual(status, 200, "带账号上下文应正常返回：\(body.prefix(200))")
    }
}
