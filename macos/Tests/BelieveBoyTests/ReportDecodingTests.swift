import BelieveBoyKit
import XCTest

/// 快照解码与目录口径的**离线**断言（真实响应来自 `Fixtures/Report/`，抓取口径见其 README）。
///
/// 这一批钉三件事：
/// 1. **后端字段名就是客户端写的那种**（`convertFromSnakeCase` 之后的名字必须对得上）——
///    名字写错在 Swift 侧不报错、不解码失败，只会静默少一个字段；
/// 2. **RPA 状态矩阵的列集与后端真报的类型一致**（15 列不是猜的）；
/// 3. **「同源同值」的抽样数字**（哪个日期、多少项目、多少格已上传）—— 口径写在 README，
///    数字钉在这里。
final class ReportDecodingTests: XCTestCase {

    // MARK: - 快照完整性

    /// 每个夹具文件的 sha256 / 字节数都必须与 manifest 一致。
    ///
    /// 这条是「夹具被人手改过」与「忘了更新 manifest」的机械拦截点：重抓后 manifest 由脚本
    /// 一并更新，手改单文件必然报红。
    func testCommittedSnapshotHashesMatchManifest() throws {
        let manifest = try ReportFixtures.manifest()
        XCTAssertFalse(manifest.files.isEmpty, "manifest 里至少要有一个文件")
        for file in manifest.files {
            let data = try ReportFixtures.data(fileName: file.file)
            XCTAssertEqual(data.count, file.bytes, "\(file.file) 字节数与 manifest 不一致")
            XCTAssertEqual(
                try ReportFixtures.sha256Hex(fileName: file.file),
                file.sha256,
                "\(file.file) 的 sha256 与 manifest 不一致（重抓后是否忘了更新 manifest？）"
            )
        }
    }

    /// manifest 记录的是本批的固定抽样口径（比对数值时照这两个念）。
    func testManifestSamplingWindow() throws {
        let params = try ReportFixtures.manifest().params
        XCTAssertEqual(params.country, "US")
        XCTAssertEqual(params.rpaReportDate, "2026-09-14")
        XCTAssertEqual(params.adUploadStatusLimit, 50, "ad-upload/status 的页面口径 = 后端默认值 50")
        XCTAssertEqual(params.syntheticAdReport.reportType, "ad_promoted_product_report")
    }

    // MARK: - RPA 状态矩阵（`GET /rpa-reports/status`）

    /// 真实响应的形状 + 抽样数字：项目数、每个项目的格数、全表已上传格数。
    func testRpaStatusSnapshotShapeAndSampledCounts() throws {
        let response = try ReportFixtures.rpaStatus()
        XCTAssertEqual(response.country, "US")
        XCTAssertEqual(response.items.count, 10, "BLF-1068 抽样当天的真实项目数")

        for project in response.items {
            XCTAssertEqual(
                project.statuses.count,
                ReportAutomationCatalog.columns.count,
                "每个项目都应当有 \(ReportAutomationCatalog.columns.count) 格（后端与 Web 的列集一致）"
            )
            XCTAssertFalse(project.projectName.isEmpty)
            XCTAssertEqual(project.country, "US")
        }

        let completeness = ReportAutomationCatalog.completeness(response.items)
        XCTAssertEqual(completeness.reported, 150, "10 个项目 × 15 列")
        XCTAssertEqual(completeness.uploaded, 133, "BLF-1068 抽样当天的真实已上传格数")
        XCTAssertFalse(completeness.isEmpty)
    }

    /// 后端真报的 `report_type` 集合**就是**目录里的那 15 列（列序照抄 Web，
    /// 集合由这条与后端对齐）。
    func testCatalogColumnsMatchBackendReportTypes() throws {
        let response = try ReportFixtures.rpaStatus()
        let backendTypes = Set(
            response.items.flatMap { $0.statuses.map(\.reportType) }
        )
        let catalogTypes = Set(ReportAutomationCatalog.columns.map(\.reportType))
        XCTAssertEqual(
            backendTypes,
            catalogTypes,
            "目录列与后端真报的类型必须一一对应；差集：\(backendTypes.symmetricDifference(catalogTypes))"
        )
    }

    /// 首个项目 `博朗姆`（id=19）的 14/15 与「唯一缺 `payment_report`」。
    func testSampledProjectMissingCellIsPaymentReport() throws {
        let response = try ReportFixtures.rpaStatus()
        let project = try XCTUnwrap(
            response.items.first { $0.projectID == 19 },
            "抽样当天应当有 id=19 的项目"
        )
        XCTAssertEqual(project.projectName, "博朗姆")

        let missing = ReportAutomationCatalog.columns.filter {
            ReportAutomationCatalog.cellState(project, column: $0) != .uploaded
        }
        XCTAssertEqual(missing.map(\.reportType), ["payment_report"])
        XCTAssertEqual(ReportAutomationCatalog.completeness(project).text, "14/15")
    }

    /// 末个项目 `吕沃`（id=16）满格 15/15 —— 顺带证明「满格」不是不可能，
    /// 所以 14/15 那条不是解析错误。
    func testSampledProjectWithFullCoverage() throws {
        let response = try ReportFixtures.rpaStatus()
        let project = try XCTUnwrap(response.items.first { $0.projectID == 16 })
        XCTAssertEqual(project.projectName, "吕沃")
        XCTAssertEqual(ReportAutomationCatalog.completeness(project).text, "15/15")
    }

    /// 单元格状态解析：`is_uploaded` 直接决定绿/红；**少一列**（后端没给）是 `unreported`
    /// 而不是红叉。
    func testCellStateMapsUploadedAndMissingAndUnreported() throws {
        let response = try ReportFixtures.rpaStatus()
        let project = try XCTUnwrap(response.items.first)
        let column = ReportAutomationCatalog.columns[0]
        XCTAssertEqual(ReportAutomationCatalog.cellState(project, column: column), .uploaded)

        // 合成一个「后端少报一列」的项目：unreported 不计入分母。
        let trimmed = RpaProjectStatus(
            projectID: project.projectID,
            projectName: project.projectName,
            country: project.country,
            statuses: project.statuses.filter { $0.reportType != column.reportType }
        )
        XCTAssertEqual(ReportAutomationCatalog.cellState(trimmed, column: column), .unreported)
        let trimmedCompleteness = ReportAutomationCatalog.completeness(trimmed)
        XCTAssertEqual(
            trimmedCompleteness.reported,
            ReportAutomationCatalog.completeness([project]).reported - 1,
            "unreported 不进分母 —— 否则后端少报一列会让 M/N 永远做不满"
        )
    }

    // MARK: - 广告入库状态（`GET /ad-upload/status`）

    /// 50 条 = 顶到 limit（口径：顶到上限即可能被截断，界面要提示），
    /// 类型集合 = 10 个广告报表类型，项目数 = 6。
    func testAdUploadStatusSnapshotShapeAndTruncation() throws {
        let params = try ReportFixtures.manifest().params
        let response = try ReportFixtures.adUploadStatus()
        XCTAssertEqual(response.country, "US")
        XCTAssertEqual(
            response.items.count,
            params.adUploadStatusLimit,
            "抽样当天正好顶到 limit —— 这正是「可能被截断」的口径来源"
        )
        XCTAssertEqual(
            Set(response.items.map(\.reportType)),
            Set(AdUploadReportTypes.all),
            "入库状态里出现的类型集合应当就是 10 个广告类型"
        )
        for item in response.items {
            XCTAssertTrue(item.isIngested, "入库状态列表里的记录应当是 success/saved")
            XCTAssertFalse(item.projectName.isEmpty)
            XCTAssertFalse(item.reportLabel.isEmpty, "报告标签要能显示（后端给了就直接用）")
        }
    }

    /// 过滤参数那一组（同一端点的第二种形状）：`report_type` 过滤后只剩一种类型。
    func testAdUploadStatusFilteredSnapshotIsSingleReportType() throws {
        let response = try ReportFixtures.adUploadStatusFiltered()
        XCTAssertEqual(Set(response.items.map(\.reportType)), ["ad_promoted_product_report"])
        XCTAssertFalse(response.items.isEmpty)
    }

    /// 日期列展示口径：单日报表显示 `report_date`。
    func testStatusItemDateTextPrefersReportDate() throws {
        let response = try ReportFixtures.adUploadStatus()
        let item = try XCTUnwrap(response.items.first { $0.reportDate != nil })
        XCTAssertEqual(item.dateText, item.reportDate)
    }

    // MARK: - 识别（`POST /ad-upload/recognize`）

    /// 真实识别响应的每一条判据都要能被解出来：类型 / 标签 / 命中列 / 日期 / 项目匹配 /
    /// 行数预览 / 警告。**少解出来一条，用户确认时就是闭着眼睛点。**
    func testRecognitionSnapshotDocumentsEveryJudgement() throws {
        let recognition = try ReportFixtures.recognition()
        XCTAssertEqual(recognition.reportType, "ad_promoted_product_report")
        XCTAssertEqual(recognition.reportLabel, "推广的商品")
        XCTAssertEqual(recognition.status, .recognized)
        XCTAssertTrue(recognition.status.isRecognized)
        XCTAssertEqual(recognition.fileExtension, ".csv")
        XCTAssertEqual(recognition.country, "US")
        XCTAssertFalse(recognition.tempFileID.isEmpty)
        XCTAssertEqual(
            recognition.matchedColumns,
            ["开始日期", "结束日期", "广告SKU", "广告ASIN", "广告活动名称", "广告组名称"]
        )
        XCTAssertEqual(recognition.rowCountPreview, 2)
        XCTAssertTrue(recognition.warnings.isEmpty)
        XCTAssertEqual(recognition.detectedRange?.start, "2026-09-07")
        XCTAssertEqual(recognition.detectedRange?.end, "2026-09-07")
        XCTAssertEqual(recognition.detectedReportDate, "2026-09-07")
    }

    /// 项目匹配：SKU 命中唯一项目 → `matched`，UI 因此可以把项目预填并锁定。
    func testRecognitionSnapshotMatchedProjectBySKU() throws {
        let recognition = try ReportFixtures.recognition()
        XCTAssertEqual(recognition.projectMatch.status, .matched)
        XCTAssertTrue(recognition.projectMatch.status.isAutoResolved)
        XCTAssertEqual(recognition.projectMatch.projectName, "创酷")
        XCTAssertEqual(recognition.projectMatch.matchedBy, "sku")
        XCTAssertEqual(recognition.projectMatch.matchedValues, ["JDB-10PCS1-4"])
        XCTAssertEqual(recognition.projectMatch.candidateProjects, ["创酷"])
    }

    /// 真实 `extension` 字段名就叫 `extension`（它是个 Swift 关键字，属性名因此错位，
    /// 靠 `CodingKeys` 显式对上 —— 这条就是那个映射的回归）。
    func testRecognitionDecodesExtensionKeyDespiteKeywordName() throws {
        let raw = try ReportFixtures.rawJSON(fileName: "ad-upload-recognize.json")
        XCTAssertEqual(raw["extension"] as? String, ".csv")
        XCTAssertEqual(try ReportFixtures.recognition().fileExtension, ".csv")
    }

    // MARK: - 入库（`POST /ad-upload/commit`）

    /// `dry_run` 的真实响应：`ingestion_status=skipped`、`id=0`、`version=0` ——
    /// **没有半成品**（没写业务表、没占版本号）由此可证。
    func testCommitDryRunSnapshotIsSkippedAndNotPersisted() throws {
        let result = try ReportFixtures.commitResult()
        XCTAssertEqual(result.ingestionStatus, "skipped")
        XCTAssertTrue(result.isDryRun)
        XCTAssertEqual(result.id, 0)
        XCTAssertEqual(result.version, 0)
        XCTAssertEqual(result.reportType, "ad_promoted_product_report")
        XCTAssertEqual(result.projectName, "创酷")
        XCTAssertEqual(result.country, "US")
        XCTAssertEqual(result.reportDate, "2026-09-07")
        XCTAssertFalse(result.fileID.isEmpty, "file_id 是产品分析异步任务的输入，必须解出来")
        XCTAssertTrue(result.message.contains("未写入 ad_upload_files"), "后端明说没入库：\(result.message)")
    }

    /// 回归（BLF-1068 阻塞 1）：交给 `POST /product-analysis-reports` 的广告报告标识
    /// 必须是后端 `build_upload_file_path` 能解开的那个。
    ///
    /// 真实夹具（`ad-upload-commit-dry-run.json`）里 `file_id` 是裸文件名、`file_path` 是
    /// `UPLOAD_ROOT/_ad_upload/<项目>/<类型>/<该文件名>` 的绝对路径 —— 后者才能被
    /// 产品分析端点解析（实测：发裸 file_id → `Report file not found`；发 file_path → success）。
    func testProductAnalysisFileIDUsesResolvableAbsolutePath() throws {
        let result = try ReportFixtures.commitResult()
        XCTAssertTrue(
            result.fileID.contains("/") == false,
            "file_id 是裸文件名（不含目录）：\(result.fileID)"
        )
        XCTAssertTrue(
            result.filePath.contains("/_ad_upload/"),
            "file_path 是广告域临时区的完整路径：\(result.filePath)"
        )
        XCTAssertTrue(
            result.filePath.contains("/\(result.fileID)"),
            "file_path 以 file_id 结尾 —— 两者是同一份文件的两个标识"
        )
        XCTAssertEqual(
            result.productAnalysisFileID,
            result.filePath,
            "优先用完整 file_path（产品分析能直接解开）"
        )
        XCTAssertNotEqual(
            result.productAnalysisFileID,
            result.fileID,
            "裸 file_id 指向 `_ad_upload/<项目>/<类型>/`，与产品分析的 `<项目>/ad-product-report/` 不一致"
        )
    }

    /// 回退分支：响应缺 `file_path`（后端该字段非可选，正常不出现）时退回 `file_id`，
    /// 而不是把空串发出去 —— 空串会被后端当成「没填」。
    func testProductAnalysisFileIDFallsBackToFileIDWhenPathMissing() {
        let result = AdUploadCommitResult(
            id: 0,
            reportType: "ad_promoted_product_report",
            reportLabel: "推广的商品",
            ingestionStatus: "skipped",
            projectName: "创酷",
            country: "US",
            reportStartDate: "2026-09-07",
            reportEndDate: "2026-09-07",
            fileID: "only-name.xlsx",
            filePath: "",
            version: 0,
            isCurrent: false,
            message: "dry_run"
        )
        XCTAssertEqual(result.productAnalysisFileID, "only-name.xlsx")
    }

    // MARK: - 异步核算任务（`product-analysis-reports`）

    /// 发起响应的两个端点是后端给的**带 `/api/v1` 的绝对路径** —— 客户端要把它归一化成
    /// 「相对 `APIClient` 的路径」，否则 `APIClient` 再拼一次前缀会变成
    /// `/api/v1/api/v1/...`（404）。夹具里的真实值就是带前缀的那种。
    func testTicketNormalisesBackendPrefixedEndpoints() throws {
        let raw = try ReportFixtures.rawJSON(fileName: "product-analysis-report-create.json")
        XCTAssertEqual(
            raw["status_endpoint"] as? String,
            "/api/v1/product-analysis-reports/tasks/1",
            "后端给的就是带 /api/v1 的绝对路径"
        )

        let ticket = try ReportFixtures.productAnalysisTicket()
        XCTAssertEqual(ticket.status, .failed)
        XCTAssertEqual(
            ticket.resolvedStatusPath,
            "/product-analysis-reports/tasks/\(ticket.jobID)",
            "归一化后不带 /api/v1（前缀由 APIClient 拼）"
        )
        XCTAssertEqual(
            ticket.resolvedResultPath,
            "/product-analysis-reports/tasks/\(ticket.jobID)/result"
        )
    }

    /// 端点归一化的边界：带前缀 / 不带前缀 / 只有前缀 / 空值。
    func testClientPathNormalisationBoundaries() {
        XCTAssertEqual(
            ReportCatalog.clientPath(fromBackendEndpoint: "/api/v1/ad-upload/status"),
            "/ad-upload/status"
        )
        XCTAssertEqual(
            ReportCatalog.clientPath(fromBackendEndpoint: "/ad-upload/status"),
            "/ad-upload/status",
            "已经不带前缀的原样保留"
        )
        XCTAssertEqual(ReportCatalog.clientPath(fromBackendEndpoint: "/api/v1"), "/")
        XCTAssertNil(ReportCatalog.clientPath(fromBackendEndpoint: nil))
        XCTAssertNil(ReportCatalog.clientPath(fromBackendEndpoint: "   "))
    }

    /// 真实 failed 终态的形状：`status` / `stage` / `progress` / `persistence_status` 是四个
    /// 不同的东西，终态判定只看前者。
    func testFailedTaskSnapshotShape() throws {
        let status = try ReportFixtures.failedTaskStatus()
        XCTAssertEqual(status.status, .failed)
        XCTAssertTrue(status.isTerminal)
        XCTAssertFalse(status.isSuccess)
        XCTAssertFalse(status.hasDownloadableResult)
        XCTAssertEqual(status.progress, 100)
        XCTAssertEqual(status.stage, "failed")
        XCTAssertEqual(status.persistenceStatus, "idle")
        XCTAssertNil(status.persistenceMessage)
        XCTAssertEqual(status.progressFraction, 1)
        let error = try XCTUnwrap(status.errorMessage)
        XCTAssertTrue(error.contains("Report file not found"), "真实失败原因：\(error)")
        XCTAssertTrue(status.summaryText.hasPrefix("处理失败："), status.summaryText)
    }

    /// 未知状态**不**让整条响应解码失败（后端加一个状态不该把页面变成错误页）。
    func testUnknownTaskStatusIsNotTerminal() throws {
        let json = #"""
        {"task_id": 7, "status": "cancelled", "stage": "cancelled", "progress": 40,
         "message": null, "error_message": null, "persistence_status": "idle",
         "persistence_message": null,
         "created_at": "2026-09-15T01:00:00Z", "updated_at": "2026-09-15T01:00:01Z"}
        """#
        let status = try ReportFixtures.apiDecoder().decode(
            ProductAnalysisTaskStatus.self,
            from: Data(json.utf8)
        )
        XCTAssertEqual(status.status.rawValue, "cancelled")
        XCTAssertFalse(status.isTerminal, "未知状态按非终态处理，由轮询上限兜底")
        XCTAssertEqual(status.summaryText, "cancelled", "没有 message 就回退到 stage")
    }

    /// 四条真实错误体：客户端要能把后端的**中文 detail** 原样显示出来（而不是只显示状态码）。
    func testErrorEnvelopesSurfaceBackendDetail() throws {
        let unsupported = try ReportFixtures.errorEnvelope(
            fileName: "ad-upload-recognize-unsupported-extension.json"
        )
        XCTAssertEqual(unsupported.status, 400)
        XCTAssertTrue(unsupported.detail.contains("Unsupported extension"), unsupported.detail)

        let unknownHeaders = try ReportFixtures.errorEnvelope(
            fileName: "ad-upload-recognize-unknown-headers.json"
        )
        XCTAssertEqual(unknownHeaders.status, 400)
        XCTAssertEqual(unknownHeaders.detail, "未命中广告报表识别规则，请检查文件格式或表头")

        let mismatch = try ReportFixtures.errorEnvelope(
            fileName: "ad-upload-commit-type-mismatch.json"
        )
        XCTAssertEqual(mismatch.status, 422)
        XCTAssertEqual(mismatch.detail, "report_type does not match recognized report")

        let notReady = try ReportFixtures.errorEnvelope(
            fileName: "product-analysis-result-not-ready.json"
        )
        XCTAssertEqual(notReady.status, 409)
        XCTAssertEqual(notReady.detail, "Task not finished")

        let notFound = try ReportFixtures.errorEnvelope(
            fileName: "product-analysis-task-not-found.json"
        )
        XCTAssertEqual(notFound.status, 404)
        XCTAssertEqual(notFound.detail, "Task not found")

        // 错误分类：400/404/409/422 都不是凭据问题（不得把用户赶回登录页）。
        let error = APIError.http(status: unsupported.status, body: #"{"detail":"\#(unsupported.detail)"}"#)
        XCTAssertFalse(error.requiresCredentialFix)
        XCTAssertTrue(error.displayMessage.contains("Unsupported extension"), error.displayMessage)
    }

    // MARK: - 目录口径

    /// 标签表照抄 Web `report-type-labels.ts`：广告列带「广告 - 」前缀、历史值保留映射、
    /// 认不出来的回退原始 key、`unknown` 回退「未识别」。
    func testReportTypeLabelsMatchWebMapping() {
        XCTAssertEqual(ReportTypeLabels.label(for: "business_report"), "业务报告")
        XCTAssertEqual(ReportTypeLabels.label(for: "payment_report"), "付款报告")
        XCTAssertEqual(ReportTypeLabels.label(for: "return_report"), "退货报告")
        XCTAssertEqual(ReportTypeLabels.label(for: "ad_promoted_product_report"), "广告 - 推广的商品")
        XCTAssertEqual(ReportTypeLabels.label(for: "ad_time_trend_report"), "广告 - 按时间查看效果")
        XCTAssertEqual(ReportTypeLabels.label(for: "inventory_ledger"), "历史库存分类账类型（待重新识别）")
        XCTAssertEqual(ReportTypeLabels.label(for: "unknown"), "未识别")
        XCTAssertEqual(ReportTypeLabels.label(for: nil), "未识别")
        XCTAssertEqual(ReportTypeLabels.label(for: ""), "未识别")
        XCTAssertEqual(ReportTypeLabels.label(for: "brand_new_type"), "brand_new_type")
        XCTAssertEqual(ReportTypeLabels.labels.count, 20, "6 个非广告 + 10 个广告 + 3 个历史 + unknown")
    }

    /// 后端 `AdUploadType` 是 11 个字面量（10 个广告类型 + `unknown`）。
    func testAdUploadTypeCoverage() {
        XCTAssertEqual(ReportTypeLabels.adTypeLabels.count, 10)
        XCTAssertEqual(AdUploadReportTypes.all.count, 10)
        XCTAssertEqual(AdUploadReportTypes.backendLiterals.count, 11)
        XCTAssertTrue(AdUploadReportTypes.backendLiterals.contains("unknown"))
        XCTAssertTrue(AdUploadReportTypes.isAdReport("ad_campaign_report"))
        XCTAssertFalse(AdUploadReportTypes.isAdReport("business_report"))
        XCTAssertTrue(AdUploadReportTypes.requiresDateRange("payment_report"))
        XCTAssertFalse(AdUploadReportTypes.requiresDateRange("ad_promoted_product_report"))
    }

    /// 端点表：本批只搬这些，逐条钉住（改名时这条会先报红）。
    func testEndpointCatalog() {
        XCTAssertEqual(ReportCatalog.adUploadRecognizeEndpoint, "/ad-upload/recognize")
        XCTAssertEqual(ReportCatalog.adUploadCommitEndpoint, "/ad-upload/commit")
        XCTAssertEqual(ReportCatalog.adUploadStatusEndpoint, "/ad-upload/status")
        XCTAssertEqual(ReportCatalog.productAnalysisReportsEndpoint, "/product-analysis-reports")
        XCTAssertEqual(
            ReportCatalog.productAnalysisTaskEndpoint(taskID: 12),
            "/product-analysis-reports/tasks/12"
        )
        XCTAssertEqual(
            ReportCatalog.productAnalysisResultEndpoint(taskID: 12),
            "/product-analysis-reports/tasks/12/result"
        )
        XCTAssertEqual(ReportCatalog.rpaStatusEndpoint, "/rpa-reports/status")
        XCTAssertEqual(ReportCatalog.projectsEndpoint, "/projects/manage", "复用既有同源实现")
        XCTAssertEqual(ReportCatalog.uploadFileField, "file")
        XCTAssertEqual(ReportCatalog.uploadCountryField, "country")
        XCTAssertEqual(ReportCatalog.adUploadStatusLimit, 50)
        XCTAssertEqual(ReportCatalog.productAnalysisRouteID, "/dashboard/reports/product-analysis")
        XCTAssertEqual(ReportCatalog.reportAutomationRouteID, "/dashboard/reports/auto-upload")
    }

    /// 查询参数只发有值的（空串会被后端当成「按空串过滤」）。
    func testQueryParameterShapes() {
        let bare = AdUploadStatusQuery()
        XCTAssertEqual(bare.parameters, ["country": "US", "limit": "50"])

        let filtered = AdUploadStatusQuery(
            country: "DE",
            projectName: "  创酷  ",
            reportType: "ad_campaign_report",
            reportDate: "2026-09-07",
            limit: 10
        )
        XCTAssertEqual(
            filtered.parameters,
            [
                "country": "DE",
                "limit": "10",
                "project_name": "创酷",
                "report_type": "ad_campaign_report",
                "report_date": "2026-09-07",
            ]
        )
        XCTAssertEqual(AdUploadStatusQuery(projectName: "  ").parameters.count, 2, "空白串不发")

        let rpa = RpaReportStatusQuery(reportDate: "2026-09-14")
        XCTAssertEqual(rpa.parameters, ["report_date": "2026-09-14", "country": "US"])
        XCTAssertTrue(rpa.isValid)
        XCTAssertFalse(RpaReportStatusQuery(reportDate: "2026-9-4").isValid)
    }

    // MARK: - 日期口径

    /// 本机时区的 `yyyy-MM-dd` 往返 + 按天平移（Web `shiftDateString`）。
    func testLocalDateStringRoundTripAndShift() throws {
        var calendar = Calendar(identifier: .gregorian)
        let timeZone = try XCTUnwrap(TimeZone(identifier: "Asia/Shanghai"))
        calendar.timeZone = timeZone
        let components = DateComponents(year: 2026, month: 3, day: 1, hour: 12)
        let march1 = try XCTUnwrap(calendar.date(from: components))

        XCTAssertEqual(ReportCatalog.localDateString(march1, timeZone: timeZone), "2026-03-01")
        XCTAssertEqual(ReportCatalog.shiftDateString("2026-03-01", days: -1, timeZone: timeZone), "2026-02-28")
        XCTAssertEqual(ReportCatalog.shiftDateString("2026-02-28", days: 1, timeZone: timeZone), "2026-03-01")
        XCTAssertEqual(
            ReportCatalog.shiftDateString("not-a-date", days: 1, timeZone: timeZone),
            "not-a-date",
            "非法输入保持原值 —— 不要拿 Date() 顶替（用户可能正输到一半）"
        )
        // 只校验 `YYYY-MM-DD` 的形状与数值范围；**不**做真实日历校验（"2026-02-31" 会过这一
        // 关，交给后端 Pydantic 的 `date` 报 422 —— 客户端把能提前判的判掉，不自作聪明
        // 改写用户的输入）。
        XCTAssertNil(ReportCatalog.parseDateString("2026-13-01"), "月份越界")
        XCTAssertNil(ReportCatalog.parseDateString("2026-01-32"), "日期越界")
        XCTAssertNil(ReportCatalog.parseDateString("2026/01/01"), "分隔符不是 -")
        XCTAssertNil(ReportCatalog.parseDateString("26-01-01"), "年份位数不对")
        XCTAssertNotNil(ReportCatalog.parseDateString("2026-02-31"), "日历合法性由后端裁决")
    }

    /// 页面默认区间照抄 Web：上周（周一~周日）与上月。
    func testDefaultDateRangesMatchWeb() throws {
        let timeZone = try XCTUnwrap(TimeZone(identifier: "Asia/Shanghai"))
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        // 2026-09-15 是周二 → 上周 = 2026-09-07（周一）~ 2026-09-13（周日）。
        let tuesday = try XCTUnwrap(
            calendar.date(from: DateComponents(year: 2026, month: 9, day: 15, hour: 10))
        )
        let week = ReportDateRanges.lastWeek(now: tuesday, timeZone: timeZone)
        XCTAssertEqual(week.start, "2026-09-07")
        XCTAssertEqual(week.end, "2026-09-13")

        // 周日属于「本周」的末尾而不是下一周的开头（getDay()===0 那条边界）。
        let sunday = try XCTUnwrap(
            calendar.date(from: DateComponents(year: 2026, month: 9, day: 20, hour: 10))
        )
        let sundayWeek = ReportDateRanges.lastWeek(now: sunday, timeZone: timeZone)
        XCTAssertEqual(sundayWeek.start, "2026-09-07")
        XCTAssertEqual(sundayWeek.end, "2026-09-13")

        let month = ReportDateRanges.lastMonth(now: tuesday, timeZone: timeZone)
        XCTAssertEqual(month.start, "2026-08-01")
        XCTAssertEqual(month.end, "2026-08-31")

        // 跨年边界：1 月的上一个月是上一年的 12 月。
        let january = try XCTUnwrap(
            calendar.date(from: DateComponents(year: 2026, month: 1, day: 15, hour: 10))
        )
        let december = ReportDateRanges.lastMonth(now: january, timeZone: timeZone)
        XCTAssertEqual(december.start, "2025-12-01")
        XCTAssertEqual(december.end, "2025-12-31")
    }
}
