import { SEED_ROWS } from './seed'
import type { CancelRecord, EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'airport-ground-handling:entries'
// 取消记录单独存一份：它是归档日志，和业务清单分开，只追加不回写。
const CANCEL_STORAGE_KEY = 'airport-ground-handling:cancel-records'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

let cancelCache: CancelRecord[] | null = null

function readCancelStorage(): CancelRecord[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  const raw = window.localStorage.getItem(CANCEL_STORAGE_KEY)
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as CancelRecord[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeCancelStorage(records: CancelRecord[]): void {
  cancelCache = records
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(CANCEL_STORAGE_KEY, JSON.stringify(records))
  }
}

export function listCancelRecords(module?: string): CancelRecord[] {
  if (cancelCache === null) {
    cancelCache = readCancelStorage()
  }
  return module ? cancelCache.filter((record) => record.module === module) : cancelCache
}

// 追加取消记录：同一业务记录只留一条，重复提交直接返回已归档的那条，不会生成第二批。
export function appendCancelRecord(
  entry: Omit<CancelRecord, 'id' | 'createdAt'>,
): { record: CancelRecord; created: boolean } {
  const records = [...listCancelRecords()]
  const existing = records.find(
    (record) => record.module === entry.module && record.entryId === entry.entryId,
  )
  if (existing) {
    return { record: existing, created: false }
  }
  const record: CancelRecord = {
    ...entry,
    id: `CXL-${String(records.length + 1).padStart(4, '0')}`,
    createdAt: new Date().toISOString(),
  }
  writeCancelStorage([...records, record])
  return { record, created: true }
}

export function clearCancelRecords(module: string): void {
  writeCancelStorage(listCancelRecords().filter((record) => record.module !== module))
}
