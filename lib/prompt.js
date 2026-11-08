/**
 * Prompt rendering for growth-note.
 *
 * Two consumers:
 *   buildDigest      the block injected into the system prompt for one agent
 *   describeEntry    the text used by growth_recall / the settings page
 *
 * The digest is budgeted by `promptBudgetChars`. When the budget is tight we
 * drop whole entries first (lowest-ranked kinds last), then trim bodies, and
 * finally shorten the header — never truncate mid-entry.
 */
import { KIND_LABEL, describeMeta } from './entry.js'
import { KIND_ORDER } from './recall.js'
import { SCOPE_LABEL } from './config.js'
import { oneLine } from './util.js'

const MAX_LINE = 220

function renderEntry(entry, index) {
  const meta = describeMeta(entry)
  const confidence = Math.round((entry.confidence ?? 0.6) * 100)
  const tags = entry.tags?.length ? ` · ${entry.tags.slice(0, 4).map((tag) => `#${tag}`).join(' ')}` : ''
  const body = oneLine(entry.body, MAX_LINE)
  const head = `${index + 1}. **${oneLine(entry.title, 110)}**${meta ? ` ${meta}` : ''}${tags} · 置信${confidence}%`
  return body ? `${head}\n   ${body}` : head
}

export function describeEntry(entry, index, { withBody = true } = {}) {
  const meta = describeMeta(entry)
  const head = `${index === undefined ? '' : `${index + 1}. `}[${KIND_LABEL[entry.kind] ?? entry.kind}] **${oneLine(entry.title, 140)}**${meta ? ` ${meta}` : ''} · 置信 ${Math.round((entry.confidence ?? 0.6) * 100)}% · 用 ${entry.useCount ?? 0} 次 · \`${entry.id}\``
  if (!withBody) return head
  const body = String(entry.body ?? '').trim()
  if (!body) return head
  return `${head}\n${body.length > 600 ? `${body.slice(0, 600)}…` : body}`
}

/**
 * @param {object} input
 * @param {Record<string, object[]>} input.groups  entries per kind, already selected
 * @param {object} input.config                     normalized config
 * @param {string} input.root                       memory root on disk
 * @param {string} [input.cwd]
 * @param {string} [input.queryText]                the user message this digest answers
 * @param {number} [input.matched]                  how many entries matched lexically
 */
/** Digest used while the user has switched memory off: injected, but says nothing about stored content. */
export function buildOffDigest() {
  return [
    '## 记忆与成长（dsh-ref-develop）',
    `范围：${SCOPE_LABEL.off}`,
    '记忆已关闭：本会话不注入记忆内容、不记录会话笔记、不提炼新条目。',
    '需要恢复时在「设置 → 记忆与成长」把范围切回「全局记忆」或「单工作区记忆」即可；已存内容保持原样。',
  ].join('\n')
}

export function buildDigest({ groups, config, root, cwd, queryText = '', matched = 0 }) {
  if (config?.scope === 'off') return buildOffDigest()
  const budget = Math.max(400, config?.promptBudgetChars ?? 1800)
  const scope = SCOPE_LABEL[config?.scope ?? 'global'] ?? config?.scope ?? 'global'
  const total = KIND_ORDER.reduce((sum, kind) => sum + (groups?.[kind]?.length ?? 0), 0)
  if (total === 0) {
    const empty = [
      '## 记忆与成长（dsh-ref-develop）',
      `范围：${scope} · 记忆目录：${root}`,
      '还没有可用记忆。当用户给出可复用的结论时可以调用 `growth_remember` 写入；不必为了填充而写。',
    ]
    if (queryText) empty.push(`本轮问题：${oneLine(queryText, 60)}`)
    return empty.join('\n')
  }

  const header = [
    '## 记忆与成长（dsh-ref-develop）',
    `范围：${scope} · 记忆目录：\`${root}\``,
    `用法：下面只是摘要（共 ${total} 条${matched ? `，本轮命中 ${matched} 条` : ''}）；需要原文时调用 \`growth_recall(query)\`。没有证据支持的内容不要当成事实。`,
  ]
  if (queryText) header.push(`本轮问题：${oneLine(queryText, 60)}`)

  const lines = [...header, '']
  let used = lines.join('\n').length

  for (const kind of KIND_ORDER) {
    const entries = groups?.[kind] ?? []
    if (!entries.length) continue
    const title = `### ${KIND_LABEL[kind] ?? kind}（${entries.length}）`
    if (used + title.length + 1 > budget) break
    lines.push(title)
    used += title.length + 1
    for (let index = 0; index < entries.length; index += 1) {
      const rendered = renderEntry(entries[index], index)
      if (used + rendered.length + 1 > budget) {
        lines.push('…（预算已满，更多条目请用 growth_recall）')
        used = budget
        break
      }
      lines.push(rendered)
      used += rendered.length + 1
    }
    if (used >= budget) break
    lines.push('')
  }

  return lines.join('\n').trim()
}

export const PROMPT_SECTION_NAME = 'GROWTH_NOTE'
export { KIND_LABEL }
