/**
 * Model-facing tools. All of them read/write the same JSONL store the prompt
 * digest and the settings page use, so a manual write is visible on the very
 * next step (the runtime marks the digest dirty).
 */
import { MEMORY_KINDS, SCOPE_LABEL, isMemoryKind } from './config.js'
import { describeEntry } from './prompt.js'
import { describeQuery, rankEntries } from './recall.js'
import { oneLine, toText, tokenize } from './util.js'

function text(value) {
  return [{ type: 'text', text: toText(value) }]
}

const output = { schema: { type: 'string' }, render: (_args, value) => text(value) }

function parseTags(tags) {
  if (Array.isArray(tags)) return tags.map((tag) => oneLine(tag, 40)).filter(Boolean)
  if (typeof tags === 'string') return tags.split(/[,，;；\s]+/).map((tag) => oneLine(tag, 40)).filter(Boolean)
  return []
}

/** One status line describing the optional semantic layer. */
function describeEmbedding(runtime, config) {
  const embedder = runtime.embeddings?.()
  if (config.embeddingProvider === 'none') return '向量检索：关（仅关键词召回）'
  const state = embedder?.available ? '开' : '未就绪（缺少模型名或密钥）'
  const model = config.embeddingModel ? ` · 模型 ${config.embeddingModel}` : ''
  return `向量检索：${state}${model}`
}

export function createTools({ runtime }) {
  const isOff = () => runtime.getConfig().scope === 'off'
  const OFF_TEXT =
    '记忆已关闭（范围：无）：不写入、不提炼、不注入。需要时先用 growth_config(scope="global") 或 scope="workspace" 重新开启。'
  /** Memory reads/writes only happen where the current config enables them. */
  const INACTIVE_TEXT =
    '记忆未启用：当前范围是「无」，或本会话目录不在所选工作区内。会话保持默认状态，不读取任何记忆。' +
    '需要时可 growth_config(scope="workspace", workspacePaths=[...]) 选入此目录，或切到 global。'
  return [
    {
      name: 'growth_remember',
      description:
        '把一条可复用的记忆写入 growth-note（跨会话生效，下一轮即可被召回）。只在结论确实可复用时写：' +
        'method 方法/命令、lesson 试过且失败的坑、knowledge 读书/新闻/论文结论、wp 题目复盘（CTF/课程/专业题）、' +
        'preference 用户偏好（需开启个性化）、state 项目现状与下一步。',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: MEMORY_KINDS, description: '记忆类型' },
          title: { type: 'string', description: '一句话标题，不超过 40 字' },
          body: { type: 'string', description: '可执行的正文：现象/做法/适用边界/验证方式' },
          tags: { type: 'array', items: { type: 'string' }, description: '检索标签，最多 12 个' },
          confidence: { type: 'number', description: '0–1，默认 0.6；有验证的可以更高' },
          meta: { type: 'object', description: '按类型的结构化字段（subject/topic/platform/trigger/fix 等）' },
        },
        required: ['kind', 'title', 'body'],
      },
      output,
      async execute(args, exec) {
        const kind = isMemoryKind(args?.kind) ? args.kind : 'knowledge'
        const config = runtime.getConfig()
        if (isOff()) return OFF_TEXT
        if (kind === 'preference' && !config.personalization) {
          return `个性化匹配未开启，preference 不会写入（也不会注入）。先用 growth_config(personalization=true) 开启，或改用 method/lesson。`
        }
        const store = await runtime.storeForAgent(exec?.agent)
        if (!store) return INACTIVE_TEXT
        const result = await store.addEntry(
          {
            kind,
            title: args?.title,
            body: args?.body,
            tags: parseTags(args?.tags),
            confidence: args?.confidence,
            meta: args?.meta,
            source: { sessionId: exec?.agent?.id ?? null, cwd: runtime.cwdSync(), title: null },
          },
          { maxEntries: config.maxEntries, dedupeThreshold: config.dedupeThreshold, promoteLessonAfter: config.promoteLessonAfter },
        )
        runtime.markDirty()
        const action = result.merged ? '已合并到同类条目' : '已新增'
        const promoted = result.promoted ? `\n教训累计验证后已自动升级为方法：\`${result.promoted.id}\` ${result.promoted.title}` : ''
        return `${action}：\`${result.entry.id}\` [${result.entry.kind}] ${result.entry.title}${promoted}\n记忆目录：${store.root}`
      },
    },
    {
      name: 'growth_recall',
      description: '按关键词/类型检索记忆条目，返回原文摘要。用于确认细节，避免只凭提示词摘要猜测。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词或问题；留空则按近期强度列出' },
          kind: { type: 'string', enum: MEMORY_KINDS, description: '只看某一类' },
          limit: { type: 'number', description: '返回条数，默认 6，最多 20' },
          include_archived: { type: 'boolean', description: '是否包含已否决/被取代的条目' },
        },
        required: ['query'],
      },
      output,
      async execute(args, exec) {
        const config = runtime.getConfig()
        const store = await runtime.storeForAgent(exec?.agent)
        if (!store) return INACTIVE_TEXT
        const entries = await store.load()
        const limit = Math.min(20, Math.max(1, Number(args?.limit) || 6))
        const tokens = tokenize(args?.query ?? '')
        // Optional semantic pass: only when an embedding provider is configured.
        const embedder = runtime.embeddings?.()
        let queryVector = null
        if (embedder?.available && args?.query) {
          const embedded = await embedder.embed([toText(args.query).slice(0, 2000)])
          queryVector = embedded[0]?.length ? embedded[0] : null
        }
        const pool = entries.filter((entry) => {
          if (!args?.include_archived && entry.status !== 'active') return false
          if (args?.kind && entry.kind !== args.kind) return false
          if (entry.kind === 'preference' && !config.personalization) return false
          return true
        })
        const ranked = rankEntries(pool, {
          tokens,
          halfLifeDays: config.halfLifeDays,
          minConfidence: 0,
          vectors: queryVector ? await store.loadVectors() : null,
          queryVector,
        }).slice(0, limit)
        if (!ranked.length) return `没有匹配「${describeQuery(args?.query)}」的记忆。`
        await store.touchEntry(ranked.map((item) => item.entry.id))
        const semanticNote = queryVector ? ' · 含语义相似度' : ''
        return [
          `匹配 ${ranked.length} 条（查询：${describeQuery(args?.query)}${semanticNote}）：`,
          '',
          ...ranked.map((item, index) => describeEntry(item.entry, index)),
        ].join('\n\n')
      },
    },
    {
      name: 'growth_config',
      description:
        '查看或修改 growth-note 配置：scope（global 全局 / workspace 按工作区 / off 关闭记忆）、workspacePaths（scope=workspace 时启用记忆的工作区列表，可多选；' +
        '会话目录必须在其内才读取记忆）、personalization（个性化匹配）、autoCapture、autoSummarize、consolidateEveryTurns、promptBudgetChars、maxEntries、maxNoteTurns、archiveRetentionDays 等。' +
        '三个范围互相隔离：切换只改变读哪一份库，不会自动迁移；确需搬条目时加 migrate=true。',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['global', 'workspace', 'off'], description: '记忆范围；off=关闭记忆' },
          workspacePaths: {
            type: 'array',
            items: { type: 'string' },
            description: 'scope=workspace 时启用记忆的工作区目录（可多选）；留空则不启用记忆',
          },
          migrate: { type: 'boolean', description: '切换范围时把源库活跃条目复制到目标库（默认不迁移）' },
          personalization: { type: 'boolean', description: '是否启用个性化匹配（用户画像）' },
          autoCapture: { type: 'boolean', description: '是否记录每回合会话笔记' },
          autoSummarize: { type: 'boolean', description: '是否自动提炼记忆' },
          consolidateEveryTurns: { type: 'number', description: '每多少回合提炼一次（1–50）' },
          promptBudgetChars: { type: 'number', description: '注入提示词的字符预算（400–8000）' },
          maxEntries: { type: 'number', description: '最多保留多少条（50–20000）' },
          maxNoteTurns: { type: 'number', description: '每个会话保留多少回合的笔记，更早的轮转丢弃（20–5000）' },
          archiveRetentionDays: { type: 'number', description: '软删除/被取代条目保留天数，超期在下次保存时丢弃（1–3650）' },
          maxArchivedEntries: { type: 'number', description: '同时保留的归档条目上限（0–20000）' },
          halfLifeDays: { type: 'number', description: '记忆强度半衰期天数' },
          minConfidence: { type: 'number', description: '注入提示词的最低置信度' },
          embeddingProvider: {
            type: 'string',
            enum: ['none', 'openai'],
            description: '向量检索的嵌入服务（none=仅关键词召回；openai=任意 OpenAI 兼容 /embeddings 端点）',
          },
          embeddingModel: { type: 'string', description: '嵌入模型名，例如 text-embedding-3-small' },
          embeddingBaseUrl: { type: 'string', description: '嵌入服务基址，留空用 https://api.openai.com/v1' },
          embeddingApiKey: { type: 'string', description: '嵌入服务密钥；也可用环境变量 DSH_GROWTH_EMBEDDING_API_KEY' },
        },
      },
      output,
      async execute(args, exec) {
        const patch = {}
        for (const key of [
          'scope',
          'personalization',
          'autoCapture',
          'autoSummarize',
          'consolidateEveryTurns',
          'promptBudgetChars',
          'maxEntries',
          'maxNoteTurns',
          'archiveRetentionDays',
          'maxArchivedEntries',
          'halfLifeDays',
          'minConfidence',
          'embeddingProvider',
          'embeddingModel',
          'embeddingBaseUrl',
          'embeddingApiKey',
        ]) {
          if (args?.[key] !== undefined) patch[key] = args[key]
        }
        if (args?.workspacePaths !== undefined) patch.workspacePaths = args.workspacePaths
        const before = runtime.getConfig()
        const wantsChange = Object.keys(patch).length > 0 || args?.migrate === true
        const change = wantsChange ? await runtime.setConfig(patch, { agent: exec?.agent, migrate: args?.migrate === true }) : null
        const after = runtime.getConfig()
        const lines = [`范围：${SCOPE_LABEL[after.scope] ?? after.scope}`]
        if (after.scope === 'workspace') {
          lines.push(
            `已选工作区：${after.workspacePaths.length ? after.workspacePaths.join(' · ') : '（未选择，记忆未启用）'}`,
          )
        }
        const store = await runtime.storeForAgent(exec?.agent)
        if (!store) {
          lines.push('本会话未启用记忆：会话保持默认状态，不读取任何记忆。')
        } else {
          const stats = await store.stats()
          lines.push(
            `记忆目录：${stats.root}`,
            `个性化：${after.personalization ? '开' : '关'} · 自动记录：${after.autoCapture ? '开' : '关'} · 自动提炼：${after.autoSummarize ? `每 ${after.consolidateEveryTurns} 回合` : '关'}`,
            `提示词预算：${after.promptBudgetChars} 字 · 上限：${after.maxEntries} 条 · 半衰期：${after.halfLifeDays} 天`,
            `条目：${stats.total}（方法 ${stats.counts.method ?? 0} · 教训 ${stats.counts.lesson ?? 0} · 知识 ${stats.counts.knowledge ?? 0} · 复盘 ${stats.counts.wp ?? 0} · 画像 ${stats.counts.preference ?? 0} · 状态 ${stats.counts.state ?? 0}）· 会话笔记 ${stats.sessions}`,
            describeEmbedding(runtime, after),
          )
        }
        if (before.scope !== after.scope) {
          lines.push(
            after.scope === 'off'
              ? '已关闭记忆：不再记录、提炼、注入；已存内容原样保留，可随时切回。'
              : before.scope === 'off'
                ? '已重新开启记忆。'
                : '已切换记忆范围：global 与 workspace 两份库互相隔离，未自动迁移。',
          )
        }
        if (change?.migration) {
          lines.push(`迁移：新增 ${change.migration.added} 条，合并 ${change.migration.merged} 条，会话笔记 ${change.migration.sessionFiles} 个文件。`)
        }
        return lines.join('\n')
      },
    },
    {
      name: 'growth_status',
      description: '查看 growth-note 的当前范围、配置、条目统计与会话笔记数量。',
      parameters: { type: 'object', properties: {} },
      output,
      async execute(_args, exec) {
        const config = runtime.getConfig()
        const store = await runtime.storeForAgent(exec?.agent)
        const lines = [`范围：${SCOPE_LABEL[config.scope] ?? config.scope}`]
        if (config.scope === 'workspace') {
          lines.push(`已选工作区：${config.workspacePaths?.length ? config.workspacePaths.join(' · ') : '（未选择，记忆未启用）'}`)
        }
        if (!store) {
          lines.push('本会话未启用记忆：会话保持默认状态，不读取任何记忆。')
          return lines.join('\n')
        }
        const stats = await store.stats()
        lines.push(
          `记忆目录：${stats.root}`,
          `条目：共 ${stats.total} 条（归档 ${stats.archived}）`,
          `分类型：方法 ${stats.counts.method ?? 0} · 教训 ${stats.counts.lesson ?? 0} · 知识 ${stats.counts.knowledge ?? 0} · 复盘 ${stats.counts.wp ?? 0} · 画像 ${stats.counts.preference ?? 0} · 状态 ${stats.counts.state ?? 0}`,
          `会话笔记：${stats.sessions} 个 · 个性化：${config.personalization ? '开' : '关'} · 自动提炼：${config.autoSummarize ? `每 ${config.consolidateEveryTurns} 回合` : '关'}`,
          describeEmbedding(runtime, config),
        )
        return lines.join('\n')
      },
    },
    {
      name: 'growth_forget',
      description: '软删除一条记忆（默认标记 rejected，保留证据与审计；hard=true 才真删）。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '条目 id（growth_recall/status 里有）' },
          hard: { type: 'boolean', description: '是否物理删除' },
        },
        required: ['id'],
      },
      output,
      async execute(args, exec) {
        if (isOff()) return OFF_TEXT
        const store = await runtime.storeForAgent(exec?.agent)
        if (!store) return INACTIVE_TEXT
        const removed = await store.removeEntry(String(args?.id ?? ''), { soft: args?.hard !== true })
        runtime.markDirty()
        if (!removed) return `没有找到条目 \`${args?.id}\`。`
        return `${args?.hard ? '已删除' : '已标记 rejected'}：\`${removed.id}\` ${removed.title}`
      },
    },
    {
      name: 'growth_edit',
      description: '修改一条记忆的标题/正文/标签/置信度/状态。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          body: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'number' },
          status: { type: 'string', enum: ['active', 'superseded', 'rejected'] },
        },
        required: ['id'],
      },
      output,
      async execute(args, exec) {
        if (isOff()) return OFF_TEXT
        const store = await runtime.storeForAgent(exec?.agent)
        if (!store) return INACTIVE_TEXT
        const updated = await store.updateEntry(String(args?.id ?? ''), args ?? {})
        runtime.markDirty()
        return updated ? `已更新：\`${updated.id}\` ${updated.title}` : `没有找到条目 \`${args?.id}\`。`
      },
    },
    {
      name: 'growth_export',
      description: '导出当前范围的记忆（markdown 便于阅读，json 便于备份）。',
      parameters: {
        type: 'object',
        properties: { format: { type: 'string', enum: ['markdown', 'json'], description: '默认 markdown' } },
      },
      output,
      async execute(args, exec) {
        const store = await runtime.storeForAgent(exec?.agent)
        if (!store) return INACTIVE_TEXT
        if (args?.format === 'json') return JSON.stringify(await store.exportJson(), null, 2)
        const md = await store.exportMarkdown()
        return md.length > 12000 ? `${md.slice(0, 12000)}\n…（已截断，完整内容见 ${store.root}）` : md
      },
    },
  ]
}
