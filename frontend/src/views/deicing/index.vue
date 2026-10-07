<template>
  <section class="page" data-module="deicing">
    <header class="page-head">
      <div>
        <h2>除冰作业管理</h2>
        <p class="page-desc">维护除冰记录，围绕除冰编号、关联航班、除冰液类型、预计用量做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记除冰记录</button>
        <button
          class="btn danger"
          type="button"
          :disabled="!selectedIds.length || batchRunning"
          @click="runBatchCancel"
        >
          整组取消（已选 {{ selectedIds.length }} 条）
        </button>
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

    <div v-if="batchReport" class="batch-report">
      <p class="batch-summary" :class="{ 'error-text': batchReport.failedCount > 0 }">
        {{ batchReport.message }}
      </p>
      <ul class="batch-lines">
        <li v-for="item in batchReport.results" :key="item.id" :data-outcome="item.outcome">
          #{{ item.id }} {{ item.message }}
        </li>
      </ul>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th class="check-cell">
            <input
              type="checkbox"
              :checked="allCancellableSelected"
              :disabled="!cancellableIds.length"
              @change="toggleSelectAll"
            />
          </th>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td class="check-cell">
            <input
              type="checkbox"
              :checked="selectedIds.includes(Number(row.id))"
              :disabled="!isCancellable(row)"
              :title="isCancellable(row) ? '选择这条' : '已归档记录不可取消'"
              @change="toggleSelect(row)"
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
            <button class="link" type="button" @click="openDetail(row)">详情</button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无除冰作业数据，可先登记除冰记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条除冰作业记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <section v-if="cancelLog.length" class="cancel-log">
      <h3>取消记录（归档，只读）</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>记录编号</th>
            <th>除冰编号</th>
            <th>关联航班</th>
            <th>实际用量</th>
            <th>联动污染复查</th>
            <th>归档时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="record in cancelLog" :key="record.id">
            <td>{{ record.id }}</td>
            <td>{{ record.entryLabel }}</td>
            <td>{{ record.flight || '—' }}</td>
            <td>{{ record.usage || '—' }}</td>
            <td>{{ record.syncedCleaning || '—' }}</td>
            <td>{{ record.createdAt }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <div v-if="detailRow" class="detail-mask" @click.self="closeDetail">
      <div class="detail-panel">
        <header class="detail-head">
          <h3>除冰记录详情 #{{ detailRow.id }}</h3>
          <button class="link" type="button" @click="closeDetail">关闭</button>
        </header>
        <dl class="detail-grid">
          <template v-for="column in columns" :key="column">
            <dt>{{ column }}</dt>
            <dd>{{ detailRow[column] ?? '—' }}</dd>
          </template>
          <dt>当前状态</dt>
          <dd>{{ detailRow.status }}</dd>
        </dl>
        <footer class="detail-foot">
          <button
            v-for="action in actions"
            :key="action"
            class="btn"
            :class="{ danger: action === '取消作业' }"
            type="button"
            :disabled="action === '取消作业' && !isCancellable(detailRow)"
            @click="runAction(action, detailRow)"
          >
            {{ action }}
          </button>
        </footer>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listCancelLog,
  listEntries,
  moduleMeta,
  runAction as applyAction,
  runBatchAction,
} from '@/api/local-service'
import type { BatchActionResult, CancelRecord, EntryRow } from '@/data/types'

const meta = moduleMeta('deicing')
const columns = ["除冰编号", "关联航班", "除冰液类型", "预计用量", "实际用量", "开始时间", "结束时间", "作业状态"]
const actions = ["开始除冰", "确认完成", "取消作业"]
const statuses = ["待除冰", "作业中", "已完成", "已取消"]
const stats = [{"label": "待除冰航班", "value": 0}, {"label": "作业中航班", "value": 0}, {"label": "已完成除冰", "value": 0}]
// 取消与完成的优先级裁决：归档态优先——已完成、已取消的记录锁定，不再回写；
// 只有待除冰、作业中允许取消，完成过的记录不可再取消。
const archivedStatuses = meta.archivedStatuses ?? []

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const selectedIds = ref<number[]>([])
const batchRunning = ref(false)
const batchReport = ref<BatchActionResult | null>(null)
const cancelLog = ref<CancelRecord[]>([])
const detailRow = ref<EntryRow | null>(null)

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const cancellableIds = computed(() =>
  rows.value.filter(isCancellable).map((row) => Number(row.id)),
)

const allCancellableSelected = computed(
  () =>
    cancellableIds.value.length > 0 &&
    cancellableIds.value.every((id) => selectedIds.value.includes(id)),
)

function isCancellable(row: EntryRow): boolean {
  return !archivedStatuses.includes(String(row.status))
}

function toggleSelect(row: EntryRow) {
  const id = Number(row.id)
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter((item) => item !== id)
    : [...selectedIds.value, id]
}

function toggleSelectAll() {
  selectedIds.value = allCancellableSelected.value ? [] : [...cancellableIds.value]
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
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function runBatchCancel() {
  if (!selectedIds.value.length || batchRunning.value) {
    return
  }
  batchRunning.value = true
  try {
    const report = runBatchAction(meta.key, selectedIds.value, '取消作业')
    batchReport.value = report
    // 断点续做：失败和未轮到的条目保持选中，再次提交只处理它们，已归档的自动跳过。
    const finished = new Set(
      report.results.filter((item) => item.outcome !== 'failed').map((item) => item.id),
    )
    selectedIds.value = selectedIds.value.filter((id) => !finished.has(id))
    reload()
    if (report.failedCount > 0) {
      errorMessage.value = report.message
    }
  } finally {
    batchRunning.value = false
  }
}

function openDetail(row: EntryRow) {
  detailRow.value = row
}

function closeDetail() {
  detailRow.value = null
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    cancelLog.value = listCancelLog(meta.key)
    if (detailRow.value) {
      detailRow.value = rows.value.find((row) => Number(row.id) === Number(detailRow.value?.id)) ?? null
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '除冰作业列表读取失败'
  }
}

onMounted(reload)
</script>
