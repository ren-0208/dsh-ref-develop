# 记忆目录格式（v2）

`memory.jsonl` 是唯一事实来源；`MEMORY/*.md` 是渲染出来的视图，可随时重建。
本文件描述磁盘上到底有什么、每个字段是什么意思，以及「另一个会话只看目录能不能接着干」。

## 目录

```text
<root>/                         全局：$DSH_HOME/growth-note/global
                               工作区：<cwd>/.growth-note
  AGENTS.md                     入口说明（首次创建时写入，之后不覆盖）
  memory.jsonl                  权威数据：一行一个条目
  store.json                    存储版本与元信息 {"version":2}
  memory.jsonl.lock             写入时的跨进程锁（短命，正常不残留）
  MEMORY/
    INDEX.md                    总表 + 最近更新（生成）
    PLAYBOOK.md                 方法 / 否决清单 / 状态（生成）
    KNOWLEDGE.md                领域知识（生成）
    WP/INDEX.md                 题目复盘（生成）
    PERSONA.md                  主人画像（生成）
    SESSIONS.md                 会话流水，一行一会话（追加）
  sessions/<会话id>.md          每回合的原始笔记
```

## memory.jsonl

一行一个 JSON 对象，无外层数组。追加与重写都走「临时文件 + rename」。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `schema` | number | 当前为 `2` |
| `id` | string | `mg-<时间戳36>-<8位随机>`，导入时保留原 id |
| `kind` | string | `method` / `lesson` / `knowledge` / `wp` / `preference` / `state` |
| `title` | string | 一句话结论，≤160 字，去重主要看它 |
| `body` | string | 做法 / 现象 / 边界 / 验证方式，≤8000 字 |
| `tags` | string[] | 关键词，≤6 个，小写 |
| `meta` | object | 各 kind 的专属字段，见下表 |
| `confidence` | number | 0–1，默认 0.6；合并时 +0.05，上限 0.95 |
| `status` | string | `active` / `superseded`（被新偏好取代）/ `rejected`（软删除） |
| `verified` | boolean | 证据片段是否能在对话里找到 |
| `useCount` | number | 被 `growth_recall` 命中的次数 |
| `createdAt` / `updatedAt` | ISO string | 创建 / 最后修改 |
| `lastUsedAt` | ISO string \| null | 最后一次命中 |
| `source` | object \| null | `{sessionId, turn, cwd, url, title}`，线索出处 |
| `evidence` | object[] | 证据，≤8 条：`{sessionId, turn, seq, quote, at}` |
| `supersedes` | string[] | 本条目取代了哪些旧条目 |
| `supersededBy` | string \| null | 被哪条取代 |
| `mergedFrom` | string[] | 合并进来的条目 id |
| `promotedFrom` | string \| null | 由哪条 lesson 升级而来 |

## meta 字段

| kind | 字段 | 正列子 |
| --- | --- | --- |
| `method` | `appliesTo` | `["windows","node"]`（适用环境） |
| `lesson` | `appliesTo` / `why` | `["make","windows"]` / 失败原因 |
| `knowledge` | `subject` / `topic` / `source` | 学科 / 章节 / 书名或链接标题 |
| `wp` | `platform` / `category` | `ctf` / `crypto`、课程 / 面试 / 资格考 |
| `preference` | `aspect` / `value` | `language` / `中文` |
| `state` | `project` / `status` | 项目名 / `进行中`、`已完成` |

## 去重、合并与取代

判定顺序（`GrowthStore.addEntry`）：

1. **key 完全相同**（`kind::小写标题`）→ 合并。
2. **相似度 ≥ `dedupeThreshold`（默认 0.7）** → 合并。
   相似度 = 标题 Jaccard × 0.85 + 正文 Jaccard × 0.15；标题相似度 < 0.5 直接判为不同条目
   （避免模板化正文把不同主题并成一条）。
3. **两条都是 `preference`，`aspect` 相同但 `value` 不同** → 不合并：
   新条目写入，旧条目置 `superseded` 并记录 `supersededBy`。
4. 其余情况 → 新增条目。

合并时：正文去重拼接（≤8000 字）、标签并集、置信度 +0.05、证据并集（≤8 条）、
刷新 `updatedAt`，并把来源 id 记进 `mergedFrom`。

## 强度与淘汰

```text
strength = confidence × 0.5^(ageDays / halfLifeDays)
         + min(useCount × 0.02, 0.3)
         + min(evidenceCount × 0.03, 0.2)
```

- `ageDays` 取 `lastUsedAt ?? updatedAt`。
- `strength` 低于 `minConfidence`（默认 0.35）的条目不进入召回候选。
- 超过 `maxEntries`（默认 3000）时按 `strength` 升序淘汰；
  `preference` 与 `state` 永不因条数被淘汰。
- `status: rejected` 且超过 120 天未更新 → 物理删除。

## 教训升级为方法

同一 `lesson` 被重复提及时 `confidence` 升高；当它的证据数或重复次数达到
`promoteLessonAfter`（默认 3）时，自动生成一条 `method`：
标题沿用、正文加前缀、`promotedFrom` 指向原 lesson。

## 视图文件

都由 `render()` 从 `memory.jsonl` 生成，覆盖写：

- `INDEX.md`：六类计数、最近更新 10 条、每条一行（id/kind/标题/置信度/使用次数）。
- `PLAYBOOK.md`：方法、否决清单、状态三类。
- `KNOWLEDGE.md`：领域知识，按 `meta.subject` 分组。
- `WP/INDEX.md`：题目复盘，按 `meta.platform` 分组。
- `PERSONA.md`：主人的稳定偏好（`aspect: value`）。

`SESSIONS.md` 只追加不覆盖：每个会话第一次写笔记时加一行
`- <时间> · <会话id> · <工作目录>`。`sessions/<id>.md` 每回合追加一节，格式：

```markdown
## turn 6 · 2026-11-08T02:00:00.000Z

### 诉求
本机没有 make，怎么编译？

### 结论动作
改用 node 版工具链。

### 工具
- `bash` 失败：make: command not found
```

## 摘要注入格式

`buildDigest` 生成，受 `promptBudgetChars` 限制（默认 1800 字符）：

```markdown
## 记忆与成长（dsh-ref-develop）
范围：全局记忆（所有工作区共享） · 记忆目录：`<root>`
用法：下面只是摘要（共 7 条，本轮命中 2 条）；需要原文时调用 `growth_recall(query)`。没有证据支持的内容不要当成事实。
本轮问题：cordis 服务怎么注入

### 状态（1）
1. **growth-note 已到 v2** (dsh-ref-devlop · 进行中) · 置信80%
   还剩文档与安装验证。
```

每类渲染成 `### <类别>（n）`，每条两行；预算不够时整条丢弃，末尾提示用 `growth_recall`。

## 导出格式

- `GET /growth-note/api/export?format=json`：
  `{"version":2,"exportedAt":"…","config":{…},"stats":{…},"entries":[…]}`。
- `format=md`（默认）：标题「记忆与成长导出」+ 元信息 + 六类分节。
- 导入：`GrowthStore.importEntries(list,{mode})` 保留原 id，已存在的 id 跳过或覆盖。

## 最小可读示例

```jsonl
{"schema":2,"id":"mg-mw6ps0aj-c79bf0da","kind":"method","title":"插件取服务要兼容两种写法","body":"真机上 ctx.get('tools') 是 undefined，先读 ctx.tools 再回退 get。","tags":["cordis","dsh"],"meta":{"appliesTo":["dsh","cordis"]},"confidence":0.8,"status":"active","verified":true,"useCount":3,"createdAt":"2026-11-08T01:58:00.000Z","updatedAt":"2026-11-08T02:00:00.000Z","lastUsedAt":"2026-11-08T02:00:00.000Z","source":{"sessionId":"session-11599e01","turn":6,"cwd":"D:/例子","url":null,"title":null},"evidence":[{"sessionId":"session-11599e01","turn":6,"seq":42,"quote":"ctx.get 返回 undefined","at":"2026-11-08T01:58:00.000Z"}],"supersedes":[],"supersededBy":null,"mergedFrom":[],"promotedFrom":null}
```
