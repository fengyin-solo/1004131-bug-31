import type { PollutionTodo } from './types'

// 污染复查待办账：客舱清洁无论从主清单还是其它入口（如过站监控内嵌清单）标记「需复查」，
// 都进同一份待办；复查通过后在原账上关闭留痕，不在各处各建一份。
const TODO_KEY = 'airport-ground-handling:cabin-pollution-todos'

function readTodos(): PollutionTodo[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  const raw = window.localStorage.getItem(TODO_KEY)
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as PollutionTodo[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function persist(todos: PollutionTodo[]): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(TODO_KEY, JSON.stringify(todos))
  }
}

export function listPollutionTodos(status?: PollutionTodo['status']): PollutionTodo[] {
  const todos = readTodos()
  return status ? todos.filter((todo) => todo.status === status) : todos
}

export function countOpenPollutionTodos(): number {
  return readTodos().filter((todo) => todo.status === '待复查').length
}

/** 开账幂等：同一条清洁任务已有待复查账时，只刷新来源入口，不重复建账。 */
export function openPollutionTodo(input: {
  entryId: number
  code: string
  flight: string
  source: string
}): PollutionTodo {
  const todos = readTodos()
  const index = todos.findIndex((todo) => todo.entryId === input.entryId)
  if (index >= 0) {
    const current = todos[index]
    if (current.status === '待复查') {
      return current
    }
    const reopened: PollutionTodo = {
      ...current,
      status: '待复查',
      source: input.source,
      closedAt: undefined,
    }
    const next = [...todos]
    next[index] = reopened
    persist(next)
    return reopened
  }
  const created: PollutionTodo = {
    id: todos.length ? Math.max(...todos.map((todo) => todo.id)) + 1 : 1,
    entryId: input.entryId,
    code: input.code,
    flight: input.flight,
    source: input.source,
    openedAt: new Date().toISOString(),
    status: '待复查',
  }
  persist([...todos, created])
  return created
}

/** 关账：在原待办上标记关闭，保留开账记录可追溯。 */
export function closePollutionTodo(entryId: number): PollutionTodo | null {
  const todos = readTodos()
  const index = todos.findIndex(
    (todo) => todo.entryId === entryId && todo.status === '待复查',
  )
  if (index < 0) {
    return null
  }
  const closed: PollutionTodo = {
    ...todos[index],
    status: '已关闭',
    closedAt: new Date().toISOString(),
  }
  const next = [...todos]
  next[index] = closed
  persist(next)
  return closed
}
