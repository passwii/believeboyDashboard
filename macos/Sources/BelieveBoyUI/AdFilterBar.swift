import BelieveBoyKit
import SwiftUI

/// 驱动共享筛选条的 store 契约（「广告分析」与「广告数据」两页各有一个 store）。
///
/// 为什么用协议而不是复制一份筛选条视图：筛选条本身（项目 / 站点 / 日期区间 + 刷新）
/// 两页完全一样，差异只有**两处文案**（日期关掉时实际发出去的口径、当前查询的一句话说明）
/// —— 那两处正好是各页的真实语义差异，所以放进协议让 store 提供。视图里再复制一份绑定
/// 逻辑，只会让「清空日期」这类边缘分支在两页悄悄分叉。
///
/// `AnyObject` + `@MainActor`：两个实现都是 `@MainActor @Observable` 的引用类型，
/// 视图直接读它们的属性（Observation 自动跟踪）。
@MainActor
protocol AdFilterDriving: AnyObject {
    /// 当前账号可见的项目（`/projects/manage`，按 `X-Operator` 过滤）。
    var projects: [AdProject] { get }
    var filters: AdFilters { get }

    func setProject(id: Int?)
    func setCountry(_ country: String)
    func setUsesDateRange(_ enabled: Bool)
    func setDateFrom(_ date: String?)
    func setDateTo(_ date: String?)

    /// 日期区间**关掉**时实际发出去的口径说明（两页不同）：
    /// 广告分析不传参数（后端聚合全量历史）、广告数据用哨兵窗口。
    var dateRangeOffNote: String { get }

    /// 当前生效查询的一句话说明（含数据拉取时刻）。
    var filterSummary: String { get }
}

/// 共享筛选条：项目 / 站点 / 日期区间（**可空**）。
///
/// 日期区间的默认是**关闭 = 不限定日期**（关掉后落到查询上是什么，由各页的
/// `dateRangeOffNote` 说明）；打开时补一个近 30 天初值 —— 打开却仍是空区间等于什么都没变，
/// 用户看不出开关生效了。
struct AdFilterBar<Store: AdFilterDriving>: View {
    let store: Store
    let isRefreshing: Bool
    let onRefresh: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 12) {
                projectPicker
                Divider().frame(height: 18)
                countryPicker
                Divider().frame(height: 18)
                dateControls
                Spacer(minLength: 8)
                Button(action: onRefresh) {
                    Label("刷新", systemImage: "arrow.clockwise")
                }
                .disabled(isRefreshing)
                .help("按当前筛选条件重新拉取")
                if isRefreshing {
                    ProgressView().controlSize(.small)
                }
            }
            Text(store.filterSummary)
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
    }

    private var projectPicker: some View {
        HStack(spacing: 6) {
            Text("项目")
                .font(.caption)
                .foregroundStyle(.secondary)
            Picker("项目", selection: projectSelection) {
                if store.filters.projectID == nil {
                    Text("选择项目").tag(Int?.none)
                }
                ForEach(store.projects) { project in
                    Text(project.name).tag(Int?.some(project.id))
                }
            }
            .labelsHidden()
            .frame(minWidth: 160, maxWidth: 220)
        }
    }

    private var projectSelection: Binding<Int?> {
        Binding(
            get: { store.filters.projectID },
            set: { store.setProject(id: $0) }
        )
    }

    private var countryPicker: some View {
        HStack(spacing: 6) {
            Text("站点")
                .font(.caption)
                .foregroundStyle(.secondary)
            Picker("站点", selection: countrySelection) {
                ForEach(AdCountries.all) { country in
                    Text(country.label).tag(country.code)
                }
            }
            .labelsHidden()
            .frame(minWidth: 120, maxWidth: 150)
        }
    }

    private var countrySelection: Binding<String> {
        Binding(
            get: { store.filters.country },
            set: { store.setCountry($0) }
        )
    }

    private var dateControls: some View {
        HStack(spacing: 8) {
            Toggle("按日期筛选", isOn: dateRangeToggle)
                .toggleStyle(.checkbox)
                .help("不限定日期时按各页的默认口径取数（见下方说明行）")
            if store.filters.usesDateRange {
                DatePicker(
                    "起",
                    selection: dateFromSelection,
                    displayedComponents: .date
                )
                .labelsHidden()
                DatePicker(
                    "止",
                    selection: dateToSelection,
                    displayedComponents: .date
                )
                .labelsHidden()
            } else {
                Text(store.dateRangeOffNote)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var dateRangeToggle: Binding<Bool> {
        Binding(
            get: { store.filters.usesDateRange },
            set: { enabled in
                store.setUsesDateRange(enabled)
                if enabled, store.filters.dateFrom == nil {
                    let today = AdAnalysisFormatting.dayString(Date())
                    store.setDateFrom(AdAnalysisFormatting.dayString(daysFromToday: -29))
                    store.setDateTo(today)
                }
            }
        )
    }

    private var dateFromSelection: Binding<Date> {
        Binding(
            get: {
                store.filters.dateFrom.flatMap { AdAnalysisFormatting.date(fromDayString: $0) }
                    ?? Date()
            },
            set: { store.setDateFrom(AdAnalysisFormatting.dayString($0)) }
        )
    }

    private var dateToSelection: Binding<Date> {
        Binding(
            get: {
                store.filters.dateTo.flatMap { AdAnalysisFormatting.date(fromDayString: $0) }
                    ?? Date()
            },
            set: { store.setDateTo(AdAnalysisFormatting.dayString($0)) }
        )
    }
}
