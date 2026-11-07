/**
 * Model-facing tools. They are the only way the assistant can read or change
 * memory, so every one of them stays small and side-effect explicit.
 */
import { MEMORY_KINDS, MUTABLE_KEYS } from './config.js'
import { describeEntry } from './prompt.js'
import { oneLine, scoreEntry, tokenize } from './util.js'

const KIND_DESCRIPTION =
  '条目类型：method=可复用方法/套路；lesson=教训与失败原因（否决清单）；knowledge=领域知识（读书/新闻/论文/课程）；wp=题目复盘（CTF、课程题、专业题等任何解题经验）；preference=主人偏好画像；state=项目状态与下一步'

function textOutput(text) {
  return {
    schema: { type: 'string' },
    render(_args, value) {
      return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
    },
  }
}

function asArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item))
  if (typeof value === 'string' && value.trim()) return value.split(/[,，;；]/).map((item) => item.trim())
  return []
}

/**
 * @param {object} deps
 * @param {object} deps.runtime  shared state created in index.js
 */
export function createTools({ runtime }) {
  const remember = {
    name: 'growth_remember',
    description:
      '把一条值得跨会话复用的结论写入「记忆与成长」库。适合：解决问题后总结的方法、踩过的坑、读书/新闻/论文得到的领域知识、任何学科题目的复盘经验、以及主人稳定的偏好。' +
      '写入前先用 growth_recall 查一下是否已有同类条目，避免重复；标题要短、要能一眼检索到，正文写清「什么场景 → 怎么做/为什么」。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: MEMORY_KINDS, description: KIND_DESCRIPTION },
        title: { type: 'string', description: '短标题，8~40 字，用于后续检索' },
        body: { type: 'string', description: '正文：适用场景、结论、关键步骤或失败原因；可含命令/链接' },
        tags: { type: 'array', items: { type: 'string' }, description: '可选标签，如 ctf、crypto、pytorch、写作风格' },
        source: { type: 'string', description: '可选出处：书名/URL/题目名/会话日期' },
      },
      required: ['kind', 'title', 'body'],
    },
    output: textOutput(),
    async execute(args, exec) {
      const store = await runtime.storeFor(exec)
      const config = runtime.getConfig()
      const { entry, merged } = await store.addEntry(
        { kind: args.kind, title: args.title, body: args.body, tags: asArray(args.tags), source: args.source },
        { maxEntries: config.maxEntries },
      )
      runtime.markDirty?.()
      return `${merged ? '已合并到既有条目' : '已写入'}：[${entry.kind}] ${entry.title}\nid=${entry.id}\n记忆目录=${store.root}`
    },
  }

  const recall = {
    name: 'growth_recall',
    description:
      '按关键词检索「记忆与成长」库，返回最相关的条目。会话开始时的摘要只含少量条目，需要具体细节（命令、失败原因、某道题的解法、主人偏好）时用它。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，可中英文混排' },
        kind: { type: 'string', enum: MEMORY_KINDS, description: '只看某一类（可选）' },
        limit: { type: 'number', description: '返回条数，默认 6，最大 20' },
      },
      required: ['query'],
    },
    output: textOutput(),
    async execute(args, exec) {
      const store = await runtime.storeFor(exec)
      const config = runtime.getConfig()
      const tokens = tokenize(args.query ?? '')
      const limit = Math.min(20, Math.max(1, Number(args.limit) || 6))
      let entries = await store.entries()
      if (args.kind) entries = entries.filter((entry) => entry.kind === args.kind)
      const scored = entries
        .map((entry) => ({ entry, score: scoreEntry(entry, tokens) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
      if (!scored.length) return `没有命中「${args.query}」的条目（记忆库共 ${entries.length} 条）。`
      await store.touchEntry(scored.map((item) => item.entry.id))
      const header = `命中 ${scored.length} 条（记忆目录：${store.root}，范围：${config.scope}）\n`
      return header + scored.map((item, index) => describeEntry(item.entry, index)).join('\n')
    },
  }

  const configTool = {
    name: 'growth_config',
    description:
      '查看或修改「记忆与成长」的开关。scope=global 表示所有工作区共享同一份成长记忆；scope=workspace 表示每个工作区各自一份。personalization 控制是否使用「主人画像」（聊天中习得的个性化偏好）。修改立即生效并持久化。',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['global', 'workspace'], description: '记忆范围：全局共享 / 单工作区' },
        personalization: { type: 'boolean', description: '是否启用个性化匹配（主人画像）' },
        autoCapture: { type: 'boolean', description: '是否在回合结束时自动记录会话笔记' },
        autoSummarize: { type: 'boolean', description: '是否用模型把会话笔记提炼成条目' },
        consolidateEveryTurns: { type: 'number', description: '每隔多少个回合做一次提炼，默认 6' },
        promptBudgetChars: { type: 'number', description: '注入系统提示词的记忆摘要字数上限，默认 1800' },
        maxEntries: { type: 'number', description: '记忆条目上限，默认 3000' },
      },
    },
    output: textOutput(),
    async execute(args) {
      const patch = {}
      for (const key of MUTABLE_KEYS) {
        if (args[key] !== undefined) patch[key] = args[key]
      }
      const next = Object.keys(patch).length ? await runtime.setConfig(patch) : runtime.getConfig()
      const store = await runtime.storeFor()
      return [
        '当前设置：',
        `- scope=${next.scope}（${next.scope === 'global' ? '所有工作区共享' : '单工作区独立'}）`,
        `- personalization=${next.personalization}`,
        `- autoCapture=${next.autoCapture} · autoSummarize=${next.autoSummarize} · 每 ${next.consolidateEveryTurns} 回合提炼`,
        `- promptBudgetChars=${next.promptBudgetChars} · maxEntries=${next.maxEntries}`,
        `- 设置文件：${runtime.settingsPath()}`,
        `- 本工作区记忆目录：${store.root}`,
      ].join('\n')
    },
  }

  const status = {
    name: 'growth_status',
    description: '查看「记忆与成长」的当前状态：范围、目录、条目统计、最近更新的条目、会话笔记数量。',
    parameters: { type: 'object', properties: {} },
    output: textOutput(),
    async execute(_args, exec) {
      const store = await runtime.storeFor(exec)
      const config = runtime.getConfig()
      const entries = await store.entries()
      const counts = {}
      for (const entry of entries) counts[entry.kind] = (counts[entry.kind] ?? 0) + 1
      const recent = [...entries]
        .sort((a, b) => Date.parse(b.updatedAt ?? 0) - Date.parse(a.updatedAt ?? 0))
        .slice(0, 8)
      const notes = await store.sessionCount()
      return [
        `范围：${config.scope}（${config.scope === 'global' ? '全局共享' : '单工作区'}）· 个性化：${config.personalization ? '开' : '关'}`,
        `记忆目录：${store.root}`,
        `条目：共 ${entries.length} 条 — 方法 ${counts.method ?? 0} / 教训 ${counts.lesson ?? 0} / 知识 ${counts.knowledge ?? 0} / 复盘 ${counts.wp ?? 0} / 画像 ${counts.preference ?? 0} / 状态 ${counts.state ?? 0}`,
        `会话笔记：${notes} 个会话`,
        '',
        '最近更新：',
        ...(recent.length ? recent.map((entry, index) => `- [${entry.kind}] ${oneLine(entry.title, 80)}（${entry.updatedAt ?? entry.createdAt}）`) : ['- （空）']),
      ].join('\n')
    },
  }

  const forget = {
    name: 'growth_forget',
    description: '删除一条过期或错误的记忆条目（用 growth_recall 或 growth_status 拿到 id）。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '条目 id，形如 mg-xxxx-xxxxxxxx' } },
      required: ['id'],
    },
    output: textOutput(),
    async execute(args, exec) {
      const store = await runtime.storeFor(exec)
      const removed = await store.removeEntry(String(args.id).trim())
      runtime.markDirty?.()
      return removed ? `已删除条目 ${removed.id}：${removed.title}` : `没有找到 id=${args.id} 的条目。`
    },
  }

  return [remember, recall, configTool, status, forget]
}
