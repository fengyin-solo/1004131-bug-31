<template>
  <section class="page" data-module="deicing">
    <header class="page-head">
      <div>
        <h2>除冰作业管理</h2>
        <p class="page-desc">维护除冰记录，围绕除冰编号、关联航班、除冰液类型、预计用量做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记除冰记录</button>
        <button class="btn" type="button" @click="exportRows">导出除冰作业清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <div v-if="checkpoint" class="resume-banner">
      <span>
        检测到上次整组取消在第 {{ checkpoint.results.length + 1 }} 条处中断，
        尚有 {{ checkpoint.remainingIds.length }} 条未处理，已处理的不会重做。
      </span>
      <button class="btn primary" type="button" :disabled="busy" @click="resumeBatch">
        从断点续做
      </button>
    </div>

    <div class="batch-bar">
      <label class="batch-check">
        <input type="checkbox" :checked="allSelectableChecked" @change="toggleSelectAll" />
        全选可取消项
      </label>
      <button
        class="btn primary"
        type="button"
        :disabled="busy || selectedIds.size === 0"
        @click="cancelSelected"
      >
        {{ busy ? '逐条处理中…' : `整组取消（已选 ${selectedIds.size} 条，逐条处理）` }}
      </button>
      <span class="batch-hint">已完成不可取消；已取消自动跳过，不产生重复记录；取消后实际用量保留原值。</span>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th class="col-check">选择</th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td class="col-check">
            <input
              type="checkbox"
              :checked="selectedIds.has(Number(row.id))"
              :disabled="!cancellable(row)"
              @change="toggleSelect(Number(row.id))"
            />
          </td>
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无除冰作业数据，可先登记除冰记录</td>
        </tr>
      </tbody>
    </table>

    <div v-if="batchResult" class="result-panel">
      <h3>整组取消结果（{{ batchResult.resumed ? '断点续做' : '本次提交' }}）</h3>
      <p :class="batchResult.ok ? 'result-ok' : 'error-text'">{{ batchResult.message }}</p>
      <table class="data-table">
        <thead>
          <tr><th>除冰编号</th><th>关联航班</th><th>结果</th><th>说明</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in batchResult.results" :key="item.id">
            <td>{{ item.code || `#${item.id}` }}</td>
            <td>{{ item.flight || '—' }}</td>
            <td :class="outcomeClass(item.outcome)">{{ outcomeLabel(item.outcome) }}</td>
            <td>{{ item.message }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <section class="archive-panel">
      <h3>取消归档（只读，共 {{ archiveRows.length }} 条）</h3>
      <p class="batch-hint">归档记录只追加、不回写；重复取消同一记录不会生成第二批记录。</p>
      <table class="data-table">
        <thead>
          <tr><th>除冰编号</th><th>关联航班</th><th>原状态</th><th>操作人</th><th>来源入口</th><th>归档时间</th></tr>
        </thead>
        <tbody>
          <tr v-for="record in archiveRows" :key="`${record.entryId}-${record.archivedAt}`">
            <td>{{ record.code }}</td>
            <td>{{ record.flight || '—' }}</td>
            <td>{{ record.fromStatus }}</td>
            <td>{{ record.operator }}</td>
            <td>{{ record.source }}</td>
            <td>{{ formatTime(record.archivedAt) }}</td>
          </tr>
          <tr v-if="!archiveRows.length">
            <td colspan="6" class="empty-state">暂无取消归档记录</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条除冰作业记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  batchCancelDeicing,
  getBatchCancelCheckpoint,
} from '@/api/deicing-service'
import { listCancelArchive } from '@/data/cancel-archive'
import { useSessionStore } from '@/stores/session'
import type { BatchCancelResult, BatchItemOutcome, CancelArchiveRecord, EntryRow } from '@/data/types'

const meta = moduleMeta('deicing')
const session = useSessionStore()
const columns = ["除冰编号", "关联航班", "除冰液类型", "预计用量", "实际用量", "开始时间", "结束时间", "作业状态"]
const actions = ["开始除冰", "确认完成", "取消作业"]
const statuses = ["待除冰", "作业中", "已完成", "已取消"]
// 只有待除冰/作业中允许取消；已完成优先保留，终态不可改。
const cancellableStatuses = new Set(["待除冰", "作业中"])

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const selectedIds = ref<Set<number>>(new Set())
const busy = ref(false)
const batchResult = ref<BatchCancelResult | null>(null)
const checkpoint = ref(getBatchCancelCheckpoint())
const archiveRows = ref<CancelArchiveRecord[]>([])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => [
  { label: '待除冰航班', value: countByStatus('待除冰') },
  { label: '作业中航班', value: countByStatus('作业中') },
  { label: '已完成除冰', value: countByStatus('已完成') },
])

const selectableRows = computed(() => rows.value.filter((row) => cancellable(row)))
const allSelectableChecked = computed(
  () =>
    selectableRows.value.length > 0 &&
    selectableRows.value.every((row) => selectedIds.value.has(Number(row.id))),
)

function countByStatus(status: string): number {
  return rows.value.filter((row) => String(row.status) === status).length
}

function cancellable(row: EntryRow): boolean {
  return cancellableStatuses.has(String(row.status))
}

function toggleSelect(id: number) {
  const next = new Set(selectedIds.value)
  if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)
  }
  selectedIds.value = next
}

function toggleSelectAll(event: Event) {
  const checked = (event.target as HTMLInputElement).checked
  selectedIds.value = checked
    ? new Set(selectableRows.value.map((row) => Number(row.id)))
    : new Set()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '除冰记录登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action, { source: '除冰作业列表' })
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  selectedIds.value = new Set([...selectedIds.value].filter((id) => id !== Number(row.id)))
  reload()
}

function cancelSelected() {
  submitBatch([...selectedIds.value])
}

function resumeBatch() {
  const current = getBatchCancelCheckpoint()
  if (!current) {
    return
  }
  // 续做必须带上完整的一组（已处理 + 剩余），服务层签名命中后只做剩余部分。
  const doneIds = current.results.map((item) => item.id)
  submitBatch([...doneIds, ...current.remainingIds])
}

function submitBatch(ids: number[]) {
  errorMessage.value = ''
  busy.value = true
  try {
    batchResult.value = batchCancelDeicing(ids, {
      operator: session.operator,
      source: '除冰作业列表-整组取消',
    })
  } finally {
    busy.value = false
  }
  selectedIds.value = new Set()
  checkpoint.value = getBatchCancelCheckpoint()
  reload()
  refreshArchive()
}

function outcomeLabel(outcome: BatchItemOutcome): string {
  if (outcome === 'cancelled') return '已取消'
  if (outcome === 'skipped') return '已跳过'
  return '失败'
}

function outcomeClass(outcome: BatchItemOutcome): string {
  if (outcome === 'cancelled') return 'result-ok'
  if (outcome === 'skipped') return 'result-skip'
  return 'error-text'
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function refreshArchive() {
  archiveRows.value = listCancelArchive()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    // 过滤掉已不在可取消状态的勾选项。
    const validIds = new Set(
      rows.value.filter(cancellable).map((row) => Number(row.id)),
    )
    selectedIds.value = new Set([...selectedIds.value].filter((id) => validIds.has(id)))
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '除冰作业列表读取失败'
  }
}

onMounted(() => {
  reload()
  refreshArchive()
})
</script>

<style scoped>
.batch-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 10px;
  padding: 8px 10px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.batch-check {
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.batch-hint {
  font-size: 12px;
  color: var(--muted);
}
.col-check {
  width: 44px;
  text-align: center;
}
.resume-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
  padding: 8px 12px;
  background: #fef3c7;
  border: 1px solid #f59e0b;
  border-radius: 8px;
  font-size: 13px;
}
.result-panel,
.archive-panel {
  margin-top: 16px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
}
.result-panel h3,
.archive-panel h3 {
  margin: 0 0 8px;
  font-size: 14px;
}
.result-ok {
  color: #067647;
}
.result-skip {
  color: var(--muted);
}
</style>
