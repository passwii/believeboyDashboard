/**
 * 意向客户数据客户端接口（新模块独立，不并入现有 CrmClient 的 40+ 方法接口）。
 *
 * 实现见 http-client.ts（HttpIntentClient，经 /api/backend 代理，浏览器不持 key）。
 */
import type {
  IntentBatchDetail,
  IntentBatchPage,
  IntentBoard,
  IntentCompanyDetail,
  IntentCompanyPage,
  IntentConvertResult,
  IntentExportFile,
  IntentExportParams,
  IntentFollowup,
  IntentFollowupInput,
  IntentImportResult,
  IntentListParams,
  IntentMeta,
  IntentMetaRevs,
  IntentPoolPage,
  IntentPoolParams,
  IntentProfileInput,
  IntentRequestOptions,
  IntentScope,
  IntentWriteOptions,
} from './types'

/** 详情读取：可带当前 scope（sea 记录对非管理员也可读，P0-1）。 */
export type IntentCompanyDetailOptions = IntentRequestOptions & {
  scope?: IntentScope
}

export interface IntentClient {
  /** GET /meta：批次/统计/facets/rev；revs 相同返回 changed:false。 */
  getMeta(
    scope: IntentScope,
    revs?: IntentMetaRevs,
    options?: IntentRequestOptions
  ): Promise<IntentMeta>

  /** GET /companies：卡片/表格共用分页列表。 */
  listCompanies(
    params: IntentListParams,
    options?: IntentRequestOptions
  ): Promise<IntentCompanyPage>

  /** GET /companies/{id}?scope=：详情（含 phones/followup/shared_phones）。 */
  getCompany(id: number, options?: IntentCompanyDetailOptions): Promise<IntentCompanyDetail>

  /** PATCH /companies/{id}/followup：写跟进，带 If-Match version（409 冲突由调用方处理）。 */
  updateFollowup(
    id: number,
    input: IntentFollowupInput,
    version: number,
    options?: IntentWriteOptions
  ): Promise<IntentFollowup>

  /** POST /companies/{id}/claim：领取（sea → mine）；BE 返回更新后的整条 Company。 */
  claimCompany(id: number, options?: IntentWriteOptions): Promise<IntentCompanyDetail>

  /** POST /companies/{id}/phones：补录号码；BE 返回更新后的整条 Company（非 Phone）。 */
  addPhone(id: number, raw: string, options?: IntentWriteOptions): Promise<IntentCompanyDetail>

  /** PATCH /companies/{id}/phones/{phoneId}：设置有效电话；BE 返回整条 Company。 */
  setPhoneValid(
    id: number,
    phoneId: number,
    isValid: boolean,
    options?: IntentWriteOptions
  ): Promise<IntentCompanyDetail>

  /** DELETE /companies/{id}/phones/{phoneId}：删除人工补录号码；BE 返回整条 Company。 */
  deletePhone(
    id: number,
    phoneId: number,
    options?: IntentWriteOptions
  ): Promise<IntentCompanyDetail>

  /** PATCH /companies/{id}/profile：人工编辑资料（写人工锁）；BE 返回整条 Company。 */
  updateProfile(
    id: number,
    input: IntentProfileInput,
    options?: IntentWriteOptions
  ): Promise<IntentCompanyDetail>

  /** POST /companies/{id}/convert：转为客户（一次）；BE 返回 {customer_id, company, data_rev}。 */
  convertCompany(id: number, options?: IntentWriteOptions): Promise<IntentConvertResult>

  /** GET /board?scope=：8 组（count + top8）。 */
  getBoard(scope: IntentScope, options?: IntentRequestOptions): Promise<IntentBoard>

  /** GET /pool：待筛池只读分页（60/页）。 */
  getPool(params: IntentPoolParams, options?: IntentRequestOptions): Promise<IntentPoolPage>

  /** GET /export：服务端按当前筛选 + scope 生成 CSV（BOM）。 */
  exportCsv(params: IntentExportParams, options?: IntentRequestOptions): Promise<IntentExportFile>

  /** POST /batches/upload：人工导入（admin，multipart）；返回 IngestResult。 */
  uploadBatch(form: FormData, options?: IntentWriteOptions): Promise<IntentImportResult>

  /** GET /batches：批次历史分页（admin）。 */
  listBatches(page?: number, pageSize?: number, options?: IntentRequestOptions): Promise<IntentBatchPage>

  /** GET /batches/{id}：批次详情（admin，含 rejected/rows/rows_truncated）。 */
  getBatch(id: number, options?: IntentRequestOptions): Promise<IntentBatchDetail>
}
