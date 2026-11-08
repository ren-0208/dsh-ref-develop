# dsh-ref-develop

DSH 参考实现开发仓库。当前内容：**记忆与成长**（插件包名/ID `dsh-ref-develop`）。

> 命名约定：仓库名、包名、插件 ID 用 `dsh-ref-develop`；界面上叫「记忆与成长」；
> 内部数据目录与 HTTP 前缀沿用功能名 `growth-note`（`$DSH_HOME/growth-note/`、`/growth-note/api/*`），
> 它们属于实现细节，不影响安装与使用。

## 定位

把「每开一个新会话就从零开始」变成「每开一个新会话都带着此前的经验」。
growth-note 让 DSH 从**已经发生的会话**里提炼可复用的方法、教训、领域知识与题目复盘，
并按使用者的选择存成**全局共享记忆**或**单工作区记忆**，在新会话开始时自动注入系统提示词。

它对应 `记忆与成长方法/` 那套手工约定（AGENTS.md 入口 + MEMORY/ 结构化记忆 + 收尾落盘），
只是把「靠自觉」换成了「由插件自动完成，并把每条记忆绑回原始对话作为证据」。

## 特性一览

- **两条沉淀通道**：每回合零成本写会话笔记；每 N 回合用当前会话的模型提炼结构化条目。
- **证据化**：每条记忆必须引用原文片段，模型给的引用在对话里找不到时，这条记忆会被标记为「未经核实」并降权。
- **六类记忆**：方法 `method`、教训 `lesson`（否决清单）、领域知识 `knowledge`、题目复盘 `wp`、
  主人画像 `preference`（需显式开启）、项目状态 `state`。
- **按当前问题召回**：摘要不是固定全量清单，而是按本轮用户消息的关键词 + 强度打分挑 top-k。
- **可生长、可衰减**：置信度、使用次数、证据数量决定强度，强度按半衰期衰减；同一教训出现多次可升级为方法。
- **全局 / 单工作区**：一个开关切换存储根；单工作区可在设置页多选已登记工作区，
  每个工作区记忆各自独立，全局与工作区、工作区与工作区之间完全隔离，切换不迁移。
- **设置页**：DSH「设置 → 记忆与成长」里可视化查看、筛选、编辑、删除、导出。
- **命令**：会话里输入 `/growth` 查看状态、检索、切换范围、导出等。
- **零运行时依赖**：只用 Node 内置模块，无构建步骤。

## 目录结构

| 路径 | 用途 |
| --- | --- |
| `package.json` | DSH bundle 清单（`dsh.bundle.patch` 指向组合补丁，`exports` 暴露 client） |
| `cordis.patch.yml` | 把 `dsh-ref-develop` 插入 DSH 组合 |
| `lib/index.js` | 插件入口：注入摘要、注册工具/命令/路由、监听回合事件 |
| `lib/config.js` | 配置项、默认值与运行时校验（无外部依赖） |
| `lib/entry.js` | 条目模型：归一化、相似度、合并、强度衰减、教训升级 |
| `lib/store.js` | 文件存储：JSONL 权威数据、Markdown 视图、会话笔记、迁移、导出 |
| `lib/fsx.js` | 原子写、跨进程文件锁、JSON/JSONL 读写 |
| `lib/recall.js` | 分词、排序、按问题挑选注入条目 |
| `lib/prompt.js` | 生成注入系统提示词的「记忆摘要」 |
| `lib/tools.js` | 模型可调用的 `growth_*` 工具 |
| `lib/consolidate.js` | 回合落盘 + 模型提炼 + 证据校验 |
| `lib/commands.js` | `/growth` 斜杠命令 |
| `lib/api.js` | 设置页使用的同源 HTTP 接口 |
| `lib/client.js` | 设置页 UI（`settings.section` 槽位） |
| `lib/util.js` | 文本处理等小工具 |
| `test/*.test.mjs` | Node 内置测试：条目/存储/召回/提炼/工具/宿主接线/客户端 |
| `locale/{zh,en}.json` | 插件在 DSH 里的展示名称与简介 |
| `icon.svg` | 插件图标（原创） |
| `docs/DESIGN.md` | 设计说明：分层、关键决策、失败模式 |
| `docs/MEMORY-FORMAT.md` | 记忆目录格式：文件职责、条目字段、视图规则 |

## 安装

先把仓库克隆到本机（任意目录都可以，下面用 `<克隆目录>` 代指）：

```bash
git clone https://github.com/ren-0208/dsh-ref-develop.git
```

然后在 DSH 中把这个目录作为本地 bundle 安装（推荐，安装后改代码立即生效）：

```text
plugin_manager action=install_bundle target=<克隆目录>
```

例如克隆到 `D:\plugins\dsh-ref-develop`，就写：

```text
plugin_manager action=install_bundle target=D:\plugins\dsh-ref-develop
```

> 不要拿别人的绝对路径直接抄——`target` 必须是你自己机器上仓库所在的那一层目录
> （即含 `package.json` 和 `cordis.patch.yml` 的那一层）。

或者手动组合：在 profile 的 `cordis.patch.yml` 追加

```yaml
- insert:
    - id: dsh-ref-develop
      name: '@ren-0208/dsh-ref-develop'
      config:
        scope: global
```

安装后无需重启即可用：设置页会出现「记忆与成长」，会话里 `growth_status` 可调用。
卸载：`plugin_manager action=remove_bundle target=@ren-0208/dsh-ref-develop`（记忆目录不会被删除）。

## 用法

装好之后**不需要额外操作**：会话正常进行，插件在后台工作。

| 工具 | 作用 |
| --- | --- |
| `growth_remember` | 写入一条记忆（六类 kind 之一；`preference` 需先开启个性化） |
| `growth_recall` | 按关键词检索记忆，拿原文与证据；命中会累加使用次数 |
| `growth_config` | 查看/切换：全局 / 单工作区（多选工作区） / 关闭、个性化、提炼频率、预算、条数上限；`migrate=true` 才复制条目 |
| `growth_status` | 查看范围、目录、条目统计与最近更新 |
| `growth_forget` | 删除条目：默认软删除（状态置 `rejected`，保留证据），`hard=true` 彻底移除 |
| `growth_edit` | 修改标题/正文/标签/置信度 |
| `growth_export` | 导出全部记忆（Markdown 或 JSON） |

### 设置页

DSH「设置 → 记忆与成长」：

- 范围切换（全局 / 单工作区 / 无）；选「单工作区」后出现**工作区多选**，选项来自本机已登记的
  工作区（标题 + 路径），也可手动添加路径；只有会话目录位于所选工作区内时才读取记忆；
- 个性化开关、自动记录 / 自动提炼开关；
- 提炼间隔、摘要预算、条数上限；
- 「立即总结」把当前会话已有笔记马上提炼一次；
- 条目列表：按类型筛选、关键词搜索、查看置信度/使用次数、编辑、删除；
- 导出 Markdown。

设置页通过插件自建的同源接口 `/growth-note/api/*` 读写，不需要额外的远程通道。

### 命令

```text
/growth                      状态
/growth remember lesson 标题 :: 正文
/growth recall 关键词
/growth scope workspace|global|off
/growth workspace D:\proj\a,D:\proj\b    多选启用记忆的工作区
/growth workspace clear                  清空选择（不再启用记忆）
/growth config personalization=true
/growth export md|json
/growth consolidate          立即提炼
/growth forget <id> [hard]
```

### 选择记忆范围

三种范围**互相隔离**：切换只改变「读哪一份库」，不会自动搬动数据。

- **全局记忆**（默认 `scope: global`）：所有工作区共享一份成长记忆，路径 `$DSH_HOME/growth-note/global`。
  适合「跨项目的通用方法、读书笔记、个人偏好」。
- **单工作区记忆**（`scope: workspace`）：**每个工作区各一份、互不共享**，路径 `<工作区>/.growth-note`。
  适合「只跟这个项目有关的状态、约定、踩过的坑」。
  在设置页里**多选**已登记工作区（也可手动添加路径）；会话目录必须等于其中之一或位于其下，
  否则该会话回到默认状态——不注入、不记录、不提炼。
  一个都不选时不启用记忆，会话保持默认状态。
- **无**（`scope: off`）：完全关闭记忆。不记录会话笔记、不自动提炼、不往提示词里注入内容；
  已存下的条目原样保留，切回全局或单工作区即恢复，也不做迁移。

每个工作区目录下会有独立的 `AGENTS.md`、`memory.jsonl`、`MEMORY/`、`sessions/`，
切换工作区只切换「当前读写哪一份」，不会把 A 的条目搬进 B。

全局 ↔ 工作区之间同样不自动迁移；确实需要搬条目时显式加 `migrate=true`：

```text
growth_config(scope="global", migrate=true)
```

迁移只复制目标库没有的活跃条目（按 id 去重），源库原样保留；软删除 / 已取代的条目不会迁移。

### 个性化匹配（可选，默认关闭）

打开后，插件会额外从对话里提炼「主人画像」（沟通风格、格式偏好、关注点、禁忌），
并在摘要里注入画像条目：

```text
growth_config(personalization=true)
```

只记录有证据的稳定偏好；同一切面（aspect）出现新值时会取代旧值，不会把两种风格拼在一起。
`preference` 类条目不参与淘汰，但长期不用也会衰减。

### 成长面

- **读书 / 新闻 / 论文 / 课程** → `knowledge`（带 `meta.subject` / `meta.topic`）
- **任何学科题目**（CTF、课程作业、专业资格题、面试题）→ `wp`，
  要求写清「题目 → 关键一步 → 弯路 → 可复用产物」（`meta.platform` / `meta.category`）
- **解决问题的方法与命令** → `method`（`meta.appliesTo` 记录适用环境）
- **试过且失败的做法及原因**（否决清单）→ `lesson`；同一教训累计出现 3 次自动升级为 `method`
- **项目现状与下一步** → `state`（`meta.project` / `meta.status`）
- **对主人的个性化适配** → `preference`（需开启）

### 自动沉淀怎么发生

1. 每个回合结束时，把本回合的「诉求 / 结论 / 调用的工具」写成一条会话笔记，
   追加到 `sessions/<会话id>.md`（不调用模型，零成本、失败也能留档）。
2. 每 `consolidateEveryTurns`（默认 6）个回合，用**当前会话自己的模型**把最近若干条笔记提炼成最多 8 条候选。
3. 候选逐条校验：`kind` 合法、标题非空、引用的原文片段能在对话里找到。
   找不到的记为 `verified: false` 且置信度减半——仍可保留，但会更快衰减。
4. 通过校验的条目与库中已有条目比对：
   - 同一 key 或标题高度相似（≥ `dedupeThreshold`）→ 合并（拼接正文、抬高置信度、追加证据）；
   - 同一 `preference` 切面出现不同值 → 新条目取代旧条目；
   - `lesson` 达到升级阈值 → 自动生成对应 `method`。
5. 刷新 `MEMORY/*.md` 视图；下一回合的摘要已经带上新条目。

模型不可用、超时或输出不是合法 JSON 时，只保留第 1 层笔记，不会报错打断会话。

## 配置项

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `scope` | `global` | `global` 全局共享 / `workspace` 单工作区 / `off` 关闭记忆 |
| `workspacePaths` | `[]` | 单工作区模式下启用记忆的工作区目录（可多选）；`[]` = 不启用记忆 |
| `personalization` | `false` | 是否启用主人画像 |
| `autoCapture` | `true` | 回合结束是否写会话笔记 |
| `autoSummarize` | `true` | 是否调用模型提炼条目 |
| `consolidateEveryTurns` | `6` | 每多少回合提炼一次 |
| `promptBudgetChars` | `1800` | 注入提示词的摘要字数上限 |
| `maxEntries` | `3000` | 条目上限（超限按强度淘汰，画像/状态类保留） |
| `sessionNotesPerConsolidation` | `6` | 每次提炼读取最近几条笔记 |
| `halfLifeDays` | `30` | 强度衰减半衰期 |
| `minConfidence` | `0.35` | 低于该置信度的条目不再进入召回候选 |
| `dedupeThreshold` | `0.7` | 标题相似度达到该值才合并 |
| `promoteLessonAfter` | `3` | 同一教训出现多少次升级为方法 |
| `locale` | `zh` | 提炼提示词与摘要语言 |

运行时改动会写入 `$DSH_HOME/growth-note/settings.json`，重启后保持；bundle 里的 `config` 只提供初始值。

## 记忆目录长什么样

```text
<root>/
  AGENTS.md            入口说明（自动生成一次）
  memory.jsonl         权威数据：一行一条目（含证据、置信度、状态）
  store.json           存储版本与元信息
  MEMORY/
    INDEX.md           总表 + 最近更新（生成）
    PLAYBOOK.md        方法 + 否决清单 + 状态（生成）
    KNOWLEDGE.md       领域知识（生成）
    WP/INDEX.md        题目复盘（生成）
    PERSONA.md         主人画像（生成）
    SESSIONS.md        会话流水，一行一会话（追加）
  sessions/<id>.md     每回合的原始笔记
```

`memory.jsonl` 是唯一事实来源，其余 Markdown 都是由它渲染出来给人看的视图，可随时重建。
写入走「临时文件 + rename」并加跨进程锁，避免多会话同时写坏文件。
条目字段与「另一会话只看目录能否接着干」的判断标准见 `docs/MEMORY-FORMAT.md`。

## 隐私与边界

- 全部数据在本机文件系统，不上传任何第三方；提炼调用的是你已经在用的模型。
- 记忆里的内容会进入系统提示词，等于发给模型服务商，这与正常对话无异；
  设置页可以随时删除单条或导出全部。
- 插件不读历史会话的全文，只读**当前会话**的事件流来写笔记；跨会话的经验靠落盘的记忆条目传递。
- 不做向量检索（零依赖），用关键词 + 汉字 bigram + 置信度 + 使用频次 + 新鲜度打分，
  够用、可解释、不引入外部服务。
- 记忆是「可修正的草稿」：与当前事实冲突时以事实为准，用 `growth_remember` 覆盖或 `growth_forget` 删除。

## 开发

```bash
# 语法自检（不需要依赖）
for f in lib/*.js; do node --input-type=module --check < "$f"; done

# 测试：逐文件运行（沙箱里 node --test 会 spawn 子进程被拒）
for f in test/*.test.mjs; do node "$f"; done
```

- 分支：`main` 始终保持可运行；功能走 `feat/xxx`，实验走 `exp/xxx`，合并用 `--no-ff`。
- 提交：Conventional Commits（`feat:` `fix:` `docs:` `refactor:` `chore:`），中文正文，一次提交只做一件事。
- 换行：统一 LF，由仓库根 `.gitattributes` 约束。
- 零运行时依赖：只用 Node 内置模块，避免插件在用户环境里因为装包失败而不可用。

## 环境要求

- DSH（桌面版或命令行版均可），支持 Cordis bundle 插件与 `settings.section` 槽位。
- Node.js ≥ 20（插件用 ESM + 私有类字段；`engines` 已声明）。
- 无需安装任何依赖，无构建步骤。
