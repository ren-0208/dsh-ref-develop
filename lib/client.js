/**
 * 「记忆与成长」— client half (package `dsh-ref-develop`): the section inside Settings.
 *
 * The section talks to the host through the plugin's own same-origin routes
 * (`/growth-note/api/*`), because the Web client exposes no generic host RPC.
 * Everything it changes is persisted by the host before the response returns.
 */
window.__ModuleLoader__.load({
  id: '@ren-0208/dsh-ref-develop',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { createElement: h, useCallback, useEffect, useMemo, useState } = React

    const API = '/growth-note/api'
    const NS = 'dsh-ref-develop'
    const STYLE_ID = 'dsh-ref-develop/section.css'
    const KIND_LABEL = { method: '方法', lesson: '教训', knowledge: '知识', wp: '复盘', preference: '画像', state: '状态' }
    const KIND_ORDER = ['method', 'lesson', 'knowledge', 'wp', 'preference', 'state']

    const CSS = [
      '.gn{max-width:820px;display:flex;flex-direction:column;gap:10px;color:var(--dsw-alias-label-primary)}',
      '.gn h3{margin:0;font-size:16px;font-weight:500;line-height:24px}',
      '.gn .gn-intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}',
      '.gn-group{margin-top:12px;font-size:13px;font-weight:600;line-height:20px}',
      '.gn-row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px 20px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}',
      '.gn-row:last-child{border-bottom:none}',
      '.gn-row>div:first-child{flex:1;min-width:200px}',
      '.gn-label{font-size:13px;line-height:19px}',
      '.gn-hint{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary);margin-top:3px}',
      '.gn-input,.gn-select,.gn-num{background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:12.5px;height:28px;padding:0 8px;min-width:200px;outline:none}',
      '.gn-num{min-width:90px;width:110px}',
      '.gn-input:focus-visible,.gn-select:focus-visible,.gn-num:focus-visible{border-color:var(--dsw-alias-brand-primary)}',
      '.gn-textarea{width:100%;min-height:72px;background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:12.5px;padding:6px 8px;outline:none;resize:vertical}',
      '.gn-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.gn-btn{height:30px;padding:0 14px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;cursor:pointer}',
      '.gn-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.gn-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground,#fff)}',
      '.gn-btn-danger{color:#e5484d;border-color:rgba(229,72,77,.4)}',
      '.gn-err{color:#e5484d;font-size:12.5px;line-height:18px}',
      '.gn-ok{color:#0d9458;font-size:12.5px;line-height:18px}',
      '.gn-list{display:flex;flex-direction:column;gap:6px;margin-top:8px;max-height:420px;overflow:auto}',
      '.gn-item{padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}',
      '.gn-item-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.gn-badge{font-size:11px;line-height:16px;padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}',
      '.gn-title{font-size:13px;font-weight:500}',
      '.gn-body{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);margin-top:4px;white-space:pre-wrap;word-break:break-word}',
      '.gn-meta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);margin-left:auto}',
      '.gn-form{display:flex;flex-direction:column;gap:6px;margin-top:8px;padding:10px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px}',
      '.gn-form-row{display:flex;gap:8px;flex-wrap:wrap}',
    ].join('')

    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    async function api(path, options) {
      const response = await fetch(`${API}${path}`, {
        headers: { accept: 'application/json', ...(options?.body ? { 'content-type': 'application/json' } : {}) },
        ...options,
      })
      const text = await response.text()
      let data = null
      try {
        data = JSON.parse(text)
      } catch {
        data = { ok: false, error: text }
      }
      if (!response.ok || data?.ok === false) throw new Error(data?.error || `HTTP ${response.status}`)
      return data
    }

    function Toggle({ checked, onChange, disabled }) {
      return h('input', { type: 'checkbox', checked: !!checked, disabled, onChange: (event) => onChange(event.target.checked) })
    }

    function GrowthSection() {
      const [state, setState] = useState(null)
      const [draft, setDraft] = useState(null)
      const [entries, setEntries] = useState([])
      const [kind, setKind] = useState('')
      const [query, setQuery] = useState('')
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [form, setForm] = useState({ kind: 'method', title: '', body: '' })

      const load = useCallback(async () => {
        try {
          const data = await api('/state')
          setState(data)
          setDraft(data.config)
          const params = new URLSearchParams()
          if (kind) params.set('kind', kind)
          if (query) params.set('q', query)
          const list = await api(`/entries?${params.toString()}`)
          setEntries(list.entries ?? [])
          setError('')
        } catch (err) {
          setError(String(err?.message ?? err))
        }
      }, [kind, query])

      useEffect(() => {
        ensureStyle()
        void load()
      }, [load])

      const dirty = useMemo(() => {
        if (!state || !draft) return false
        return JSON.stringify(state.config) !== JSON.stringify(draft)
      }, [state, draft])

      const setField = (key) => (value) => setDraft((current) => ({ ...current, [key]: value }))

      const save = async () => {
        setBusy('save')
        setError('')
        setNotice('')
        try {
          const result = await api('/config', { method: 'POST', body: JSON.stringify({ config: draft }) })
          setState((current) => ({ ...current, config: result.config, ...(result.migration ? {} : {}) }))
          setDraft(result.config)
          setNotice(result.migration ? `已保存并迁移：新增 ${result.migration.added} · 合并 ${result.migration.merged}` : '已保存')
          await load()
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setBusy('')
        }
      }

      const consolidate = async () => {
        setBusy('consolidate')
        setError('')
        setNotice('')
        try {
          const result = await api('/consolidate', { method: 'POST', body: '{}' })
          const r = result.result ?? {}
          setNotice(`总结完成：新增 ${r.stored ?? 0} · 合并 ${r.merged ?? 0} · 升级 ${r.promoted ?? 0}${r.reason ? `（${r.reason}）` : ''}`)
          await load()
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setBusy('')
        }
      }

      const addEntry = async () => {
        if (!form.title.trim() || !form.body.trim()) {
          setError('新增记忆需要标题和正文')
          return
        }
        setBusy('add')
        setError('')
        setNotice('')
        try {
          await api('/entries', { method: 'POST', body: JSON.stringify({ op: 'create', ...form }) })
          setForm({ kind: form.kind, title: '', body: '' })
          setNotice('已写入')
          await load()
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setBusy('')
        }
      }

      const remove = async (id) => {
        setBusy(id)
        try {
          await api('/entries', { method: 'POST', body: JSON.stringify({ op: 'delete', id }) })
          await load()
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setBusy('')
        }
      }

      if (!state || !draft) {
        return h('div', { className: 'gn' }, h('p', { className: 'gn-intro' }, error ? `加载失败：${error}` : '加载中…'))
      }

      const stats = state.stats ?? { counts: {} }

      return h(
        'div',
        { className: 'gn' },
        h('h3', null, '记忆与成长'),
        h(
          'p',
          { className: 'gn-intro' },
          `让 DSH 从会话里沉淀可复用的方法、教训、知识与题目复盘。当前目录：${state.root}`,
        ),
        h(
          'div',
          { className: 'gn-row' },
          h(
            'div',
            null,
            h('div', { className: 'gn-label' }, '记忆范围'),
            h('div', { className: 'gn-hint' }, '全局：本机所有工作区共享一份成长记忆。单工作区：只属于当前工作区，切换工作区互不影响。'),
          ),
          h(
            'select',
            { className: 'gn-select', value: draft.scope, onChange: (event) => setField('scope')(event.target.value), disabled: !!busy },
            h('option', { value: 'global' }, '全局记忆（所有工作区共享）'),
            h('option', { value: 'workspace' }, '单工作区记忆（按工作区分别存放）'),
          ),
        ),
        draft.scope === 'workspace'
          ? h(
              'div',
              { className: 'gn-row' },
              h(
                'div',
                null,
                h('div', { className: 'gn-label' }, '工作区'),
                h(
                  'div',
                  { className: 'gn-hint' },
                  '从已登记的工作区里选一个，它的记忆单独存放在「工作区目录/.growth-note」，与全局和其他工作区互不共享。',
                ),
              ),
              h(
                'select',
                {
                  className: 'gn-select',
                  value: draft.workspacePath || '',
                  onChange: (event) => setField('workspacePath')(event.target.value),
                  disabled: !!busy,
                },
                h('option', { value: '' }, '沿用当前会话目录'),
                ...(state.workspaces ?? []).map((workspace) =>
                  h('option', { key: workspace.id, value: workspace.path }, `${workspace.title || workspace.path} — ${workspace.path}`),
                ),
              ),
            )
          : null,
        draft.scope === 'workspace' && !(state.workspaces ?? []).length
          ? h('div', { className: 'gn-hint' }, '还没有登记过工作区；保存后使用当前会话目录。')
          : null,
        h(
          'div',
          { className: 'gn-row' },
          h(
            'div',
            null,
            h('div', { className: 'gn-label' }, '个性化匹配'),
            h('div', { className: 'gn-hint' }, '打开后，插件会把有证据的稳定偏好写进「画像」，并在回答时按你的习惯调整；关闭则完全不注入。'),
          ),
          h(Toggle, { checked: draft.personalization, onChange: setField('personalization'), disabled: !!busy }),
        ),
        h(
          'div',
          { className: 'gn-row' },
          h(
            'div',
            null,
            h('div', { className: 'gn-label' }, '自动记录会话'),
            h('div', { className: 'gn-hint' }, '每个回合把「诉求 → 动作 → 工具」写进会话笔记，作为提炼的证据。'),
          ),
          h(Toggle, { checked: draft.autoCapture, onChange: setField('autoCapture'), disabled: !!busy }),
        ),
        h(
          'div',
          { className: 'gn-row' },
          h(
            'div',
            null,
            h('div', { className: 'gn-label' }, '自动提炼记忆'),
            h('div', { className: 'gn-hint' }, '每 N 个回合用默认模型把会话笔记提炼成结构化记忆（带原文证据）。'),
          ),
          h(Toggle, { checked: draft.autoSummarize, onChange: setField('autoSummarize'), disabled: !!busy }),
        ),
        h(
          'div',
          { className: 'gn-row' },
          h('div', null, h('div', { className: 'gn-label' }, '提炼间隔（回合）'), h('div', { className: 'gn-hint' }, '1–50，默认 6。')),
          h('input', {
            className: 'gn-num',
            type: 'number',
            min: 1,
            max: 50,
            value: draft.consolidateEveryTurns,
            disabled: !!busy,
            onChange: (event) => setField('consolidateEveryTurns')(Number(event.target.value)),
          }),
        ),
        h(
          'div',
          { className: 'gn-row' },
          h('div', null, h('div', { className: 'gn-label' }, '提示词预算（字符）'), h('div', { className: 'gn-hint' }, '注入记忆摘要的上限，400–8000，默认 1800。')),
          h('input', {
            className: 'gn-num',
            type: 'number',
            min: 400,
            max: 8000,
            step: 100,
            value: draft.promptBudgetChars,
            disabled: !!busy,
            onChange: (event) => setField('promptBudgetChars')(Number(event.target.value)),
          }),
        ),
        h(
          'div',
          { className: 'gn-row' },
          h('div', null, h('div', { className: 'gn-label' }, '记忆条数上限'), h('div', { className: 'gn-hint' }, '超出后按强度淘汰最弱的普通条目；画像与状态优先保留。')),
          h('input', {
            className: 'gn-num',
            type: 'number',
            min: 50,
            max: 20000,
            step: 50,
            value: draft.maxEntries,
            disabled: !!busy,
            onChange: (event) => setField('maxEntries')(Number(event.target.value)),
          }),
        ),
        h(
          'div',
          { className: 'gn-actions' },
          h('button', { className: 'gn-btn gn-btn-primary', onClick: save, disabled: !!busy || !dirty }, busy === 'save' ? '保存中…' : dirty ? '保存配置' : '已保存'),
          h('button', { className: 'gn-btn', onClick: consolidate, disabled: !!busy || !state.model }, busy === 'consolidate' ? '总结中…' : '立即总结本会话'),
          h('a', { className: 'gn-btn', href: `${API}/export?format=md`, target: '_blank', rel: 'noreferrer', style: { lineHeight: '28px', textDecoration: 'none' } }, '导出 markdown'),
          state.model ? null : h('span', { className: 'gn-hint' }, '默认模型未就绪，暂时无法自动提炼'),
        ),
        error ? h('div', { className: 'gn-err' }, error) : null,
        notice ? h('div', { className: 'gn-ok' }, notice) : null,
        h('div', { className: 'gn-group' }, `记忆条目（${entries.length}）· 方法 ${stats.counts?.method ?? 0} · 教训 ${stats.counts?.lesson ?? 0} · 知识 ${stats.counts?.knowledge ?? 0} · 复盘 ${stats.counts?.wp ?? 0} · 画像 ${stats.counts?.preference ?? 0} · 状态 ${stats.counts?.state ?? 0}`),
        h(
          'div',
          { className: 'gn-form-row' },
          h(
            'select',
            { className: 'gn-select', value: kind, onChange: (event) => setKind(event.target.value) },
            h('option', { value: '' }, '全部类型'),
            ...KIND_ORDER.map((key) => h('option', { key, value: key }, KIND_LABEL[key])),
          ),
          h('input', { className: 'gn-input', placeholder: '搜索记忆…', value: query, onChange: (event) => setQuery(event.target.value) }),
        ),
        h(
          'div',
          { className: 'gn-list' },
          ...(entries.length
            ? entries.map((entry) =>
                h(
                  'div',
                  { className: 'gn-item', key: entry.id },
                  h(
                    'div',
                    { className: 'gn-item-head' },
                    h('span', { className: 'gn-badge' }, KIND_LABEL[entry.kind] ?? entry.kind),
                    h('span', { className: 'gn-title' }, entry.title),
                    h('span', { className: 'gn-meta' }, `置信 ${Math.round((entry.confidence ?? 0.6) * 100)}% · 用 ${entry.useCount ?? 0}`),
                    h('button', { className: 'gn-btn gn-btn-danger', onClick: () => remove(entry.id), disabled: !!busy }, '删除'),
                  ),
                  h('div', { className: 'gn-body' }, String(entry.body ?? '').slice(0, 400)),
                ),
              )
            : [h('div', { className: 'gn-hint', key: 'empty' }, '还没有记忆。完成一次有价值的工作后，模型会自动提炼；也可以手动新增。')]),
        ),
        h(
          'div',
          { className: 'gn-form' },
          h(
            'div',
            { className: 'gn-form-row' },
            h(
              'select',
              { className: 'gn-select', value: form.kind, onChange: (event) => setForm({ ...form, kind: event.target.value }) },
              ...KIND_ORDER.map((key) => h('option', { key, value: key }, KIND_LABEL[key])),
            ),
            h('input', { className: 'gn-input', placeholder: '标题（一句话）', value: form.title, onChange: (event) => setForm({ ...form, title: event.target.value }) }),
          ),
          h('textarea', { className: 'gn-textarea', placeholder: '正文：现象 / 做法 / 适用边界 / 验证方式', value: form.body, onChange: (event) => setForm({ ...form, body: event.target.value }) }),
          h('div', { className: 'gn-form-row' }, h('button', { className: 'gn-btn', onClick: addEntry, disabled: !!busy }, busy === 'add' ? '写入中…' : '手动新增一条')),
        ),
      )
    }

    function apply(ctx) {
      ensureStyle()
      ctx.effect(
        () => ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: NS, order: 7, label: () => '记忆与成长' }, GrowthSection), 'growth-note: settings section'),
        'growth-note: settings section',
      )
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
