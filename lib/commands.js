/**
 * `/growth` human command: the quick path to everything the tools can do,
 * typed directly in the composer. Works in every session and every workspace.
 */
import { MEMORY_KINDS, SCOPE_LABEL, isMemoryKind } from './config.js'
import { describeEntry } from './prompt.js'
import { rankEntries } from './recall.js'
import { oneLine, tokenize } from './util.js'

const USAGE = [
  '用法：/growth <子命令>',
  '  status                       查看范围、条目统计',
  '  remember <kind> <标题> :: <正文>   写入一条记忆',
  '  recall <关键词>              检索',
  '  scope global|workspace|off   切换记忆范围（off=关闭记忆，不迁移不删除）',
  '  config key=value ...         改配置',
  '  export                       导出 markdown',
  '  consolidate                  立即用模型总结本会话',
  '  forget <id>                  软删除一条',
].join('\n')

function parseRemember(rest) {
  const match = /^(\S+)\s+([\s\S]+?)\s*::\s*([\s\S]+)$/.exec(rest)
  if (!match) return null
  return { kind: match[1], title: match[2], body: match[3] }
}

export function createCommand(runtime) {
  return {
    name: 'growth',
    description: '记忆与成长：查看/切换记忆范围、写入、检索、导出',
    input: {
      hint: 'status | remember method 标题 :: 正文 | recall 关键词 | scope global|workspace|off | config key=value | export | consolidate',
    },
    async handler({ agent, rawInput }) {
      const input = String(rawInput ?? '').trim()
      if (!input || input === 'help') return { kind: 'success', text: USAGE }
      const [head, ...restParts] = input.split(/\s+/)
      const rest = restParts.join(' ')
      try {
        if (head === 'status') {
          const config = runtime.getConfig()
          const store = await runtime.storeForAgent(agent)
          const stats = await store.stats()
          const lines = [
            `范围：${SCOPE_LABEL[config.scope]} · 目录：${stats.root}`,
            `条目 ${stats.total}（归档 ${stats.archived}）· 会话笔记 ${stats.sessions}`,
            `方法 ${stats.counts.method ?? 0} · 教训 ${stats.counts.lesson ?? 0} · 知识 ${stats.counts.knowledge ?? 0} · 复盘 ${stats.counts.wp ?? 0} · 画像 ${stats.counts.preference ?? 0} · 状态 ${stats.counts.state ?? 0}`,
          ]
          if (config.scope === 'off') lines.push('记忆已关闭：不记录、不提炼、不注入；切回 global/workspace 后恢复。')
          return { kind: 'success', text: lines.join('\n') }
        }
        if (head === 'remember') {
          if (runtime.getConfig().scope === 'off') return { kind: 'error', text: '记忆已关闭：先 /growth scope global 或 workspace 再写入。' }
          const parsed = parseRemember(rest)
          if (!parsed) return { kind: 'error', text: `格式不对。示例：/growth remember method 先读 INDEX 再动手 :: 打开工作区先看 MEMORY/INDEX.md…` }
          if (!isMemoryKind(parsed.kind)) return { kind: 'error', text: `kind 只能是 ${MEMORY_KINDS.join(' / ')}` }
          const config = runtime.getConfig()
          if (parsed.kind === 'preference' && !config.personalization) return { kind: 'error', text: '个性化匹配未开启：先 /growth config personalization=true，或改写入 method/lesson。' }
          const store = await runtime.storeForAgent(agent)
          const result = await store.addEntry(
            { kind: parsed.kind, title: parsed.title, body: parsed.body, source: { sessionId: agent?.id ?? null, cwd: runtime.cwdSync() } },
            { maxEntries: config.maxEntries, dedupeThreshold: config.dedupeThreshold, promoteLessonAfter: config.promoteLessonAfter },
          )
          runtime.markDirty()
          return { kind: 'success', text: `${result.merged ? '已合并' : '已写入'}：\`${result.entry.id}\` [${result.entry.kind}] ${result.entry.title}` }
        }
        if (head === 'recall') {
          if (!rest.trim()) return { kind: 'error', text: '要检索什么？示例：/growth recall cordis 注入' }
          const config = runtime.getConfig()
          const store = await runtime.storeForAgent(agent)
          const list = (await store.load()).filter((entry) => entry.status === 'active')
          const ranked = rankEntries(list, { tokens: tokenize(rest), halfLifeDays: config.halfLifeDays, minConfidence: 0 }).slice(0, 6)
          if (!ranked.length) return { kind: 'success', text: `没有匹配「${oneLine(rest, 60)}」的记忆。` }
          return { kind: 'success', text: ranked.map((item, index) => describeEntry(item.entry, index)).join('\n\n') }
        }
        if (head === 'scope') {
          const scope = rest.trim()
          if (scope !== 'global' && scope !== 'workspace' && scope !== 'off') return { kind: 'error', text: '用法：/growth scope global|workspace|off' }
          const change = await runtime.setConfig({ scope }, { agent })
          const migration = change?.migration
          const label = SCOPE_LABEL[runtime.getConfig().scope]
          if (scope === 'off') return { kind: 'success', text: `已关闭记忆（${label}）：不再记录、提炼、注入；已存内容保留。` }
          return {
            kind: 'success',
            text: `已切到 ${label}。${migration ? `迁移：新增 ${migration.added}，合并 ${migration.merged}，会话笔记 ${migration.sessionFiles}。` : ''}`,
          }
        }
        if (head === 'config') {
          const patch = {}
          for (const token of rest.split(/\s+/).filter(Boolean)) {
            const [key, ...valueParts] = token.split('=')
            if (!valueParts.length) continue
            const value = valueParts.join('=')
            patch[key] = value === 'true' ? true : value === 'false' ? false : isNaN(Number(value)) ? value : Number(value)
          }
          if (!Object.keys(patch).length) return { kind: 'error', text: '示例：/growth config personalization=true consolidateEveryTurns=4' }
          await runtime.setConfig(patch, { agent })
          const config = runtime.getConfig()
          return { kind: 'success', text: `已更新：范围 ${config.scope} · 个性化 ${config.personalization ? '开' : '关'} · 自动提炼 ${config.autoSummarize ? `每 ${config.consolidateEveryTurns} 回合` : '关'} · 预算 ${config.promptBudgetChars}` }
        }
        if (head === 'export') {
          const store = await runtime.storeForAgent(agent)
          const md = await store.exportMarkdown()
          return { kind: 'success', text: md.length > 8000 ? `${md.slice(0, 8000)}\n…（截断，完整内容在 ${store.root}）` : md }
        }
        if (head === 'consolidate') {
          if (runtime.getConfig().scope === 'off') return { kind: 'error', text: '记忆已关闭：先 /growth scope global 或 workspace 再总结。' }
          if (!agent) return { kind: 'error', text: '没有活动会话。' }
          const result = await runtime.consolidator.run({ agent, turn: runtime.currentTurn(agent), events: await runtime.readTurnEvents(agent, undefined), force: true })
          if (result.reason === 'no-model') return { kind: 'error', text: '没有可用的默认模型（agentDefaultModel 未就绪），本次只写了会话笔记。' }
          return { kind: 'success', text: `总结完成：新增 ${result.stored ?? 0} 条，合并 ${result.merged ?? 0} 条，升级 ${result.promoted ?? 0} 条（候选 ${result.candidates ?? 0}）。` }
        }
        if (head === 'forget') {
          const id = rest.trim()
          if (!id) return { kind: 'error', text: '用法：/growth forget <id>' }
          const store = await runtime.storeForAgent(agent)
          const removed = await store.removeEntry(id, { soft: true })
          runtime.markDirty()
          return removed ? { kind: 'success', text: `已标记 rejected：${removed.title}` } : { kind: 'error', text: `没有找到 ${id}` }
        }
        return { kind: 'error', text: `未知子命令 ${head}\n\n${USAGE}` }
      } catch (error) {
        return { kind: 'error', text: `growth 命令失败：${String(error?.message ?? error)}` }
      }
    },
  }
}
