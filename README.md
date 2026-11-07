# dsh-ref-devlop

DSH 参考实现开发仓库。当前内容：**growth-note**（记忆与成长）插件。

## 定位

把「每开一个新会话就从零开始」变成「每开一个新会话都带着此前的经验」。
growth-note 让 DSH 从**已经发生的会话**里提炼可复用的方法、教训、领域知识与题目复盘，
并按使用者的选择存成**全局共享记忆**或**单工作区记忆**，在新会话开始时自动注入系统提示词。

它对应 `记忆与成长方法/` 那套手工约定（AGENTS.md 入口 + MEMORY/ 结构化记忆 + 收尾落盘），
只是把「靠自觉」换成了「由插件自动完成」。

## 目录结构

| 路径 | 用途 |
| --- | --- |
| `package.json` | DSH bundle 清单（`dsh.bundle.patch` 指向组合补丁） |
| `cordis.patch.yml` | 把 `growth-note` 插入 DSH 组合 |
| `lib/index.js` | 插件入口：注入摘要、注册工具、监听回合事件 |
| `lib/config.js` | 配置项、默认值与运行时校验（无外部依赖） |
| `lib/store.js` | 文件存储：条目、生成的 Markdown 视图、会话笔记 |
| `lib/prompt.js` | 生成注入系统提示词的「记忆摘要」 |
| `lib/tools.js` | 模型可调用的 `growth_*` 工具 |
| `lib/consolidate.js` | 回合结束的落盘 + 可选模型提炼 |
| `lib/util.js` | 分词、打分、文本处理等小工具 |
| `locale/{zh,en}.json` | 插件在 DSH 里的展示名称与简介 |
| `icon.svg` | 插件图标（原创） |
| `docs/DESIGN.md` | 设计说明：为什么这样分层、边界在哪 |
| `docs/MEMORY-FORMAT.md` | 记忆目录格式：文件职责与条目字段 |

## 安装

在 DSH 中把本目录作为本地 bundle 安装（推荐，安装后改代码立即生效）：

```text
plugin_manager action=install_bundle target=<本仓库绝对路径>
```

或者手动组合：在 profile 的 `cordis.patch.yml` 追加

```yaml
- insert:
    - id: growth-note
      name: '@ren-0208/dsh-growth-note'
      config:
        scope: global
```

安装后无需重启即可用；会话里问一句「现在记忆里有什么」并观察 `growth_status` 是否可调用即可确认。

## 用法

装好之后**不需要额外操作**：会话正常进行，插件在后台工作。

| 工具 | 作用 |
| --- | --- |
| `growth_remember` | 写入一条记忆（method / lesson / knowledge / wp / preference / state） |
| `growth_recall` | 按关键词检索记忆，拿细节 |
| `growth_config` | 查看/切换：全局 or 单工作区、个性化开关、提炼频率等 |
| `growth_status` | 查看范围、目录、条目统计、最近更新 |
| `growth_forget` | 删除过期或错误的条目 |

### 选择记忆范围

- **全局记忆**（默认 `scope: global`）：所有工作区共享一份成长记忆，路径 `$DSH_HOME/growth-note/global`。
  适合「跨项目的通用方法、读书笔记、个人偏好」。
- **单工作区记忆**（`scope: workspace`）：每个工作区各一份，路径 `<工作区>/.growth-note`。
  适合「只跟这个项目有关的状态、约定、踩过的坑」。

切换：

```text
growth_config(scope="workspace")
growth_config(scope="global")
```

切换只换指针，不搬数据：两边的记忆各自保留，切回去还在。

### 个性化匹配（可选，默认关闭）

打开后，插件会额外从对话里提炼「主人画像」（沟通风格、格式偏好、关注点、禁忌），
并在摘要里注入 `PERSONA.md`：

```text
growth_config(personalization=true)
```

只记录有证据的稳定偏好；写进画像的每条都应能在会话里找到依据，避免把一次性要求当成长期偏好。

### 成长面

- **读书 / 新闻 / 论文 / 课程** → `knowledge`
- **任何学科题目**（CTF、课程作业、专业资格题、面试题）→ `wp`，要求写清「题目 → 关键一步 → 弯路 → 可复用产物」
- **解决问题的方法与命令** → `method`
- **试过且失败的做法及原因**（否决清单）→ `lesson`
- **项目现状与下一步** → `state`
- **对主人的个性化适配** → `preference`（需开启）

### 自动沉淀怎么发生

1. 每个回合结束时，把本回合的「诉求 / 结论 / 调用的工具」写成一条会话笔记，追加到 `sessions/<会话id>.md`（不调用模型，零成本、失败也能留档）。
2. 每 `consolidateEveryTurns`（默认 6）个回合，用**当前会话自己的模型**把最近若干条笔记提炼成最多 6 条结构化记忆。
3. 提炼结果按 `kind` 写库并刷新 `MEMORY/*.md`。
4. 下一回合开始，摘要已经带上新条目。

模型不可用、超时或输出不是合法 JSON 时，只保留第 1 层笔记，不会报错打断会话。

## 配置项

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `scope` | `global` | `global` 全局共享 / `workspace` 单工作区 |
| `personalization` | `false` | 是否启用主人画像 |
| `autoCapture` | `true` | 回合结束是否写会话笔记 |
| `autoSummarize` | `true` | 是否调用模型提炼条目 |
| `consolidateEveryTurns` | `6` | 每多少回合提炼一次 |
| `promptBudgetChars` | `1800` | 注入提示词的摘要字数上限 |
| `maxEntries` | `3000` | 条目上限（超限先淘汰最久未用的非画像条目） |
| `sessionNotesPerConsolidation` | `6` | 每次提炼读取最近几条笔记 |
| `locale` | `zh` | 提炼提示词语言 |

运行时改动会写入 `$DSH_HOME/growth-note/settings.json`，重启后保持；bundle 里的 `config` 只提供初始值。

## 记忆目录长什么样

```text
<root>/
  AGENTS.md            入口说明（自动生成一次）
  memory.jsonl         权威数据：一行一条目
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
条目字段与「另一会话只看目录能否接着干」的判断标准见 `docs/MEMORY-FORMAT.md`。

## 隐私与边界

- 全部数据在本机文件系统，不上传任何第三方；提炼调用的是你已经在用的模型。
- 记忆里的内容会进入系统提示词，等于发给模型服务商，这与正常对话无异。
- 插件不读历史会话的全文，只读**当前会话**的事件流来写笔记；跨会话的经验靠落盘的记忆条目传递。
- 不做向量检索（零依赖），用关键词 + 汉字 bigram + 使用频次 + 新鲜度打分，够用且可解释。
- 记忆是「可修正的草稿」：与当前事实冲突时以事实为准，用 `growth_remember` 覆盖或 `growth_forget` 删除。

## 开发约定

- 分支：`main` 始终保持可运行；功能走 `feat/xxx`，实验走 `exp/xxx`，合并用 `--no-ff`。
- 提交：Conventional Commits（`feat:` `fix:` `docs:` `refactor:` `chore:`），中文正文，一次提交只做一件事。
- 换行：统一 LF，由仓库根 `.gitattributes` 约束。
- 零运行时依赖：只用 Node 内置模块，避免插件在用户环境里因为装包失败而不可用。

## 环境要求

- DSH（桌面版或命令行版均可），支持 Cordis bundle 插件。
- Node.js ≥ 20（插件用 ESM + 私有类字段；`engines` 已声明）。
- 无需安装任何依赖，无构建步骤。
- 语法自检：

  ```bash
  for f in lib/*.js; do node --input-type=module --check < "$f"; done
  ```
