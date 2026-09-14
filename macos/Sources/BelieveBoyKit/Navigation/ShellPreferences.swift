import Foundation

/// 应用外壳的持久化状态：选中的分组 / 二级项、侧栏折叠态、窗口尺寸。
///
/// 为什么这些放 Kit 而不是视图层：它们是**可恢复的输入**，恢复规则（条目是否还在、
/// 窗口是否跑到屏幕外）必须能离线验证 —— 视图层拿不到 `XCTest` 之外的屏幕信息，
/// 而这里的纯函数在测试里可以直接喂「假屏幕」。
///
/// 与 `SessionStore` 分槽：这里只有导航与窗口几何，**不含任何凭据**，所以用
/// `UserDefaults` 就够（密码那条线仍然只走钥匙串，见 PLAN §4.1.1）。
public struct ShellPreferences: Codable, Sendable, Equatable {
    /// 选中的分组 id；`nil` = 未选分组（详情栏显示「连接与身份」概览）。
    public var selectedGroupID: String?
    /// 选中的二级项 route id；`nil` = 只选了分组。
    public var selectedRouteID: String?
    /// 侧栏折叠态（`⌘⌥S` 或拖分栏线都可能改它）。
    public var columnVisibility: ShellColumnVisibility
    /// 上次退出时的窗口 frame；`nil` = 还没记录过。
    public var windowFrame: WindowFrame?

    public init(
        selectedGroupID: String? = nil,
        selectedRouteID: String? = nil,
        columnVisibility: ShellColumnVisibility = .automatic,
        windowFrame: WindowFrame? = nil
    ) {
        self.selectedGroupID = selectedGroupID
        self.selectedRouteID = selectedRouteID
        self.columnVisibility = columnVisibility
        self.windowFrame = windowFrame
    }

    /// 丢弃不再成立的部分（分组 / 条目被删、窗口尺寸不合理）。
    ///
    /// 恢复**不能**信任落盘内容：它可能来自旧版本（条目已重命名）或被人手改过。
    /// 这里的规则是「宁可退回默认，也不要渲染一个不存在的选中项」：
    /// - route id 不在 catalog 里 → 连带分组一起清掉（详情栏回到概览）；
    /// - 分组 id 不在 catalog 里 → 清掉分组；entry 仍在则以其自身分组为准；
    /// - 窗口尺寸不合理（非有限值 / 小于最小尺寸）→ 丢掉，用默认尺寸。
    public func sanitized(catalog: [NavigationGroup] = NavigationCatalog.groups) -> ShellPreferences {
        var result = self
        if let routeID = result.selectedRouteID {
            if let owner = catalog.first(where: { group in group.items.contains { $0.id == routeID } }) {
                // 分组与条目不一致时以条目为准（条目才是路由真相）。
                result.selectedGroupID = owner.id
            } else {
                // 条目已不在 catalog 里（旧版本 / 被重命名）→ 连带分组一起清掉。
                result.selectedRouteID = nil
                result.selectedGroupID = nil
            }
        } else if let groupID = result.selectedGroupID,
                  !catalog.contains(where: { $0.id == groupID }) {
            result.selectedGroupID = nil
        }
        if let frame = result.windowFrame, !frame.isPlausible {
            result.windowFrame = nil
        }
        return result
    }
}

/// 侧栏可见性。
///
/// Kit 层不能 `import SwiftUI`，故这里是一份与 `NavigationSplitViewVisibility`
/// 一一对应的枚举；映射在 UI 层（`ShellColumnVisibility+SwiftUI.swift`）。
/// 原始值取 SwiftUI 的 case 名，落盘内容因此可读、可手改。
public enum ShellColumnVisibility: String, Codable, Sendable, CaseIterable {
    case automatic
    case all
    case doubleColumn
    case detailOnly
}

/// 窗口 frame（AppKit 屏幕坐标，左下角原点）。
///
/// 自带「自检 + 夹回可见屏幕」的规则：显示器拔掉 / 分辨率变化后，落盘的坐标可能
/// 完全在屏幕外 —— 直接恢复会让窗口「启动了但看不见」，比不恢复更糟。
public struct WindowFrame: Codable, Sendable, Equatable {
    public struct Size: Sendable, Equatable {
        public var width: Double
        public var height: Double

        public init(width: Double, height: Double) {
            self.width = width
            self.height = height
        }

        public static let compact = Size(width: 440, height: 540)
        public static let regular = Size(width: 880, height: 660)
    }

    public var x: Double
    public var y: Double
    public var width: Double
    public var height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    public var size: Size { Size(width: width, height: height) }

    /// 尺寸是否可信：有限、非负、不小于最小可交互尺寸、不超过一个荒诞上界
    /// （防手改 `UserDefaults` 写出 10^9 宽度的窗口）。
    public var isPlausible: Bool {
        let values = [x, y, width, height]
        guard values.allSatisfy({ $0.isFinite }) else { return false }
        guard width >= Self.minimum.width, height >= Self.minimum.height else { return false }
        guard width <= Self.maximumDimension, height <= Self.maximumDimension else { return false }
        return abs(x) <= Self.maximumOrigin && abs(y) <= Self.maximumOrigin
    }

    /// 窗口能被交互的最小尺寸（三栏布局的下限，与 `ShellWindowStyle.regular`
    /// 的最小尺寸一致）。
    public static let minimum = Size(width: 640, height: 520)
    private static let maximumDimension: Double = 20_000
    private static let maximumOrigin: Double = 100_000

    /// 把 frame 夹进可见屏幕：优先落在**交集面积最大**的那块屏（多显示器时就是用户
    /// 上次放它的那块）；交集太小或左上角压根不在任何屏内 → 在宿主屏居中。
    ///
    /// `visibleFrames` 为空（拿不到屏幕信息）时原样返回：宁可不改，也不要凭空挪窗。
    public func clamped(in visibleFrames: [WindowFrame], minimumSize: Size = WindowFrame.minimum) -> WindowFrame {
        guard let host = visibleFrames.max(by: { $0.intersectionArea(with: self) < $1.intersectionArea(with: self) })
        else { return self }

        var result = self
        result.width = max(width, minimumSize.width)
        result.height = max(height, minimumSize.height)

        // 窗口尺寸可能比宿主屏还大（换了小屏）：先压到屏内，保证标题栏可抓。
        result.width = min(result.width, host.width)
        result.height = min(result.height, host.height)

        guard result.isMostlyVisible(in: host) else {
            result.x = host.x + (host.width - result.width) / 2
            result.y = host.y + (host.height - result.height) / 2
            return result
        }
        result.x = min(max(result.x, host.x), host.x + host.width - result.width)
        result.y = min(max(result.y, host.y), host.y + host.height - result.height)
        return result
    }

    /// 左上角在宿主屏内、且与宿主屏的交集占比过半 —— 两个条件都满足才算「看得见」。
    private func isMostlyVisible(in host: WindowFrame) -> Bool {
        let originInside = x >= host.x && x <= host.x + host.width
            && y >= host.y && y <= host.y + host.height
        guard originInside else { return false }
        let area = width * height
        guard area > 0 else { return false }
        return intersectionArea(with: host) >= 0.5 * area
    }

    func intersectionArea(with other: WindowFrame) -> Double {
        let overlapWidth = min(x + width, other.x + other.width) - max(x, other.x)
        let overlapHeight = min(y + height, other.y + other.height) - max(y, other.y)
        guard overlapWidth > 0, overlapHeight > 0 else { return 0 }
        return overlapWidth * overlapHeight
    }
}

/// 外壳状态的持久化抽象（`UserDefaults` 实现 + 测试用内存实现）。
///
/// 同步方法：调用点全在 `@MainActor`（`NavigationStore`），写一条 JSON 的量级不值得
/// 引入 `async`；失败也只是「这次没记住」，不该打断交互。
public protocol ShellPreferencesStore: Sendable {
    func loadPreferences() -> ShellPreferences?
    func savePreferences(_ preferences: ShellPreferences)
}

/// `UserDefaults` 实现：整个 `ShellPreferences` 编码成**一条** JSON。
///
/// 不用多个键逐个存：一条 JSON 有版本演进的余地（新增字段不会与旧键混杂），也不会把
/// 用户默认值里塞满 `shell.*` 前缀。
public struct UserDefaultsShellPreferencesStore: ShellPreferencesStore {
    public static let defaultKey = "shell.preferences.v1"

    private let suiteName: String?
    private let key: String

    /// - Parameter suiteName: 测试传自己的域（跑完清掉，不污染开发机上的真实偏好）；
    ///   生产用 `nil`（= `.standard`）。
    public init(suiteName: String? = nil, key: String = defaultKey) {
        self.suiteName = suiteName
        self.key = key
    }

    /// **不把 `UserDefaults` 存成属性**：它不是 `Sendable`，存下来就只能 `@unchecked`
    /// 糊过去（Swift 6 严格并发）。`UserDefaults(suiteName:)` 自带缓存，每次取回来
    /// 没有实质开销，而本 store 的写入频率是「用户拖完窗口 / 点一次侧栏」。
    private var defaults: UserDefaults {
        guard let suiteName, let scoped = UserDefaults(suiteName: suiteName) else { return .standard }
        return scoped
    }

    public func loadPreferences() -> ShellPreferences? {
        guard let data = defaults.data(forKey: key) else { return nil }
        // 解不出来（旧版本 / 手改坏了）当作「没有记录」：比崩在启动路径上强。
        return try? JSONDecoder().decode(ShellPreferences.self, from: data)
    }

    public func savePreferences(_ preferences: ShellPreferences) {
        guard let data = try? JSONEncoder().encode(preferences) else { return }
        defaults.set(data, forKey: key)
    }
}
