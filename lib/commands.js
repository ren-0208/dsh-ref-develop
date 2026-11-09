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
  '  status                       查看范围、启用状态、条目统计',
  '  remember <kind> <标题> :: <正文>   写入一条记忆',
  '  recall <关键词>              检索',
  '  scope global|workspace|off   切换记忆范围（off=关闭记忆，不迁移不删除）',
  '  workspace <路径1>,<路径2>|clear|list  选择启用记忆的工作区（可多选）',
  '  config key=value ...         改配置',
  '  export                       导出 markdown',
  '  consolidate                  立即用模型总结本会话',
  '  reindex                      用嵌入模型重建向量索引',
  '  forget <id>                  软删除一条',
].join('\n')

const INACTIVE = '记忆未启用：当前范围是「无」，或本会话目录不在所选工作区内。会话保持默认状态，不读取记忆。'

function parseRemember(rest) {
  const match = /^(\S+)\s+([\s\S]+?)\s*::\s*([\s\S]+)$/.exec(rest)
  if (!match) return null
  return { kind: match[1], title: match[2], body: match[3] }
}

function parsePaths(rest) {
  return String(rest ?? '')
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

export function createCommand(runtime) {
  return {
    name: 'growth',
    description: '记忆与成长：查看/切换记忆范围、选择工作区、写入、检索、导出',
    input: {
      hint: 'status | remember method 标题 :: 正文 | recall 关键词 | scope global|workspace|off | workspace <路径,…>|clear|list | config key=value | export | consolidate | reindex',
    },
    async handler({ agent, rawInput }) {
      const input = String(rawInput ?? '').trim()
      if (!input || input === 'help') return { kind: 'success', text: USAGE }
      const [head, ...restParts] = input.split(/\s+/)
      const rest = restParts.join(' ')
      try {
        const store = await runtime.storeForAgent(agent)

        if (head === 'status') {
          const config = runtime.getConfig()
          const lines = [`范围：${SCOPE_LABEL[config.scope] ?? config.scope}`]
          if (config.scope === 'workspace') {
            lines.push(
              `启用的工作区：${config.workspacePaths.length ? config.workspacePaths.join(' · ') : '（未选择，记忆未启用）'}`,
            )
          }
          if (!store) {
            lines.push(INACTIVE)
            return { kind: 'success', text: lines.join('\n') }
          }
          const stats = await store.stats()
          const embedder = runtime.embeddings?.()
          const vectors = await store.vectorStats().catch(() => null)
          lines.push(
            `目录：${stats.root}`,
            `条目 ${stats.total}（归档 ${stats.archived}）· 会话笔记 ${stats.sessions}`,
            `方法 ${stats.counts.method ?? 0} · 教训 ${stats.counts.lesson ?? 0} · 知识 ${stats.counts.knowledge ?? 0} · 复盘 ${stats.counts.wp ?? 0} · 画像 ${stats.counts.preference ?? 0} · 状态 ${stats.counts.state ?? 0}`,
            `向量检索：${config.embeddingProvider === 'none' ? '关（仅关键词）' : embedder?.available ? `开（${config.embeddingModel}）· 已索引 ${vectors?.covered ?? 0}/${vectors?.active ?? 0}` : '未就绪（缺模型名或密钥）'}`,
          )
          return { kind: 'success', text: lines.join('\n') }
        }
        if (head === 'remember') {
          if (runtime.getConfig().scope === 'off') return { kind: 'error', text: '记忆已关闭：先 /growth scope global 或 workspace 再写入。' }
          if (!store) return { kind: 'error', text: INACTIVE }
          const parsed = parseRemember(rest)
          if (!parsed) return { kind: 'error', text: `格式不对。示例：/growth remember method 先读 INDEX 再动手 :: 打开工作区先看 MEMORY/INDEX.md…` }
          if (!isMemoryKind(parsed.kind)) return { kind: 'error', text: `kind 只能是 ${MEMORY_KINDS.join(' / ')}` }
          const config = runtime.getConfig()
          if (parsed.kind === 'preference' && !config.personalization) return { kind: 'error', text: '个性化匹配未开启：先 /growth config personalization=true，或改写入 method/lesson。' }
          const result = await store.addEntry(
            { kind: parsed.kind, title: parsed.title, body: parsed.body, source: { sessionId: agent?.id ?? null, cwd: runtime.cwdSync() } },
            { maxEntries: config.maxEntries, dedupeThreshold: config.dedupeThreshold, promoteLessonAfter: config.promoteLessonAfter },
          )
          runtime.markDirty()
          return { kind: 'success', text: `${result.merged ? '已合并' : '已写入'}：\`${result.entry.id}\` [${result.entry.kind}] ${result.entry.title}` }
        }
        if (head === 'recall') {
          if (!rest.trim()) return { kind: 'error', text: '要检索什么？示例：/growth recall cordis 注入' }
          if (!store) return { kind: 'error', text: INACTIVE }
          const config = runtime.getConfig()
          const list = (await store.load()).filter((entry) => entry.status === 'active')
          const embedder = runtime.embeddings?.()
          let queryVector = null
          if (embedder?.available) {
            const embedded = await embedder.embed([oneLine(rest, 2000)])
            queryVector = embedded[0]?.length ? embedded[0] : null
          }
          const ranked = rankEntries(list, {
            tokens: tokenize(rest),
            halfLifeDays: config.halfLifeDays,
            minConfidence: 0,
            vectors: queryVector ? await store.loadVectors() : null,
            queryVector,
          }).slice(0, 6)
          if (!ranked.length) return { kind: 'success', text: `没有匹配「${oneLine(rest, 60)}」的记忆。` }
          return { kind: 'success', text: ranked.map((item, index) => describeEntry(item.entry, index)).join('\n\n') }
        }
        if (head === 'scope') {
          const scope = rest.trim()
          if (scope !== 'global' && scope !== 'workspace' && scope !== 'off') return { kind: 'error', text: '用法：/growth scope global|workspace|off' }
          await runtime.setConfig({ scope }, { agent })
          const config = runtime.getConfig()
          if (scope === 'off') return { kind: 'success', text: '已关闭记忆：不再记录、提炼、注入；已存内容原样保留，可随时切回。' }
          if (scope === 'workspace' && !config.workspacePaths.length) {
            return { kind: 'success', text: '已切到单工作区记忆，但还没选工作区：记忆暂不启用。用 /growth workspace <路径,…> 选择。' }
          }
          return { kind: 'success', text: `已切到 ${SCOPE_LABEL[config.scope]}。global 与 workspace 两份库互相隔离，不会自动迁移。` }
        }
        if (head === 'workspace') {
          const value = rest.trim()
          const config = runtime.getConfig()
          if (!value || value === 'list') {
            return {
              kind: 'success',
              text: `当前范围：${SCOPE_LABEL[config.scope] ?? config.scope}\n启用的工作区：${config.workspacePaths.length ? config.workspacePaths.join('\n  ') : '（未选择，记忆未启用）'}`,
            }
          }
          const paths = value === 'clear' ? [] : parsePaths(value)
          await runtime.setConfig({ scope: 'workspace', workspacePaths: paths }, { agent })
          return {
            kind: 'success',
            text: paths.length
              ? `已启用 ${paths.length} 个工作区：\n  ${paths.join('\n  ')}\n只有会话目录位于这些工作区内时才读取记忆，各工作区与全局完全隔离。`
              : '已清空工作区选择：记忆未启用，会话保持默认状态。',
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
          if (!store) return { kind: 'error', text: INACTIVE }
          const md = await store.exportMarkdown()
          return { kind: 'success', text: md.length > 8000 ? `${md.slice(0, 8000)}\n…（截断，完整内容在 ${store.root}）` : md }
        }
        if (head === 'consolidate') {
          if (runtime.getConfig().scope === 'off') return { kind: 'error', text: '记忆已关闭：先 /growth scope global 或 workspace 再总结。' }
          if (!agent) return { kind: 'error', text: '没有活动会话。' }
          if (!store) return { kind: 'error', text: INACTIVE }
          const turn = runtime.currentTurn(agent)
          // Scoped read: the whole session is not needed to summarise this turn.
          const events = await runtime.readTurnEvents(agent, turn)
          const result = await runtime.consolidator.run({ agent, turn, events, force: true })
          if (result.reason === 'no-model') return { kind: 'error', text: '没有可用的默认模型（agentDefaultModel 未就绪），本次只写了会话笔记。' }
          return { kind: 'success', text: `总结完成：新增 ${result.stored ?? 0} 条，合并 ${result.merged ?? 0} 条，升级 ${result.promoted ?? 0} 条（候选 ${result.candidates ?? 0}）。` }
        }
        if (head === 'reindex') {
          if (!store) return { kind: 'error', text: INACTIVE }
          const embedder = runtime.embeddings?.()
          if (!embedder?.available) return { kind: 'error', text: '向量检索未启用：先 /growth config embeddingProvider=openai embeddingModel=<模型> embeddingApiKey=<密钥>。' }
          const result = await runtime.reindexVectors(store)
          if (!result?.ok) return { kind: 'error', text: `重建失败：${result?.error ?? '未知原因'}` }
          const vectors = await store.vectorStats()
          return { kind: 'success', text: `向量索引已重建：本次嵌入 ${result.embedded ?? 0} 条，覆盖 ${vectors.covered}/${vectors.active} 条活跃记忆。` }
        }
        if (head === 'forget') {
          const id = rest.trim()
          if (!id) return { kind: 'error', text: '用法：/growth forget <id>' }
          if (!store) return { kind: 'error', text: INACTIVE }
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
