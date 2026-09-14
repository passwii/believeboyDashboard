import Foundation

/// 客户端排序状态（Web `SortState`：`{ key, dir }`，初始 `null`）。
public struct AdDataSort: Equatable, Sendable {
    public enum Direction: String, Sendable, Equatable {
        case ascending
        case descending

        public var toggled: Direction { self == .ascending ? .descending : .ascending }

        /// 排序箭头（视图层直接用）。
        public var symbolName: String {
            self == .ascending ? "arrow.up" : "arrow.down"
        }
    }

    public let key: String
    public let direction: Direction

    public init(key: String, direction: Direction = .ascending) {
        self.key = key
        self.direction = direction
    }

    /// Web `toggleSort`：同列 → 反向；换列 → 升序。
    public func toggling(key: String) -> AdDataSort {
        guard self.key == key else { return AdDataSort(key: key, direction: .ascending) }
        return AdDataSort(key: key, direction: direction.toggled)
    }
}

/// 一页里的一行：行 id + 数据。
///
/// 行 id 取后端原始行的 `id`（`_AdRawRowBase.id`，就是 DB 行主键）；缺失时退回「页内序号」
/// —— 与 Web 的 `row.id ?? pageStart + idx` 同口径。展开态按这个 id 记，翻页 / 排序后不会串行。
public struct AdDataPageRow: Equatable, Sendable, Identifiable {
    public let id: Int
    public let row: DynamicJSONRow

    public init(id: Int, row: DynamicJSONRow) {
        self.id = id
        self.row = row
    }
}

/// 客户端表格流水线的结果：搜索 → 排序 → 翻页之后真正要画的那一页。
public struct AdDataTablePage: Equatable, Sendable {
    /// 当前页的行（已搜索 / 已排序）。
    public let rows: [AdDataPageRow]
    /// 搜索后、翻页前的总行数（Web 的 `sorted.length`）。
    public let filteredCount: Int
    public let totalPages: Int
    /// clamp 之后的当前页（1-based；没有行时也是 1）。
    public let page: Int
    /// 当前页第一行在 `filteredCount` 里的 1-based 序号（无行时为 0）。
    public let pageStart: Int
    /// 当前页最后一行的 1-based 序号（无行时为 0）。
    public let pageEnd: Int

    public static let empty = AdDataTablePage(
        rows: [], filteredCount: 0, totalPages: 1, page: 1, pageStart: 0, pageEnd: 0
    )

    public var isEmpty: Bool { filteredCount == 0 }

    /// 「第 x-y / 共 n 行」（Web 的元信息行）。
    public var rangeText: String {
        guard filteredCount > 0 else { return "共 0 行" }
        return "第 \(pageStart)-\(pageEnd) / 共 \(filteredCount) 行"
    }
}

/// 原始行的**纯函数**流水线：搜索 → 排序 → 翻页。
///
/// 为什么挑出来做成纯类型：这三步是「搜索框输入 / 点表头 / 翻页」三条交互的全部口径，
/// 而它们最容易写成视图里的一堆 `onChange` —— 那样口径只能靠肉眼在界面上验。
/// 抽出来之后 `AdDataTableTests` 可以直接钉住「按格式化后的文本搜索」「数值列按数值排、
/// 文本列按字符串排」「同值稳定（不因排序抖动）」「越界页被夹回」这些分支。
///
/// 与 Web（`ad-data-explorer.tsx` 的 `filtered` / `sorted` / `pageRows`）逐条对应：
/// - 搜索：命中的判据是**格式化后**的单元格文本包含查询串（不是原始值）；
/// - 排序：`isNumericFormat` 为真按数值比较，否则按字符串；同值保持原序（Web 的
///   `Array.prototype.sort` 自 ES2019 起是稳定排序）；
/// - 翻页：`totalPages = max(1, ceil(n / pageSize))`，当前页夹到 `[1, totalPages]`。
public enum AdDataTablePipeline {
    /// 文本列排序的固定 locale（见 `compare` 的说明）。
    private static let compareLocale = Locale(identifier: "en_US_POSIX")
    /// 搜索：任一列格式化后的文本包含查询串即命中（大小写不敏感）。
    ///
    /// Web 用 `formatAdDataValue(...).toLowerCase().includes(q)` + `q = search.trim().toLowerCase()`，
    /// 这里逐条对应；空白查询返回原数组（不复制）。
    public static func search(
        _ rows: [DynamicJSONRow],
        columns: [AdDataColumn],
        query: String
    ) -> [DynamicJSONRow] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty, !columns.isEmpty else { return rows }
        return rows.filter { row in
            columns.contains { column in
                column.text(in: row).lowercased().contains(needle)
            }
        }
    }

    /// 排序：按 `sort.key` 对应的列。列不存在（换了报表类型）→ 原序返回（Web 同）。
    public static func sort(
        _ rows: [DynamicJSONRow],
        columns: [AdDataColumn],
        sort: AdDataSort?
    ) -> [DynamicJSONRow] {
        guard let sort, let column = columns.first(where: { $0.key == sort.key }) else { return rows }
        let sign = sort.direction == .ascending ? 1.0 : -1.0
        // 带原序做 tiebreak：Swift 的 `sorted(by:)` 不保证稳定，而 Web 的排序是稳定的
        // （同值行不得互换，否则两次点击同一个表头会得到不同的行序）。
        let indexed = rows.enumerated().sorted { lhs, rhs in
            let order = compare(lhs.element, rhs.element, by: column)
            if order == .orderedSame { return lhs.offset < rhs.offset }
            return sign > 0 ? order == .orderedAscending : order == .orderedDescending
        }
        return indexed.map(\.element)
    }

    private static func compare(
        _ lhs: DynamicJSONRow,
        _ rhs: DynamicJSONRow,
        by column: AdDataColumn
    ) -> ComparisonResult {
        if column.isNumeric {
            // 缺位按 0 参与比较（Web 是 `Number(undefined)` = NaN，比较结果为「都不成立」，
            // 等价于不重排；这里取 0 是为了给出**确定性**的全序，口径差异写进 PR）。
            let left = lhs.number(column.key) ?? 0
            let right = rhs.number(column.key) ?? 0
            if left == right { return .orderedSame }
            return left < right ? .orderedAscending : .orderedDescending
        }
        let left = lhs.string(column.key) ?? ""
        let right = rhs.string(column.key) ?? ""
        if left == right { return .orderedSame }
        // 文本列的比较**固定 locale**（`en_US_POSIX`）而不是跟随本机系统区域：
        // `localizedStandardCompare` / 不指定 locale 的 `compare` 会随开发机语言改变次序，
        // 同一份数据在两台机器上排出来不一样（测试也失去确定性）。`en_US_POSIX` 下
        // 「拉丁字母在前、CJK 在后」与常见的 zh-CN 浏览器 `localeCompare` 一致。
        // `.caseInsensitive` + `.numeric` 贴近 JS 的 `localeCompare` 语义；完全相等时
        // 由调用方的原序 tiebreak 决定（不因大小写而互换两行）。
        return left.compare(right, options: [.numeric, .caseInsensitive], locale: Self.compareLocale)
    }

    /// 切页：只切内存数组，不发请求（口径 5）。
    public static func page(
        _ rows: [DynamicJSONRow],
        page requestedPage: Int,
        pageSize: Int,
        columns: [AdDataColumn]
    ) -> AdDataTablePage {
        let size = max(1, pageSize)
        let totalPages = max(1, Int(ceil(Double(rows.count) / Double(size))))
        let page = min(max(1, requestedPage), totalPages)
        let start = (page - 1) * size
        guard start < rows.count else { return AdDataTablePage.empty }

        let slice = rows[start..<min(start + size, rows.count)]
        let pageRows = slice.enumerated().map { offset, row in
            AdDataPageRow(
                id: row.int("id") ?? (start + offset),
                row: row
            )
        }
        return AdDataTablePage(
            rows: pageRows,
            filteredCount: rows.count,
            totalPages: totalPages,
            page: page,
            pageStart: start + 1,
            pageEnd: min(start + size, rows.count)
        )
    }

    /// 搜索 → 排序 → 翻页一次跑完（store 每次重绘都走这一条，避免三处口径各自漂移）。
    public static func resolve(
        rows: [DynamicJSONRow],
        columns: [AdDataColumn],
        search query: String,
        sort: AdDataSort?,
        page requestedPage: Int,
        pageSize: Int
    ) -> AdDataTablePage {
        let matched = Self.search(rows, columns: columns, query: query)
        let ordered = Self.sort(matched, columns: columns, sort: sort)
        return Self.page(ordered, page: requestedPage, pageSize: pageSize, columns: columns)
    }
}
