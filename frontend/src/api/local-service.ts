import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  closePollutionTodo,
  countOpenPollutionTodos,
  openPollutionTodo,
} from '@/data/pollution-todo'
import { cancelDeicingEntry } from '@/api/deicing-service'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 状态流转门禁：不配置的模块沿用「任意非终态都可流转」的旧行为；
// 明确配置的模块必须从允许的前置状态发起，完成与取消的优先级在这里裁决。
const TERMINAL_STATUSES: Record<string, string[]> = {
  deicing: ['已完成', '已取消'],
  cabin_clean: ['已完成'],
}

const ALLOWED_TRANSITIONS: Record<string, Record<string, string[]>> = {
  deicing: {
    开始除冰: ['待除冰'],
    确认完成: ['作业中'],
    // 已完成是受保护终态：取消只允许在作业实绩落定之前（待除冰/作业中）发起。
    取消作业: ['待除冰', '作业中'],
  },
  cabin_clean: {
    开始清洁: ['待清洁'],
    完成清洁: ['清洁中'],
    安排复查: ['清洁中', '已完成'],
    复查通过: ['需复查'],
  },
}

const CABIN_CODE_FIELD = '清洁编号'
const CABIN_FLIGHT_FIELD = '关联航班'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
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

function isTerminal(meta: ModuleMeta, status: string): boolean {
  const terminal = TERMINAL_STATUSES[meta.key]
  if (terminal) {
    return terminal.includes(status)
  }
  return status === meta.statuses[meta.statuses.length - 1]
}

/**
 * 客舱清洁污染复查待办与主清单对账：
 * 主清单里处于「需复查」却没待办的补开账，已不是「需复查」却仍挂着待办的关掉。
 * 任何入口打开页面都会顺手对账一次，保证多入口看到的是同一份待办。
 */
export function reconcilePollutionTodos(source = '客舱清洁清单'): void {
  const rows = listRows('cabin_clean')
  for (const row of rows) {
    const id = Number(row.id)
    const inReview = String(row.status) === '需复查'
    if (inReview) {
      openPollutionTodo({
        entryId: id,
        code: String(row[CABIN_CODE_FIELD] ?? ''),
        flight: String(row[CABIN_FLIGHT_FIELD] ?? ''),
        source,
      })
    } else {
      closePollutionTodo(id)
    }
  }
}

export function runAction(
  key: string,
  id: number,
  action: string,
  options: { source?: string } = {},
): ActionResult {
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
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }

  // 流转门禁：已完成/已取消等终态不得再被改成其它状态。
  const gate = ALLOWED_TRANSITIONS[meta.key]?.[action]
  if (gate && !gate.includes(current)) {
    return {
      ok: false,
      message: `当前状态「${current}」不允许执行「${action}」（仅${gate.join('、')}可发起）`,
    }
  }

  // 除冰取消走专用原子通道：先写只追加归档（按记录幂等去重），再只改状态位，
  // 历史实际用量等字段保留原值，列表与详情不会再出现一边残留一边已删的撕裂。
  if (meta.key === 'deicing' && action === '取消作业') {
    const result = cancelDeicingEntry(id, {
      operator: '值班管理员',
      source: options.source ?? '除冰作业列表',
    })
    if (result.outcome === 'cancelled') {
      return { ok: true, message: `除冰记录${result.message}` }
    }
    return { ok: false, message: result.message }
  }

  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: !isTerminal(meta, target),
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)

  // 客舱清洁复查待办随动作同步：任一入口标记「需复查」都开同一份账，复查通过/完成则关账。
  if (meta.key === 'cabin_clean') {
    if (target === '需复查') {
      openPollutionTodo({
        entryId: id,
        code: String(updated[CABIN_CODE_FIELD] ?? ''),
        flight: String(updated[CABIN_FLIGHT_FIELD] ?? ''),
        source: options.source ?? '客舱清洁清单',
      })
    } else {
      closePollutionTodo(id)
    }
  }

  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: '\uFEFF' + lines.join('\n') }
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
    { label: '污染复查待办', value: countOpenPollutionTodos() },
  ]
  return { cards, modules }
}
