# dsh-ref-develop

DSH 插件「记忆与成长」的参考实现。包名与插件 ID 为 `dsh-ref-develop`，界面显示名为「记忆与成长」。

> 命名说明：仓库名、包名、插件 ID 统一使用 `dsh-ref-develop`；内部数据目录与 HTTP 接口前缀沿用功能名
> `growth-note`（`$DSH_HOME/growth-note/`、`/growth-note/api/*`）。二者差异属于实现细节，不影响安装与使用。

## 概述

DSH 的每次新会话默认从零开始。「记忆与成长」在会话进行过程中提取可复用的方法、教训、领域知识与题目复盘，
持久化为结构化条目，并在后续会话开始时按需注入系统提示词。

插件对应 `记忆与成长方法/` 中的人工约定（以 AGENTS.md 为入口、MEMORY/ 分层结构化记忆、会话结束落盘），
区别在于该过程由插件自动执行，且每条记忆都绑定原始对话片段作为证据。

## 功能特性

- **双通道沉淀**：每回合以零模型成本写入会话笔记；每 N 回合调用当前会话的模型提炼结构化条目。
- **证据化**：每条记忆必须引用原文片段。模型给出的引用无法在对话中找到时，该条目标记为「未经核实」并降权。
- **六类记忆**：方法 `method`、教训 `lesson`（否决清单）、领域知识 `knowledge`、题目复盘 `wp`、
  用户画像 `preference`（需显式开启）、项目状态 `state`。
- **按问题召回**：注入内容并非固定全量清单，而是依据本轮用户消息的关键词与条目强度挑选 top-k。
- **强度与衰减**：置信度、使用次数与证据数量共同决定强度，强度按半衰期衰减；重复出现的教训可升级为方法。
- **三种记忆范围**：全局记忆、单工作区记忆（可多选工作区）、无。三者相互隔离，切换不自动迁移数据。
- **设置页**：在 DSH「设置 → 记忆与成长」中查看、筛选、编辑、删除与导出记忆。
- **命令**：会话内通过 `/growth` 查看状态、检索、切换范围、导出等。
- **零运行时依赖**：仅使用 Node.js 内置模块，无构建步骤。

## 目录结构

| 路径 | 用途 |
| --- | --- |
| `package.json` | DSH bundle 清单（`dsh.bundle.patch` 指向组合补丁，`exports` 暴露 client） |
| `cordis.patch.yml` | 将 `dsh-ref-develop` 插入 DSH 组合 |
| `lib/index.js` | 插件入口：注入摘要、注册工具/命令/路由、监听回合事件 |
| `lib/config.js` | 配置项、默认值与运行时校验（无外部依赖） |
| `lib/entry.js` | 条目模型：归一化、相似度、合并、强度衰减、教训升级 |
| `lib/store.js` | 文件存储：JSONL 权威数据、Markdown 视图、会话笔记、迁移、导出 |
| `lib/fsx.js` | 原子写、跨进程文件锁、JSON/JSONL 读写 |
| `lib/recall.js` | 分词、排序、按问题挑选注入条目 |
| `lib/prompt.js` | 生成注入系统提示词的记忆摘要 |
| `lib/tools.js` | 模型可调用的 `growth_*` 工具 |
| `lib/consolidate.js` | 回合落盘、模型提炼与证据校验 |
| `lib/commands.js` | `/growth` 斜杠命令 |
| `lib/api.js` | 设置页使用的同源 HTTP 接口 |
| `lib/client.js` | 设置页 UI（`settings.section` 槽位） |
| `lib/util.js` | 文本处理等辅助函数 |
| `test/*.test.mjs` | Node.js 内置测试：条目、存储、召回、提炼、工具、宿主接线、客户端 |
| `locale/{zh,en}.json` | 插件在 DSH 中的展示名称与简介 |
| `icon.svg` | 插件图标（原创） |
| `docs/DESIGN.md` | 设计说明：分层、关键决策、失败模式 |
| `docs/MEMORY-FORMAT.md` | 记忆目录格式：文件职责、条目字段、视图规则 |

## 安装

### 一键安装（推荐）

将下列文本完整复制给任意一个 DSH 会话，由其完成克隆与安装：

```text
请安装 DSH 插件「记忆与成长」，仓库地址：https://github.com/ren-0208/dsh-ref-develop.git
1. 浅克隆到 $DSH_HOME/plugins/dsh-ref-develop；目录已存在时执行 git pull --ff-only
2. 执行 plugin_manager action=install_bundle target=<克隆目录>
3. 报告 application 字段是否为 applied，并确认设置页出现「记忆与成长」
```

仓库为公开仓库，克隆不需要凭据。安装完成后无需重启：设置页会出现「记忆与成长」，会话内可直接调用 `growth_status`。

### 手动安装

```bash
git clone https://github.com/ren-0208/dsh-ref-develop.git
```

```text
plugin_manager action=install_bundle target=<克隆目录>
```

`target` 必须指向本机包含 `package.json` 与 `cordis.patch.yml` 的目录层级，不应直接沿用他人的绝对路径。

也可通过组合文件手动挂载：在 profile 的 `cordis.patch.yml` 中追加

```yaml
- insert:
    - id: dsh-ref-develop
      name: '@ren-0208/dsh-ref-develop'
      config:
        scope: global
```

### 升级

已安装同名包时，`install_bundle` 返回 `already-installed`。更新本地仓库后，执行
`plugin_manager action=set_bundle` 先禁用再启用即可重新加载代码；也可先 `remove_bundle` 再重新安装。

### 卸载

```text
plugin_manager action=remove_bundle target=@ren-0208/dsh-ref-develop
```

卸载不会删除记忆目录。

## 使用

安装完成后无需额外交互：会话正常进行，插件在后台工作。

| 工具 | 作用 |
| --- | --- |
| `growth_remember` | 写入一条记忆（六类 kind 之一；`preference` 需先开启个性化） |
| `growth_recall` | 按关键词检索记忆，返回原文与证据；命中会累加使用次数 |
| `growth_config` | 查看或切换：全局 / 单工作区（多选工作区）/ 关闭、个性化、提炼频率、预算、条数上限；`migrate=true` 时才复制条目 |
| `growth_status` | 查看范围、目录、条目统计与最近更新 |
| `growth_forget` | 删除条目：默认软删除（状态置 `rejected`，保留证据），`hard=true` 彻底移除 |
| `growth_edit` | 修改标题、正文、标签与置信度 |
| `growth_export` | 导出全部记忆（Markdown 或 JSON） |

### 设置页

路径：DSH「设置 → 记忆与成长」。

- 范围切换（全局 / 单工作区 / 无）。选择「单工作区」后显示**工作区多选**，选项来自本机已登记的工作区
  （标题与路径），也支持手动添加路径；仅当会话目录位于所选工作区内时才读写记忆。
- 个性化开关、自动记录与自动提炼开关。
- 提炼间隔、摘要预算、条数上限。
- 「立即总结」：立即提炼当前会话已有的笔记。
- 条目列表：按类型筛选、关键词搜索、查看置信度与使用次数、编辑、删除。
- 导出 Markdown。

设置页通过插件自建的同源接口 `/growth-note/api/*` 读写，不依赖额外的远程通道。

### 命令

```text
/growth                      查看状态
/growth remember lesson 标题 :: 正文
/growth recall 关键词
/growth scope workspace|global|off
/growth workspace D:\proj\a,D:\proj\b    设置启用记忆的工作区（多选）
/growth workspace clear                  清空选择（不再启用记忆）
/growth config personalization=true
/growth export md|json
/growth consolidate                      立即提炼
/growth forget <id> [hard]
```

### 记忆范围

三种范围**相互隔离**：切换只改变「读写哪一份库」，不会自动搬动数据。

- **全局记忆**（默认，`scope: global`）：所有工作区共享一份记忆，路径为 `$DSH_HOME/growth-note/global`，
  适合跨项目通用的方法、读书笔记与个人偏好。
- **单工作区记忆**（`scope: workspace`）：每个工作区各一份、互不共享，路径为 `<工作区>/.growth-note`，
  适合与特定项目相关的状态、约定与问题记录。在设置页中**多选**已登记工作区（也支持手动添加路径）；
  会话目录必须等于其中之一或位于其下，否则该会话回到默认状态：不注入、不记录、不提炼。
  未选择任何工作区时同样不启用记忆。
- **无**（`scope: off`）：完全关闭记忆。不记录会话笔记、不自动提炼、不向提示词注入内容；
  已存条目原样保留，切回全局或单工作区即恢复，且不做迁移。

直接禁用插件效果相同：插件不加载，会话中既无记忆注入，也无记忆工具。

每个工作区目录下均有独立的 `AGENTS.md`、`memory.jsonl`、`MEMORY/` 与 `sessions/`。
切换工作区仅切换当前读写的库，不会将 A 的条目写入 B。

全局与工作区之间同样不自动迁移。确需搬迁条目时显式指定 `migrate=true`：

```text
growth_config(scope="global", migrate=true)
```

迁移仅复制目标库中不存在的活跃条目（按 id 去重），源库保持不变；软删除与被取代的条目不参与迁移。

### 个性化匹配（可选，默认关闭）

开启后，插件会额外从对话中提炼「用户画像」（沟通风格、格式偏好、关注点与禁忌），并在摘要中注入画像条目：

```text
growth_config(personalization=true)
```

仅记录有证据支撑的稳定偏好。同一切面（aspect）出现新值时，新值取代旧值，不会将两种风格并列保存。
`preference` 类条目不参与按条数淘汰，但长期未使用同样会衰减。

### 成长范围

- **读书、新闻、论文、课程** → `knowledge`（携带 `meta.subject` / `meta.topic`）
- **各学科题目**（CTF、课程作业、专业资格题、面试题）→ `wp`，
  要求写明「题目 → 关键一步 → 弯路 → 可复用产物」（`meta.platform` / `meta.category`）
- **解决问题的方法与命令** → `method`（`meta.appliesTo` 记录适用环境）
- **已尝试且失败的做法及原因**（否决清单）→ `lesson`；同一教训累计出现 3 次后自动升级为 `method`
- **项目现状与下一步** → `state`（`meta.project` / `meta.status`）
- **对使用者的个性化适配** → `preference`（需开启）

### 自动沉淀流程

1. 每个回合结束时，将本回合的「诉求 / 结论 / 调用的工具」写成一条会话笔记，
   追加至 `sessions/<会话id>.md`（不调用模型，成本为零，即使后续失败也能留档）。
2. 每 `consolidateEveryTurns`（默认 6）个回合，使用**当前会话的模型**将最近若干条笔记提炼为最多 8 条候选。
3. 候选逐条校验：`kind` 合法、标题非空、引用的原文片段可在对话中找到。
   无法找到的记为 `verified: false` 且置信度减半；条目仍可保留，但衰减更快。
4. 通过校验的条目与库中已有条目比对：
   - 同一 key，或标题相似度 ≥ `dedupeThreshold` → 合并（拼接正文、提高置信度、追加证据）；
   - 同一 `preference` 切面出现不同值 → 新条目取代旧条目；
   - `lesson` 达到升级阈值 → 自动生成对应的 `method`。
5. 刷新 `MEMORY/*.md` 视图；下一回合的摘要即包含新条目。

模型不可用、超时或输出不是合法 JSON 时，仅保留第 1 层笔记，不会抛出错误打断会话。

## 配置项

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `scope` | `global` | `global` 全局共享 / `workspace` 单工作区 / `off` 关闭记忆 |
| `workspacePaths` | `[]` | 单工作区模式下启用记忆的工作区目录（可多选）；`[]` 表示不启用记忆 |
| `personalization` | `false` | 是否启用用户画像 |
| `autoCapture` | `true` | 回合结束时是否写会话笔记 |
| `autoSummarize` | `true` | 是否调用模型提炼条目 |
| `consolidateEveryTurns` | `6` | 每多少回合提炼一次 |
| `promptBudgetChars` | `1800` | 注入提示词的摘要字数上限 |
| `maxEntries` | `3000` | 条目上限（超限按强度淘汰，画像与状态类保留） |
| `sessionNotesPerConsolidation` | `6` | 每次提炼读取最近几条笔记 |
| `halfLifeDays` | `30` | 强度衰减半衰期 |
| `minConfidence` | `0.35` | 低于该置信度的条目不再进入召回候选 |
| `dedupeThreshold` | `0.7` | 标题相似度达到该值才合并 |
| `promoteLessonAfter` | `3` | 同一教训出现多少次后升级为方法 |
| `locale` | `zh` | 提炼提示词与摘要语言 |

运行时配置写入 `$DSH_HOME/growth-note/settings.json`，重启后保持；bundle 中的 `config` 仅提供初始值。

## 记忆目录结构

```text
<root>/
  AGENTS.md            入口说明（自动生成一次）
  memory.jsonl         权威数据：一行一条目（含证据、置信度、状态）
  store.json           存储版本与元信息
  MEMORY/
    INDEX.md           总表与最近更新（生成）
    PLAYBOOK.md        方法、否决清单与状态（生成）
    KNOWLEDGE.md       领域知识（生成）
    WP/INDEX.md        题目复盘（生成）
    PERSONA.md         用户画像（生成）
    SESSIONS.md        会话流水，一行一会话（追加）
  sessions/<id>.md     每回合的原始笔记
```

`memory.jsonl` 是唯一事实来源，其余 Markdown 均为由其渲染的只读视图，可随时重建。
写入采用「临时文件 + rename」并加跨进程锁，避免多会话并发写入损坏文件。
条目字段及「另一会话仅凭目录能否继续工作」的判断标准见 `docs/MEMORY-FORMAT.md`。

## 隐私与安全边界

- 全部数据位于本机文件系统，不向第三方上传；提炼使用使用者当前配置的模型。
- 记忆内容会进入系统提示词，等同于发送给模型服务商，与正常对话一致；设置页可随时删除单条或导出全部。
- 插件不读取历史会话全文，仅读取**当前会话**的事件流以生成笔记；跨会话经验通过落盘条目传递。
- 不引入向量检索（保持零依赖），采用关键词、汉字 bigram、置信度、使用频次与新鲜度综合打分，
  结果可解释且不依赖外部服务。
- 记忆是「可修正的草稿」：与当前事实冲突时以事实为准，可通过 `growth_remember` 覆盖或 `growth_forget` 删除。

## 开发

```bash
# 语法自检（无需安装依赖）
for f in lib/*.js; do node --input-type=module --check < "$f"; done

# 测试：逐文件运行（受限沙箱中 node --test 会因 spawn 子进程被拒）
for f in test/*.test.mjs; do node "$f"; done
```

- 分支：`main` 始终保持可运行；功能分支使用 `feat/xxx`，实验分支使用 `exp/xxx`，合并使用 `--no-ff`。
- 提交：遵循 Conventional Commits（`feat:` `fix:` `docs:` `refactor:` `chore:`），正文使用中文，一次提交只做一件事。
- 换行：统一 LF，由仓库根 `.gitattributes` 约束。
- 零运行时依赖：仅使用 Node.js 内置模块，避免因安装依赖失败导致插件不可用。

## 环境要求

- DSH（桌面版或命令行版），支持 Cordis bundle 插件与 `settings.section` 槽位。
- Node.js ≥ 20（插件使用原生 ESM 与类私有字段 `#field`；`engines` 已声明）。
- 无需安装任何依赖，无构建步骤。
