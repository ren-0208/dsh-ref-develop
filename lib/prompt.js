/**
 * Builds the "memory digest" that is injected into the system prompt.
 *
 * The digest must stay small: it is paid for on every single step. Details
 * live on disk and are fetched on demand through `growth_recall`, so the
 * prompt only carries the few things that change the next action.
 */
import { oneLine } from './util.js'

const KIND_LABEL = {
  method: '方法',
  lesson: '教训',
  knowledge: '知识',
  wp: '复盘',
  preference: '画像',
  state: '状态',
}

function pick(entries, kind, count) {
  return entries
    .filter((entry) => entry.kind === kind)
    .sort((a, b) => {
      const uses = (b.useCount ?? 0) - (a.useCount ?? 0)
      if (uses !== 0) return uses
      return Date.parse(b.updatedAt ?? 0) - Date.parse(a.updatedAt ?? 0)
    })
    .slice(0, count)
}

function renderSection(label, list, bodyMax) {
  if (!list.length) return []
  return [
    `### ${label}`,
    ...list.map((entry) => `- ${oneLine(entry.title, 110)}：${oneLine(entry.body, bodyMax)}`),
    '',
  ]
}

export function buildDigest({ entries, config, root, cwd }) {
  const budget = config.promptBudgetChars
  const scopeLabel = config.scope === 'workspace' ? '单工作区' : '全局共享'
  const lines = [
    '## 记忆与成长（growth-note）',
    '',
    `当前记忆范围：**${scopeLabel}**；记忆目录：\`${root}\`${cwd ? `；工作区：\`${cwd}\`` : ''}。`,
    '这些条目来自此前会话的沉淀。用得上就直接用；发现与当前事实冲突时以当前事实为准，并修正记忆。',
    '产生可复用结论（方法、教训、领域知识、题目复盘、主人偏好）时，调用 `growth_remember` 写入；',
    '需要查细节时调用 `growth_recall`；切换全局/单工作区记忆或个性化开关用 `growth_config`。',
    '',
  ]

  const blocks = [
    renderSection('可复用方法', pick(entries, 'method', 5), 160),
    renderSection('否决清单（别重复踩）', pick(entries, 'lesson', 5), 160),
    renderSection('领域知识', pick(entries, 'knowledge', 4), 140),
    renderSection('题目复盘', pick(entries, 'wp', 4), 140),
    renderSection('当前状态', pick(entries, 'state', 3), 140),
  ]
  if (config.personalization) blocks.push(renderSection('主人画像（个性化匹配）', pick(entries, 'preference', 4), 140))

  let used = lines.join('\n').length
  for (const block of blocks) {
    if (used >= budget) break
    const text = block.join('\n')
    if (text.trim().length === 0) continue
    const room = budget - used
    lines.push(text.length > room ? `${text.slice(0, Math.max(0, room - 2))}…\n` : text)
    used += Math.min(text.length, room)
  }

  if (entries.length === 0) {
    lines.push('（记忆库当前为空。本次会话结束时会自动沉淀；你也可以随时用 `growth_remember` 主动记录。）', '')
  } else {
    lines.push(`> 记忆库共 ${entries.length} 条，完整目录见 \`${root}/MEMORY/INDEX.md\`。`, '')
  }
  return lines.join('\n')
}

export function describeEntry(entry, index) {
  const label = KIND_LABEL[entry.kind] ?? entry.kind
  const tags = entry.tags?.length ? ` · 标签：${entry.tags.join(', ')}` : ''
  return [
    `${index + 1}. [${label}] ${entry.title}`,
    `   ${oneLine(entry.body, 600)}`,
    `   id=${entry.id}${tags} · 更新于 ${entry.updatedAt ?? entry.createdAt}`,
  ].join('\n')
}
