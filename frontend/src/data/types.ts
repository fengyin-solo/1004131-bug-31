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
  // 归档态：进入这些状态的记录即归档，任何动作与联动都不得再回写。
  archivedStatuses?: string[]
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

// 批量动作的逐条处理结果：done 已流转 / skipped 按规则跳过 / failed 处理失败（批次断点）。
export type BatchItemResult = {
  id: number
  outcome: 'done' | 'skipped' | 'failed'
  message: string
}

export type BatchActionResult = {
  ok: boolean
  action: string
  results: BatchItemResult[]
  doneCount: number
  skippedCount: number
  failedCount: number
  message: string
}

// 取消记录是归档日志：只追加、不回写，同一业务记录最多一条。
export type CancelRecord = {
  id: string
  module: string
  entryId: number
  entryLabel: string
  flight: string
  usage: string
  syncedCleaning: string
  createdAt: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
