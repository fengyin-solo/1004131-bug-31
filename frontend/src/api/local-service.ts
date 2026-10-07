import { MODULE_BY_KEY } from '@/data/modules'
import {
  allRows,
  appendCancelRecord,
  clearCancelRecords,
  listCancelRecords,
  listRows,
  resetRows,
  saveRows,
} from '@/data/local-store'
import type {
  ActionResult,
  BatchActionResult,
  BatchItemResult,
  CancelRecord,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

// 每个模块都有一个以「状态」结尾的业务字段，流转时和系统状态一起改，列表入口不再残留旧值。
function statusFieldOf(meta: ModuleMeta): string | undefined {
  return meta.fields.find((field) => field.endsWith('状态'))
}

// 归档态记录（如已完成、已取消）不得回写：任何动作和联动都对它们跳过。
function isArchived(meta: ModuleMeta, status: string): boolean {
  return (meta.archivedStatuses ?? []).includes(status)
}

// 生成流转后的记录：只动状态相关列，历史字段（如实际用量）一律保留原值。
function buildTransition(meta: ModuleMeta, row: EntryRow, action: string): EntryRow {
  const target = meta.actionTargets[action]
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const statusField = statusFieldOf(meta)
  const updated: EntryRow = {
    ...row,
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  if (statusField) {
    updated[statusField] = target
  }
  return updated
}

// 除冰取消的联动：同航班的在途客舱清洁生成污染复查待办；已归档或已有待办的清洁记录不动。
function syncCabinCleanPollution(flight: string): string[] {
  const meta = moduleMeta('cabin_clean')
  const target = meta.actionTargets['安排复查']
  const statusField = statusFieldOf(meta)
  const rows = listRows('cabin_clean')
  const affected: string[] = []
  const next = rows.map((row) => {
    if (String(row['关联航班'] ?? '') !== flight) {
      return row
    }
    const current = String(row.status)
    if (current === target || isArchived(meta, current)) {
      return row
    }
    affected.push(String(row['清洁编号'] ?? row.id))
    return {
      ...row,
      status: target,
      ...(statusField ? { [statusField]: target } : {}),
      pending: target !== meta.statuses[meta.statuses.length - 1],
    }
  })
  if (affected.length > 0) {
    saveRows('cabin_clean', next)
  }
  return affected
}

// 流转后的联动统一在这里登记，列表、详情、批量等所有入口走同一个漏斗，行为一致。
function afterTransition(key: string, meta: ModuleMeta, row: EntryRow, action: string): string {
  if (key !== 'deicing' || meta.actionTargets[action] !== '已取消') {
    return ''
  }
  const flight = String(row['关联航班'] ?? '')
  const synced = flight ? syncCabinCleanPollution(flight) : []
  const { record, created } = appendCancelRecord({
    module: key,
    entryId: Number(row.id),
    entryLabel: String(row['除冰编号'] ?? row.id),
    flight,
    // 取消时的实际用量原值快照进归档，业务记录上的历史用量也保持不动。
    usage: String(row['实际用量'] ?? ''),
    syncedCleaning: synced.join('、'),
  })
  const notes = [created ? `取消记录 ${record.id} 已归档` : `取消记录 ${record.id} 已存在，未重复生成`]
  notes.push(synced.length > 0 ? `已同步客舱污染复查：${synced.join('、')}` : '同航班没有在途清洁任务，无需同步复查')
  return notes.join('；')
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (isArchived(meta, current)) {
    return { ok: false, message: `${meta.entity}已归档（${current}），归档记录不再回写` }
  }
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const updated = buildTransition(meta, rows[index], action)
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  const note = afterTransition(key, meta, updated, action)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」${note ? `；${note}` : ''}` }
}

// 批量动作：逐条处理、逐条落库，最后批量返回结果。
// 不允许操作的条目只跳过不中断；真正失败时停在断点，重试会跳过已归档条目从断点续做。
export function runBatchAction(key: string, ids: number[], action: string): BatchActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  const summary = (results: BatchItemResult[]): BatchActionResult => {
    const doneCount = results.filter((item) => item.outcome === 'done').length
    const skippedCount = results.filter((item) => item.outcome === 'skipped').length
    const failedCount = results.filter((item) => item.outcome === 'failed').length
    const message =
      failedCount > 0
        ? `已${action} ${doneCount} 条，跳过 ${skippedCount} 条，失败 ${failedCount} 条；已处理的部分已落库，重新提交可从断点续做`
        : `已${action} ${doneCount} 条，跳过 ${skippedCount} 条`
    return { ok: failedCount === 0, action, results, doneCount, skippedCount, failedCount, message }
  }
  if (!target) {
    return summary([{ id: 0, outcome: 'failed', message: `${meta.entity}没有登记「${action}」这个动作` }])
  }
  const results: BatchItemResult[] = []
  // 同一次提交先去重，多选重复或反复点击都不会产生第二批记录。
  const queue = [...new Set(ids.map(Number))]
  for (const id of queue) {
    // 每条都基于最新数据判断：前一条的落库结果对后一条可见。
    const rows = listRows(key)
    const index = rows.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      results.push({ id, outcome: 'skipped', message: `没有找到编号为 ${id} 的${meta.entity}，已跳过` })
      continue
    }
    const current = String(rows[index].status)
    if (isArchived(meta, current)) {
      results.push({ id, outcome: 'skipped', message: `已归档（${current}），跳过不回写` })
      continue
    }
    if (current === target) {
      results.push({ id, outcome: 'skipped', message: `已经是「${target}」，跳过` })
      continue
    }
    try {
      const updated = buildTransition(meta, rows[index], action)
      const next = [...rows]
      next[index] = updated
      saveRows(key, next)
      const note = afterTransition(key, meta, updated, action)
      results.push({ id, outcome: 'done', message: `已${action}，当前状态「${target}」${note ? `；${note}` : ''}` })
    } catch (error) {
      results.push({
        id,
        outcome: 'failed',
        message: error instanceof Error ? error.message : '处理失败，原因未知',
      })
      break
    }
  }
  return summary(results)
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  clearCancelRecords(key)
  return listEntries(key)
}

export function listCancelLog(key: string): CancelRecord[] {
  return [...listCancelRecords(key)].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
