import type { CancelArchiveRecord } from './types'

// 除冰取消归档账：取消记录是审计凭证，只允许追加，永远不允许回写、修改或删除。
// 与业务主表分开存储：重置模块、清播种数据都不影响这份归档。
const ARCHIVE_KEY = 'airport-ground-handling:deicing-cancel-archive'

function readArchive(): CancelArchiveRecord[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  const raw = window.localStorage.getItem(ARCHIVE_KEY)
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as CancelArchiveRecord[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    // 归档损坏时宁可不读，也绝不用空数组覆盖写入（只追加原则）。
    return []
  }
}

function persist(records: CancelArchiveRecord[]): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(ARCHIVE_KEY, JSON.stringify(records))
  }
}

export function listCancelArchive(entryId?: number): CancelArchiveRecord[] {
  const records = readArchive()
  return typeof entryId === 'number'
    ? records.filter((record) => record.entryId === entryId)
    : records
}

export function hasCancelArchive(entryId: number): boolean {
  return readArchive().some((record) => record.entryId === entryId)
}

/**
 * 幂等追加：同一除冰记录已存在取消归档时，直接返回旧记录，不产生第二批记录。
 * 这是修掉「反复点击生成两批取消记录」的关键闸门。
 */
export function appendCancelArchive(record: CancelArchiveRecord): {
  record: CancelArchiveRecord
  created: boolean
} {
  const records = readArchive()
  const existing = records.find((item) => item.entryId === record.entryId)
  if (existing) {
    return { record: existing, created: false }
  }
  const next = [...records, record]
  persist(next)
  return { record, created: true }
}
