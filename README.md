# dsh-diction（遣词造句）

**English** — Teaches the agent how *you* talk. You fill in ten scenes (late-night chat with an old friend, a coworker asking about something small, a family member asking when you'll be home…), writing what you would actually say in each. Every turn, those samples are injected as a style layer: how sentences start and end, whether you use written language, how you address people, how heavy the tone is. It only changes delivery — not personality, not judgement, not decisions. Up to 20 scenes; edit, add and delete them on the plugin's detail page, no restart needed.

让 AI 说话像你。

你写下「他这么说 / 我这么回」的对话，插件每轮把这些原话注入提示词，让模型的句子起头、收尾、称呼、语气轻重都往你的说法上靠。

**只管怎么说。** 人格、立场、判断一概不从这里来——这是它和人格插件的分界，也是插件里写死的那句边界。

## 安装

```powershell
dsh plugin add https://github.com/Muninn-and-Zmx/dsh-diction
```

装完重启一次 DSH。之后填对话在「设置 → 插件 → 遣词造句」的详情页里，保存后下一句消息就生效，不用重启。

## 它做什么

- **常驻一层**：每轮组装提示词都带着这些对话，不是只在第一句生效。
- **一开始是空的**：不预设任何对话。你想到哪段就添哪段，最多 20 条。
- **直接读原话**：不做「提炼成风格摘要」——中间过一道模型会失真，原话最像你。
- **开启即严格执行**：模仿这些说话方式，尽可能贴近样本；无相似样本时按已有样本推想怎么说才合样本的风格，不留「按原本方式说」的退路。

## 它不做什么

- 不改人格、不改判断、不改它做什么决定。
- 不规定说什么、说多长——那是语气层、人格卡、语言账本的事。
- 不联网、不上传：对话只存在本地 `$DSH_HOME/dsh-diction.json`。

## 面板里怎么填

上面是对话样本，一句话一行：

| 字段 | 填什么 |
| --- | --- |
| **场景** | 什么场合，可以留空 |
| **关系** | 你和他是什么关系，可以留空 |
| **A** | 你听到的那一句——对方说的话，或者一个场合里砸过来的那句 |
| **B** | 你会怎么接 |

**就用你平时会说的那种话写，不用润色。** 场景和关系都可以留空；填了只是让这条样本更具体，别写得太满。真正被学的还是 A 和 B——那是你自己写下来的原话。

一开始是空的，点上面的「＋ 添加对话」就多一条；右上角「×」删掉；最多 20 条，满了按钮会灰掉。

## 注入怎么算

- 关掉开关 → 整段消失。
- 一条对话都没填、禁令也是空的 → 整段消失（不占每轮 token）。
- 只取**有回答**的条目，按面板顺序拼。
- 单条回答注入时最多 500 字，超了加「…」；全段预算 8000 字，超了停并在末尾写明还剩几条没展开。
- 段名 `diction`，顺序排在言外之意之后——先听清，再决定怎么说。

## 禁令：什么说法一律不要

样本说「像这样」，禁令说「别那样」。面板下半部分是禁令表：默认空，可以一直加，**不设条数上限**。

写法有两种记号：

| 写法 | 意思 |
| --- | --- |
| `不是…而是…` | 中间可以隔几个字（最多 20 个），「不是」后面那段出现就算犯 |
| `首先/其次/综上` | 三个词任选其一，出现任何一个就算犯 |
| `波浪号` | 纯字面匹配 |

禁令会跟着对话一起进提示词，作为提醒。

**它只看，不拦。** 每一轮说完，插件把这一轮正文过一遍；命中哪条就记一笔（哪一组、哪条、原话片段），不退回、不重写，已经说出去的话不会再被拽回来。记下来的东西摆在面板的「最近命中」里，由你自己判断是改禁令还是补样本。

- 同一轮只查一次；同一条规则在一句里出现多次，只留一条记录、另标次数（×3）。
- 最多留最近 50 条，长期跑也不会越积越多；面板上有「清空记录」。
- 只查正文，工具调用和图片不算。
- 下一轮开口前会提一句「上一轮有内容踩到禁令」，只是提醒，不用回头改。
- 忘了删的禁令不会影响你说话，只会让面板多几条记录；不想要了就在面板上点 ×。

## 数据

`$DSH_HOME/dsh-diction.json`（默认 `~/.dsh/dsh-diction.json`）：

```json
{
  "version": 1,
  "enabled": true,
  "conversations": [
    { "id": "c-1", "a": "在吗", "b": "嗯，刚回来。" }
  ],
  "bans": { "word": [], "pattern": [], "tone": [] }
}
```

一开始是空的，不预设任何对话；删掉的不会复活。文件坏掉不覆盖，退回空表并在日志里 warn 一次。

## 和「言外之意」一起用

- **言外之意（dsh-subtext）**管怎么**听**：这句话底下还有一层什么。
- **遣词造句（dsh-diction）**管怎么**说**：说出来的句子像谁。

两个都装上不冲突：一个在听那边让位给工作档，一个只管输出风格。

## 卸载

```powershell
dsh plugin remove dsh-diction
```

数据文件不会自动删，留着下次装回来还能接上。

作者：穆宁 / 烛梦曦 · MIT
