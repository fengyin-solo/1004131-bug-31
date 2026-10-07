import { listRows, saveRows } from '@/data/local-store'
import { appendCancelArchive } from '@/data/cancel-archive'
import type {
  BatchCancelResult,
  BatchItemResult,
  CancelArchiveRecord,
  EntryRow,
} from '@/data/types'

// 除冰整组取消：改为「逐条原子处理 + 批量汇总返回」。
// 旧实现一次提交多条、一次写回，中途失败就留下列表状态残留；现在每条独立落盘，
// 处理到哪条、进度就持久化到哪条，失败后下一次从断点继续，已处理的不会重做。
const CHECKPOINT_KEY = 'airport-ground-handling:deicing-batch-cancel-checkpoint'

const CANCEL_TARGET = '已取消'
/** 只有尚未进入终态的除冰记录允许取消；已完成的作业实绩不允许取消。 */
const CANCELLABLE_STATUSES = ['待除冰', '作业中']

type Checkpoint = {
  /** 本次整组取消的完整条目 id 签名，签名不符说明是新的一批，不能续做旧进度。 */
  signature: string
  remainingIds: number[]
  results: BatchItemResult[]
  operator: string
  source: string
  createdAt: string
  updatedAt: string
}

export type OneCancelResult = {
  ok: boolean
  outcome: BatchItemResult['outcome']
  message: string
}

function readCheckpoint(): Checkpoint | null {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null
  }
  const raw = window.localStorage.getItem(CHECKPOINT_KEY)
  if (!raw) {
    return null
  }
  try {
    return JSON.parse(raw) as Checkpoint
  } catch {
    return null
  }
}

function writeCheckpoint(checkpoint: Checkpoint | null): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  if (checkpoint === null) {
    window.localStorage.removeItem(CHECKPOINT_KEY)
    return
  }
  window.localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint))
}

function signatureOf(ids: number[]): string {
  return [...ids].sort((a, b) => a - b).join(',')
}

function describe(row: EntryRow): { code: string; flight: string } {
  return {
    code: String(row['除冰编号'] ?? ''),
    flight: String(row['关联航班'] ?? ''),
  }
}

/**
 * 取消单条除冰记录（原子操作）：
 * - 已取消：幂等跳过，不重复归档；
 * - 已完成：终态不允许取消，直接拒绝；
 * - 待除冰/作业中：先追加只写归档（按记录去重），再只改状态位。
 * 实际用量、开始/结束时间等历史字段一律保留原值。
 */
export function cancelDeicingEntry(
  id: number,
  options: { operator: string; source: string },
): OneCancelResult {
  const rows = listRows('deicing')
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, outcome: 'failed', message: `没有找到编号为 ${id} 的除冰记录` }
  }
  const row = rows[index]
  const current = String(row.status)
  if (current === CANCEL_TARGET) {
    return { ok: true, outcome: 'skipped', message: '已取消，跳过不重复处理' }
  }
  if (!CANCELLABLE_STATUSES.includes(current)) {
    return {
      ok: false,
      outcome: 'skipped',
      message: `当前状态「${current}」不允许取消（已完成优先保留，终态不可改）`,
    }
  }

  const { code, flight } = describe(row)
  const archiveRecord: CancelArchiveRecord = {
    entryId: id,
    code,
    flight,
    fromStatus: current,
    operator: options.operator,
    source: options.source,
    archivedAt: new Date().toISOString(),
  }
  appendCancelArchive(archiveRecord)

  // 历史用量等字段原样保留，只更新状态相关字段。
  const updated: EntryRow = {
    ...row,
    status: CANCEL_TARGET,
    pending: false,
  }
  const next = [...rows]
  next[index] = updated
  saveRows('deicing', next)
  return { ok: true, outcome: 'cancelled', message: `已取消（${current} → 已取消），实际用量保留原值` }
}

/**
 * 整组取消：逐条独立处理、逐条落盘，返回批量结果。
 * - 只跳过不允许取消的条目（已取消 / 已完成），不计为失败；
 * - 任一条处理抛错时立即停下并持久化断点，再次提交同一组时从断点续做；
 * - 全部处理完后清掉断点，不允许再续。
 */
export function batchCancelDeicing(
  rawIds: number[],
  options: { operator: string; source: string },
): BatchCancelResult {
  const requested = [...new Set(rawIds.map((id) => Number(id)))].sort((a, b) => a - b)
  if (requested.length === 0) {
    return {
      ok: false,
      message: '未选择任何除冰记录',
      results: [],
      cancelled: 0,
      skipped: 0,
      failed: 0,
      remaining: 0,
      resumed: false,
    }
  }

  const incomingSignature = signatureOf(requested)
  const existing = readCheckpoint()
  let checkpoint: Checkpoint
  let resumed = false

  if (existing && existing.signature === incomingSignature) {
    // 同一组、且有未完成断点：从断点续做，已处理的结果原样带回，绝不重做。
    checkpoint = { ...existing, updatedAt: new Date().toISOString() }
    resumed = true
  } else {
    if (existing) {
      // 旧断点属于另一组：新的一批开始前清掉它，避免互相污染。
      writeCheckpoint(null)
    }
    checkpoint = {
      signature: incomingSignature,
      remainingIds: requested,
      results: [],
      operator: options.operator,
      source: options.source,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  }

  const rows = listRows('deicing')
  while (checkpoint.remainingIds.length > 0) {
    const id = checkpoint.remainingIds[0]
    const row = rows.find((item) => Number(item.id) === id)
    const { code, flight } = row
      ? describe(row)
      : { code: `#${id}`, flight: '' }

    try {
      const result = cancelDeicingEntry(id, {
        operator: checkpoint.operator,
        source: checkpoint.source,
      })
      checkpoint.results.push({
        id,
        code,
        flight,
        outcome: result.outcome,
        message: result.message,
      })
      // 逐条落盘进度：无论取消成功还是跳过，这条都已处理完。
      checkpoint.remainingIds = checkpoint.remainingIds.slice(1)
      checkpoint.updatedAt = new Date().toISOString()
      writeCheckpoint(checkpoint)
    } catch (error) {
      // 真正的处理失败：停在当前断点，已处理的结果和剩余列表都已持久化，下次从这里续做。
      const message = error instanceof Error ? error.message : '处理失败'
      checkpoint.results.push({
        id,
        code,
        flight,
        outcome: 'failed',
        message: `处理中断：${message}（已存断点，下次从该条续做）`,
      })
      writeCheckpoint(checkpoint)
      return summarize(checkpoint, true, resumed)
    }
  }

  // 整组处理完毕，断点清除，归档账保留（只追加、不回写）。
  writeCheckpoint(null)
  return summarize(checkpoint, checkpoint.results.some((item) => item.outcome === 'failed'), resumed)
}

function summarize(
  checkpoint: Checkpoint,
  ok: boolean,
  resumed: boolean,
): BatchCancelResult {
  const cancelled = checkpoint.results.filter((item) => item.outcome === 'cancelled').length
  const skipped = checkpoint.results.filter((item) => item.outcome === 'skipped').length
  const failed = checkpoint.results.filter((item) => item.outcome === 'failed').length
  return {
    ok,
    message:
      checkpoint.remainingIds.length > 0
        ? `已处理 ${checkpoint.results.length} 条，${checkpoint.remainingIds.length} 条未处理，可从断点续做`
        : `整组处理完成：取消 ${cancelled} 条，跳过 ${skipped} 条${failed ? `，失败 ${failed} 条` : ''}`,
    results: checkpoint.results,
    cancelled,
    skipped,
    failed,
    remaining: checkpoint.remainingIds.length,
    resumed,
  }
}

/** 是否存在可续做的断点，供页面提示「从断点续做」。 */
export function getBatchCancelCheckpoint(): Checkpoint | null {
  return readCheckpoint()
}
