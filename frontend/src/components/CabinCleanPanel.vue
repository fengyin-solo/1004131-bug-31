<template>
  <section class="cabin-panel" :data-source="source">
    <header class="cabin-panel-head">
      <div>
        <h3>{{ title }}</h3>
        <p class="batch-hint">与客舱清洁主清单共用同一份数据与污染复查待办账，任意入口操作都会双向同步。</p>
      </div>
      <button v-if="showExport" class="btn" type="button" @click="exportRows">导出清单</button>
    </header>

    <div v-if="showFilters" class="filter-bar">
      <label class="filter-item">
        <span>清洁编号</span>
        <input v-model="keyword" placeholder="按清洁编号/航班检索" />
      </label>
      <button class="btn" type="button" @click="reload">查询</button>
    </div>

    <div class="todo-bar">
      <span class="todo-pill">污染复查待办：{{ openTodos.length }} 条</span>
      <button class="link" type="button" @click="reload">刷新对账</button>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in displayedRows" :key="String(row.id)">
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
        <tr v-if="!displayedRows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无可展示的清洁任务</td>
        </tr>
      </tbody>
    </table>

    <div class="todo-panel">
      <h4>污染复查待办（{{ openTodos.length }}）</h4>
      <ul v-if="openTodos.length" class="todo-list">
        <li v-for="todo in openTodos" :key="todo.id">
          <span>{{ todo.code }}（{{ todo.flight || '未关联航班' }}）</span>
          <span class="batch-hint">来源入口：{{ todo.source }}</span>
        </li>
      </ul>
      <p v-else class="batch-hint">暂无待复查项。</p>
    </div>

    <p v-if="message" :class="messageOk ? 'result-ok' : 'error-text'">{{ message }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  reconcilePollutionTodos,
  runAction as applyAction,
} from '@/api/local-service'
import { listPollutionTodos } from '@/data/pollution-todo'
import type { EntryRow, PollutionTodo } from '@/data/types'

const props = withDefaults(
  defineProps<{
    source?: string
    title?: string
    showFilters?: boolean
    showExport?: boolean
  }>(),
  {
    source: '客舱清洁清单',
    title: '客舱清洁清单',
    showFilters: true,
    showExport: false,
  },
)

const meta = moduleMeta('cabin_clean')
const columns = ['清洁编号', '关联航班', '清洁类型', '清洁班组', '计划开始', '实际完成', '清洁用时', '清洁状态']
const actions = ['开始清洁', '完成清洁', '安排复查', '复查通过']

const rows = ref<EntryRow[]>([])
const keyword = ref('')
const message = ref('')
const messageOk = ref(true)
const openTodos = ref<PollutionTodo[]>([])

const displayedRows = computed(() => {
  const word = keyword.value.trim()
  if (!word) {
    return rows.value
  }
  return rows.value.filter(
    (row) =>
      String(row['清洁编号'] ?? '').includes(word) ||
      String(row['关联航班'] ?? '').includes(word),
  )
})

function exportRows() {
  downloadEntries(meta.key)
}

function runAction(action: string, row: EntryRow) {
  message.value = ''
  // source 透传到待办账，可区分是主清单还是其它入口开的复查。
  const result = applyAction(meta.key, Number(row.id), action, { source: props.source })
  message.value = result.message
  messageOk.value = result.ok
  if (result.ok) {
    reload()
  }
}

function reload() {
  // 先对账再读取：其它入口或外部改动造成的状态偏差在这一步并入同一份待办账。
  reconcilePollutionTodos(props.source)
  rows.value = listEntries(meta.key).items
  openTodos.value = listPollutionTodos('待复查')
}

onMounted(reload)

defineExpose({ reload })
</script>

<style scoped>
.cabin-panel {
  margin-top: 16px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
}
.cabin-panel-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 8px;
}
.cabin-panel-head h3 {
  margin: 0;
  font-size: 15px;
}
.batch-hint {
  font-size: 12px;
  color: var(--muted);
}
.todo-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}
.todo-pill {
  background: #fef3c7;
  border: 1px solid #f59e0b;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
}
.todo-panel {
  margin-top: 10px;
}
.todo-panel h4 {
  margin: 0 0 6px;
  font-size: 13px;
}
.todo-list {
  margin: 0;
  padding-left: 18px;
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.result-ok {
  color: #067647;
}
.error-text {
  color: #b42318;
}
</style>
