import Foundation

/// 设备标识的持久化抽象。
///
/// 「一台机器 = 一个设备槽」是后端按设备分区下发 key 的粒度（BLF-1059）：登录时
/// 带上同一个标识 = 复用同一个槽（旧 key 轮换），换一个标识 = 另开一个槽（互不影响）。
/// 因此这个值的**稳定性是契约的一部分**，必须落盘而不是每次进程启动新生成。
public protocol ClientIdentifierStore: Sendable {
    /// 读取已存标识；没存过返回 `nil`。
    func loadClientID() throws -> String?
    /// 写入标识（覆盖已有值）。
    func saveClientID(_ clientID: String) throws
    /// 删除标识（幂等）。单测清理用；正常登录路径不需要删除它。
    func deleteClientID() throws
}

/// 本机设备标识：登录时随请求头 `X-Client-Id` 发出去的那个值。
///
/// 为什么需要它：`blf_` 账号 key 曾经是**覆盖式轮换**（一个账号只维护一行
/// `user_api_keys`），于是桌面端登录会顶掉网页端那把 key、网页端登录又顶掉桌面端 ——
/// 用户看到的是随机的 403。BLF-1059 把这一行拆成「按设备槽分区」，但**槽标识必须由
/// 客户端自己携带**：不带就仍落 `default` 槽，互顶照旧。本类型就是客户端那一半。
///
/// 与 `api_key` / 账号档案 / 「记住密码」**分开存**：它本身不是凭据（泄漏它只能
/// 冒充某个槽，仍需密码才能登录），但它是「以哪个槽登录」的选择器，与凭据同属
/// 钥匙串条目按签名隔离的同一保护面，且必须**跨进程稳定**——`UserDefaults` 是明文
/// plist，任何本机进程可改，把选择器放在可被外部改写的存储里等于把「我是不是那台
/// 设备」交给别人裁决。
public struct ClientIdentifier: Sendable, Equatable {
    /// 请求头名。与后端 `auth.py` 的 `Header(alias="X-Client-Id")` 一一对应
    /// （登录端点唯一读取它的地方；其余端点不看这个头）。
    public static let headerName = "X-Client-Id"

    /// 设备槽标识本身（首次启动生成，此后不变）。
    public let value: String

    /// 非 `nil` = 本次进程内可用，但**没能与钥匙串对上**（读不出 / 写不进）。
    /// 调用方应把它当「非致命提示」展示：登录照常进行，但重启后会换槽。
    public let persistenceWarning: String?

    /// 解析本机标识：优先用钥匙串里已存的，没有（或存量值非法）才生成并落盘。
    ///
    /// 三条不变量：
    /// 1. 返回的值**永远是合法的**（见 `isValid`）—— 存量值非法时重新生成而不是
    ///    原样发出去；
    /// 2. **不挡登录**：钥匙串读写失败也返回一个可用值（本次进程内有效）；
    /// 3. 读不出来时**不覆写** —— 可能有一条已存在但此刻读不到的标识，把它盖掉
    ///    才是真的丢槽。
    public static func resolve(store: ClientIdentifierStore) -> ClientIdentifier {
        let stored: String?
        do {
            stored = try store.loadClientID()
        } catch {
            // 读不出来（钥匙串被锁 / 权限被拒）：本次进程用一个新标识顶着。代价是这次
            // 会话落在一个新槽（重启再换一个），收益是**网页端那把 key 不会被顶掉** ——
            // 退化到「不带标识」才是把 BLF-1060 要修的问题又请回来。
            return ClientIdentifier(
                value: makeValue(),
                persistenceWarning: "设备标识读取失败（\(describe(error))）：本次登录会使用一个临时标识"
                    + "（网页端不受影响），但重启后会变。"
            )
        }

        // 按**原值**判定，不 trim：" a1 " 这类值 trim 后是一个合法标识，但那是**另一个**
        // 设备槽 —— 静默别名到一台合法设备就会把真正那台顶掉（后端 0dd11825 修的就是
        // 同一件事，客户端不能在这边把它请回来）。原值非法 → 重新生成并覆写。
        if let stored, isValid(stored) {
            return ClientIdentifier(value: stored, persistenceWarning: nil)
        }

        // 没存过，或存量值非法（旧格式 / 被外部改写 / 带空白）。非法值**不能**将错就错
        // 发出去：后端对非法 `X-Client-Id` 一律 400，用户会卡在「登录永远失败、且无从自救」。
        let fresh = makeValue()
        do {
            try store.saveClientID(fresh)
            return ClientIdentifier(value: fresh, persistenceWarning: nil)
        } catch {
            return ClientIdentifier(
                value: fresh,
                persistenceWarning: "设备标识写入钥匙串失败（\(describe(error))）：本次登录会带上它"
                    + "（网页端不受影响），但重启后会变。"
            )
        }
    }

    /// 生成一个新标识：小写 UUID 字符串（36 字符，落在后端的合法字符集内）。
    public static func makeValue() -> String {
        UUID().uuidString.lowercased()
    }

    /// 与后端同口径的合法性判定（`user_api_key_service.normalize_client_id`）：
    /// 非空、≤64 字符、且只含 `[A-Za-z0-9._:-]`（`fullmatch`，故空白 / 控制字符 /
    /// 非 ASCII 一律非法）。
    ///
    /// 客户端也判一次的理由：非法值发出去只会拿到 400，而值存在钥匙串里，用户没有
    /// 任何界面手段去修它 —— 本地重建是唯一自愈路径。
    public static func isValid(_ raw: String) -> Bool {
        guard !raw.isEmpty, raw.count <= 64 else { return false }
        return raw.unicodeScalars.allSatisfy(allowedScalars.contains)
    }

    private static let allowedScalars = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-"
    )

    private static func describe(_ error: Error) -> String {
        if let error = error as? CredentialStoreError { return error.displayMessage }
        return error.localizedDescription
    }
}

/// 钥匙串实现：`kSecClassGenericPassword` 的第四个条目槽位（另三个是会话 key、
/// 账号档案与「记住密码」，见 `KeychainSessionStore` / `RememberedLogin`）。
public struct KeychainClientIdentifierStore: ClientIdentifierStore {
    /// 条目账号名。与其它条目分槽，互不覆盖。
    public static let defaultAccount = "client-id"

    private let item: KeychainItem

    public init(
        service: String = KeychainCredentialStore.defaultService,
        account: String = KeychainClientIdentifierStore.defaultAccount
    ) {
        self.item = KeychainItem(service: service, account: account)
    }

    public func loadClientID() throws -> String? {
        guard let data = try item.load() else { return nil }
        // **不 trim**：判定与发送都用钥匙串里的原值，否则带空白的非法值会被悄悄别名成
        // 另一个合法槽（见 `ClientIdentifier.resolve`）。
        return String(data: data, encoding: .utf8)
    }

    public func saveClientID(_ clientID: String) throws {
        guard !clientID.isEmpty else {
            // 空值语义 = 清除，避免写入空字符串让下次登录发出一个空标识头。
            try deleteClientID()
            return
        }
        // 写入也按原值：存的内容与将发送的内容必须逐字节一致，否则「读回来再判合法性」
        // 就失去意义。
        try item.save(Data(clientID.utf8))
    }

    public func deleteClientID() throws {
        try item.delete()
    }
}
