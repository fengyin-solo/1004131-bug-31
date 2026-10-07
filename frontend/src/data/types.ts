/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 除冰取消归档：只允许追加、不允许回写，因此没有任何可变字段。 */
export type CancelArchiveRecord = {
  entryId: number
  code: string
  flight: string
  fromStatus: string
  operator: string
  source: string
  archivedAt: string
}

/** 整组取消时，逐条处理后的单条结果。 */
export type BatchItemOutcome = 'cancelled' | 'skipped' | 'failed'

export type BatchItemResult = {
  id: number
  code: string
  flight: string
  outcome: BatchItemOutcome
  message: string
}

export type BatchCancelResult = {
  ok: boolean
  message: string
  /** 本次提交累计已处理的每条结果（含断点前已完成的部分）。 */
  results: BatchItemResult[]
  cancelled: number
  skipped: number
  failed: number
  /** 断点处尚未处理的条数；为 0 表示整组处理完毕。 */
  remaining: number
  resumed: boolean
}

/** 污染复查待办：客舱清洁任一入口标记「需复查」都开同一份账，复查通过后关闭留痕。 */
export type PollutionTodo = {
  id: number
  entryId: number
  code: string
  flight: string
  source: string
  openedAt: string
  status: '待复查' | '已关闭'
  closedAt?: string
}
