# 记忆目录格式

一个「记忆根」是下面这个结构。`scope=global` 时位于 `$DSH_HOME/growth-note/global`，
`scope=workspace` 时位于 `<工作区>/.growth-note`。

```
<root>/
  AGENTS.md
  memory.jsonl
  MEMORY/
    INDEX.md
    PLAYBOOK.md
    KNOWLEDGE.md
    PERSONA.md
    SESSIONS.md
    WP/
      INDEX.md
  sessions/
    <session-id>.md
```

## memory.jsonl —— 唯一事实来源

每行一个 JSON 对象，UTF-8，LF 结尾。读取时忽略空行与解析失败的行（容错，不阻断）。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | string | 是 | `mg-<时间base36>-<8位随机>`，全局唯一 |
| `kind` | string | 是 | 见下表 |
| `title` | string | 是 | ≤160 字，单行；用于检索与去重 |
| `body` | string | 是 | 可多段；写入时截断到工具限制，提炼时 ≤1200 字 |
| `tags` | string[] | 否 | ≤12 个；参与召回打分（命中 ×4） |
| `source` | string \| null | 否 | 书名/URL/题目名/`session:<id>` |
| `createdAt` | ISO string | 是 | 首次写入时间 |
| `updatedAt` | ISO string | 是 | 合并或修改时间 |
| `useCount` | number | 是 | 被 `growth_recall` 召回并展示的次数 |
| `lastUsedAt` | ISO string \| null | 否 | 最近一次被召回的时间 |

### kind 取值

| kind | 含义 | 典型内容 |
| --- | --- | --- |
| `method` | 可复用方法 | 命令、工具链、排查步骤、写作套路 |
| `lesson` | 否决清单 | 试过什么、为什么失败、下次别再怎么做 |
| `knowledge` | 领域知识 | 读书/新闻/论文/课程得到的事实与结论 |
| `wp` | 题目复盘 | 任何学科题目：题目 → 关键一步 → 弯路 → 可复用产物 |
| `preference` | 主人画像 | 沟通风格、格式偏好、关注点、禁忌（需开个性化） |
| `state` | 项目状态 | 当前进展、下一步、阻塞项 |

### 去重规则

同 `kind` 且 `title`（忽略大小写、压缩空白后）相同视为同一条：合并 `body`（不重复追加完全相同的内容）、
合并 `tags`、刷新 `updatedAt`。因此标题要稳定、可复述；不要用「今天的总结」这类一次性标题。

## AGENTS.md

首次创建记忆根时写入一次，说明「这是 growth-note 维护的记忆目录、怎么用、四类内容是什么」。
之后不再覆盖，用户可以自行追加说明。

## MEMORY/*.md —— 生成视图

全部由 `memory.jsonl` 渲染，写入条目后自动刷新；手工修改会在下次写入时被覆盖。
可以用来直接浏览、grep、或用编辑器查看 diff。

| 文件 | 内容 |
| --- | --- |
| `INDEX.md` | 统计行 + 最近更新的 30 条 |
| `PLAYBOOK.md` | 方法 / 否决清单 / 状态三段 |
| `KNOWLEDGE.md` | `knowledge` 列表 |
| `WP/INDEX.md` | `wp` 列表 + 复盘写法提示 |
| `PERSONA.md` | `preference` 列表 + 「只记有证据的稳定偏好」提示 |
| `SESSIONS.md` | 追加式会话流水：`- 日期 · 会话id · 首行摘要` |

渲染顺序统一按 `updatedAt` 倒序；`SESSIONS.md` 例外，它是追加日志。

## sessions/<id>.md —— 会话笔记

每个回合一节，标题为 `## turn <n> · <本地时间>`，正文三段：

```
### 诉求       用户消息文本
### 结论/动作   助手回复文本
### 工具        name(args 前 120 字) 列表
```

- 单回合截断到 6000 字符，避免长输出撑爆提炼输入。
- 会话 id 里非 `[\w.-]` 的字符替换为 `_`，防止路径穿越。
- 这些文件是提炼的原料，可以删除；删除只影响未来的提炼素材，不影响已入库条目。

## 摘要注入格式

`buildDigest` 生成的文本类似：

```
## 记忆与成长（growth-note）

当前记忆范围：**全局共享**；记忆目录：`...`；工作区：`...`。
...

### 可复用方法
- 标题：正文

### 否决清单（别重复踩）
...
```

总长受 `promptBudgetChars` 限制；超出时按段落整段截断，不会截在标题里。

## 一份手写的最小示例

`memory.jsonl`：

```json
{"id":"mg-lq3k2a-1f9c2d47","kind":"lesson","title":"curl 判断不了 GitHub 连通性","body":"沙箱下 schannel 报 SEC_E_NO_CREDENTIALS；改用 git ls-remote 验证网络与凭据。","tags":["git","sandbox"],"source":"session:abc","createdAt":"2026-11-08T02:10:00.000Z","updatedAt":"2026-11-08T02:10:00.000Z","useCount":3,"lastUsedAt":"2026-11-09T01:00:00.000Z"}
```

写入后 `MEMORY/PLAYBOOK.md` 会出现：

```
## 否决清单（试过且失败的）

- **curl 判断不了 GitHub 连通性** `1f9c2d` · 沙箱下 schannel 报 SEC_E_NO_CREDENTIALS；改用 git ls-remote 验证网络与凭据。 · `git`,`sandbox`
```
