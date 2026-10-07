import './local-storage-shim'
import assert from 'node:assert'
import { resetRows } from '@/data/local-store'
import { runAction, listEntries } from '@/api/local-service'
import { batchCancelDeicing, getBatchCancelCheckpoint } from '@/api/deicing-service'
import { listCancelArchive, hasCancelArchive } from '@/data/cancel-archive'
import { listPollutionTodos, countOpenPollutionTodos } from '@/data/pollution-todo'

function failures(expect: boolean, label: string) {
  try {
    assert.ok(expect, label)
    console.log('PASS', label)
  } catch (e) {
    console.error('FAIL', label, (e as Error).message)
    process.exitCode = 1
  }
}

resetRows('deicing')
resetRows('cabin_clean')

// ---------- 除冰：完成优先，已完成不可取消 ----------
// seed: 1=待除冰, 2=作业中, 3=已完成
const r3 = runAction('deicing', 3, '取消作业', { source: 'test' })
failures(r3.ok === false, '已完成记录取消被拒绝（完成优先于取消）')

// 已取消不可再完成
const r1c = runAction('deicing', 1, '取消作业', { source: 'test' })
failures(r1c.ok === true, '待除冰记录可以取消')
const r1done = runAction('deicing', 1, '确认完成', { source: 'test' })
failures(r1done.ok === false, '已取消记录不可再完成（取消终态）')

// 历史用量保留原值
const row1 = listEntries('deicing').items.find((r) => r.id === 1)!
failures(String(row1['实际用量']) === '除冰作业样例1', '取消后实际用量保留原值')
failures(row1.pending === false, '取消后 pending=false，列表不再残留作业状态')

// 反复取消不产生第二批归档
runAction('deicing', 1, '取消作业', { source: 'test' })
failures(listCancelArchive(1).length === 1, '重复取消不产生重复归档（幂等）')

// 作业中 -> 完成 允许；待除冰 -> 完成 拒绝
const r2ok = runAction('deicing', 2, '确认完成', { source: 'test' })
failures(r2ok.ok === true, '作业中可以确认完成')
resetRows('deicing')

// ---------- 整组取消：逐条处理、跳过终态、断点续做 ----------
const batch = batchCancelDeicing([1, 2, 3], { operator: 'tester', source: 'test-batch' })
failures(batch.cancelled === 2, `整组取消 2 条可取消（实际 ${batch.cancelled}）`)
failures(batch.skipped === 1, `已完成 1 条只跳过（实际 ${batch.skipped}）`)
failures(batch.failed === 0, '整组无失败')
failures(batch.remaining === 0, '整组处理完无剩余')
failures(getBatchCancelCheckpoint() === null, '完成后断点已清除')
failures(listCancelArchive().length === 2, `归档恰好 2 条（实际 ${listCancelArchive().length}）`)

// 同组再提交：全部跳过、绝不重复
const again = batchCancelDeicing([1, 2, 3], { operator: 'tester', source: 'test-batch' })
failures(again.cancelled === 0 && again.skipped === 3, '重复整组提交全部跳过，无新记录')
failures(listCancelArchive().length === 2, '重复整组提交不新增归档')

// 断点续做：构造处理到第 2 条失败的场景
resetRows('deicing')
// 直接写一个断点：id1 已处理，id2/id3 未处理
const cp = {
  signature: [1, 2, 3].sort((a, b) => a - b).join(','),
  remainingIds: [2, 3],
  results: [
    { id: 1, code: 'DEIC-0001', flight: '', outcome: 'cancelled' as const, message: '已取消' },
  ],
  operator: 'tester',
  source: 'test-batch',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}
localStorage.setItem('airport-ground-handling:deicing-batch-cancel-checkpoint', JSON.stringify(cp))
// 把 id1 在主表置为已取消以模拟断点前状态
const resumed = batchCancelDeicing([1, 2, 3], { operator: 'tester', source: 'test-batch' })
failures(resumed.resumed === true, '同签名再次提交识别为断点续做')
failures(resumed.results.length === 3, `续做累计 3 条结果（实际 ${resumed.results.length}）`)
failures(resumed.results[0].id === 1 && resumed.results[0].outcome === 'cancelled', '断点前结果原样带回不重做')
failures(resumed.remaining === 0, '续做完成无剩余')

// 签名不符不允许续旧断点
resetRows('deicing')
localStorage.setItem('airport-ground-handling:deicing-batch-cancel-checkpoint', JSON.stringify(cp))
const fresh = batchCancelDeicing([1, 2], { operator: 'tester', source: 'test-batch' })
failures(fresh.resumed === false, '不同组（签名不符）不续旧断点，按新批次处理')

// ---------- 污染复查待办：多入口同步 ----------
resetRows('cabin_clean')
// seed: 1=待清洁 2=清洁中 3=已完成
runAction('cabin_clean', 2, '安排复查', { source: '过站监控-客舱清洁清单' })
failures(countOpenPollutionTodos() === 1, '其它入口安排复查同步生成 1 条待办')
const todo = listPollutionTodos('待复查')[0]
failures(todo.source === '过站监控-客舱清洁清单', '待办记录来源入口')
// 复查通过关闭待办
runAction('cabin_clean', 2, '复查通过', { source: '过站监控-客舱清洁清单' })
failures(countOpenPollutionTodos() === 0, '复查通过后待办同步关闭')
failures(listPollutionTodos('已关闭').length === 1, '关闭的待办保留留痕')

// 完成清洁不能跳过开始；需复查不能直接完成清洁
resetRows('cabin_clean')
const bad = runAction('cabin_clean', 1, '完成清洁', { source: 'test' })
failures(bad.ok === false, '待清洁不能直接完成（门禁）')
runAction('cabin_clean', 1, '开始清洁', { source: 'test' })
runAction('cabin_clean', 1, '安排复查', { source: 'test' })
const bad2 = runAction('cabin_clean', 1, '完成清洁', { source: 'test' })
failures(bad2.ok === false, '需复查时不能直接完成清洁，须复查通过')
const pass = runAction('cabin_clean', 1, '复查通过', { source: 'test' })
failures(pass.ok === true, '复查通过回到已完成')

// 归档只追加：没有任何清理入口；reset 主表后归档仍在
resetRows('deicing')
failures(hasCancelArchive(2), '模块重置后取消归档仍保留（不得回写/清除）')

console.log('done')
