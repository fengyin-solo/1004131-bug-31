<template>
  <section class="page" data-module="cabin_clean">
    <header class="page-head">
      <div>
        <h2>客舱清洁管理</h2>
        <p class="page-desc">维护清洁任务，围绕清洁编号、关联航班、清洁类型、清洁班组做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记清洁任务</button>
        <button class="btn" type="button" @click="exportRows">导出客舱清洁清单</button>
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

    <CabinCleanPanel
      ref="panelRef"
      source="客舱清洁清单"
      title="客舱清洁清单"
      :show-filters="true"
      :show-export="true"
    />

    <footer class="page-foot">
      <span>共 {{ total }} 条客舱清洁记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import CabinCleanPanel from '@/components/CabinCleanPanel.vue'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('cabin_clean')
const statuses = ['待清洁', '清洁中', '已完成', '需复查']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const panelRef = ref<InstanceType<typeof CabinCleanPanel> | null>(null)

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => [
  { label: '待清洁航班', value: rows.value.filter((row) => String(row.status) === '待清洁').length },
  { label: '清洁中航班', value: rows.value.filter((row) => String(row.status) === '清洁中').length },
  { label: '需复查航班', value: rows.value.filter((row) => String(row.status) === '需复查').length },
])

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '清洁任务登记入口尚未接入审批流'
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '客舱清洁列表读取失败'
  }
  // 共享面板内部也持有一份数据，动作后由它自行刷新；挂载后这里同步统计即可。
  panelRef.value?.reload()
}

onMounted(reload)
</script>
