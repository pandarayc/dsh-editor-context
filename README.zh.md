# dsh-editor-context
> **[English](README.md) · [中文](README.zh.md)**

把「你正在 Cursor / VS Code 里看的那几行」变成 DSH 输入框里的一张 chip。

在输入框打 `@`，菜单里会多一组**编辑器位置**；选中后草稿里出现一张 chip，发出去模型收到完整的地址与行区间：

```
@/data/project/work/qihuan/src/fancygame/hallsrv/internal/logic/logic_purchase/limit.go#L146-L154
```

**它是你打的字，不是插件塞进对话的消息。** 这条区别是这版的重点——被塞进去的消息必须靠编号和措辞去和你说的话区分，而 chip 就是你句子的一个词：可以放在句子中间、可以改、可以删、可以不发。

配套的编辑器扩展是 [`vscode-editor-context`](https://github.com/pandarayc/vscode-editor-context)：扩展在编辑器侧把当前位置写成状态文件，本插件是 DSH 侧的读取端。

---

## 为什么不是「自动注入」

第一版走的是 hook + 自动注入，结论是**在高频移动光标的工作方式下它必然退化成污染**：

- hook 只在**你发消息时**触发（实测 `UserPromptSubmit` 调用数 = 回合数，不是光标移动数），
- 但去重键是「精确位置」，你光标动得多 → 几乎每轮的位置都和上轮不同 → **去重失效**，
- 于是**每个回合往会话历史里追加一条 durable user 消息**。

一句话：**高基数去重键 ≈ 没有去重**。

第二版改成显式推送（`/ide` 插入一条编号标记）。它解决了污染，但没解决语义——标记仍是「另一个人替你说话」，插三次就得靠 `#1 #2 #3` 去分。

第三版，也就是现在这版，把引用变成**你打出来的文本**。编号不再需要，因为位置本身就在句子里。

## 全部通道对比

| 机制 | 谁触发 | 行号 | 落到哪 | 污染 |
|---|---|---|---|---|
| hook `additionalContext` | 平台每轮 | ✅ 文本 | durable user message | ❌ 每轮/每次变化 |
| **`@` → 编辑器位置**（默认，本插件） | 你显式 | ✅ 结构化 | **你自己消息里的 chip** | ✅ 零 |
| `/ide` 编号标记（可选，`mode: on-demand`） | 你显式 | ✅ 文本 | durable context 卡片 | ✅ 低 |
| `@path 第 A-B 行`（手打） | 你显式 | ⚠️ 裸文本 | 你的消息 | ✅ 零 |
| MCP `open_at_range`（**未实现**） | 模型/用户 | ✅ | UI 动作 | ✅ 零 |

## 安装

```bash
dsh plugin --profile web add /path/to/dsh-editor-context
# 重启 dsh-web
```

前置：`vscode-editor-context` 扩展已在编辑器侧运行（状态写在 `~/.editor-context/windows/*.json`）。

插件是**双面包**：host 半边跑在 DSH 进程里，浏览器半边由 DSH 的 client module 系统按 `dsh.client` 声明喂给页面。同一个包，两面。

## 用法

在输入框打 `@`，选**编辑器位置**。插入的文本形如：

```
@<绝对路径>#L146        光标停在第 146 行
@<绝对路径>#L146-L154   选中了 146-154 行
```

模型侧的行为由一段系统提示保证（`order: 910`，紧跟 DSH 自带的 `@` 文件引用说明）：

> An editor-position token has the form `@<path>#L12` or `@<path>#L12-L34`: the path is everything before `#L` … Read that path (never the whole token) when the contents matter.

**为什么用 `#L`**：DSH 自带的文件规则把 `@` 后面到空白之前的一切当作路径，所以 `@path:12-34` 会被它连冒号一起吞进路径、变成两条规则争同一段文本。`#` 不在那个语法里，这个 token 的归属因此是明确的；而 `#L` 又是模型从代码托管平台早就熟悉的行号写法。

**为什么是绝对路径**：状态文件里的 `relativePath` 是相对于**编辑器工作区**的，和 agent 的工作目录通常不是一回事，`read` 打不开。

## 配置

```yaml
- id: editor-context
  name: dsh-editor-context
  config:
    http: true                       # chip 通道总开关，默认开
    # httpPath: /editor-context/position
    mode: off                        # push 通道，默认关
    # stateDir: "~/.editor-context"
    # maxAgeSeconds: 3600
    # commands: [ide, here]          # mode: on-demand 时才用到
```

### 两个通道互相独立

**chip 通道**（`http`，默认开）——挂一条只读路由 `GET /editor-context/position`，浏览器半边据此提供候选。不往会话里写任何东西。

> 路由**不额外鉴权**：DSH 的 `webServer` 先匹配已注册路由，鉴权在 SPA 兜底上。所以它只应该监听在本机（默认如此）。返回的是地址，**不含文件内容**；被 `excludeGlobs` 排除的路径返回 404，不泄露它本想藏起来的路径。

**push 通道**（`mode`，默认 `off`）——`on-demand` 注册 `commands` 里的 slash 命令，`selection` 再加「非空选区变化」时自动推一条。推的是**编号地址标记**，不是叙述：

```
[编辑器位置 #2 · Cursor 插入标记]
绝对路径：/data/project/.../trigger_gift.go
工作区相对路径：hallsrv/internal/logic/logic_trigger_gift/trigger_gift.go
选中第 132-136 行（共 5 行）；需要内容时 read offset=132 limit=5。
```

编号在**会话内**递增并按 session projection 持久化，**跨重启延续**——进程内计数器重启后会从 `#1` 重来，那正是编号想消除的歧义。落进会话时 `source.form` 是 `snapshot`，GUI 因此把它渲染成折叠的 context 卡片。

自动推只认**非空选区**：裸光标不是一次刻意的动作。

## 实现要点

```
lib/http.js    host：只读位置端点（纯函数，可单测）
lib/index.js   host：挂路由 + 语法段 + 可选的 push 通道
lib/client.js  浏览器：@ 候选源 + UserText 解析规则 + chip 组件
```

浏览器半边是**手写**的，没有构建步骤：

```js
window.__ModuleLoader__.load({ id: 'dsh-editor-context', factory: (require) => { … } });
```

跨包一律走 cordis service（`ctx.inputTriggers` / `ctx.uiConversation` / `ctx.slots`），只 `require('react')`——这是所有 client bundle 的共同做法。

三个容易踩的点，都是实测出来的：

1. **插入要走 `{insert}` 而不是 `{text}`。** 两者不等价：`{text}` 落进的是普通字符，只有命中某个源通过 `lexicon` 发布的名单才会被装饰，而且 chip 会显示整个名字；`{insert}` 造一条 reference 记录，自带 `label`，chip 才能显示短标签。
2. **reference 源必须带 `codec`。** 发送前每个 chip 都要经其属主的 codec 展开成模型形态，属主没有 codec 时 `serializeReference` **直接拒绝整条提交**，不会降级。
3. **节点规则要抢在自带 `file` 规则前面。** 规则按 `order` 升序排、同起点靠前者胜，自带的 `file` 是 30，所以这里是 20。

chip 在**历史消息**里也成立：回放走的是 `UserText` 规则重新解析原文，和 composer 的 reference 节点无关。两条路都能得到 chip。

## 为什么零依赖

插件通过 `link:` 安装，真实路径不在 profile 的 `node_modules` 里，裸导入 `@deepseek-ai/*` 解析不到。所以需要的几个构造器被内联（它们本来就是 `deepFreeze(structuredClone({...}))` 三行）。

可选服务一律用 `ctx.inject([...], cb)` 而不是 `ctx.get()`：挂载顺序不归我们决定，服务可能在本插件之后才就绪，`apply` 时 `ctx.get()` 会读到 `undefined` 并**静默降级**。拿不到服务只是不注册对应功能，不会让插件挂载失败。

## 测试

```bash
npm test
# 45 passed
```

三个文件：`test/editor-context.test.mjs`（push 通道与配置）、`test/http.test.mjs`（端点）、`test/client.test.mjs`（**加载真实 bundle**，用假的 `window.__ModuleLoader__` 与 `require`，断言的是要发出去的字节）。

客户端那一份能抓到静态检查看不见的问题——比如漏掉 module wrapper（浏览器里同样会炸）、漏掉 codec（只有点下去才报错）。

## 已知限制

- 路径含空格时 `@` 需要引号形式（`@"a b.go"`），规则支持解析，但候选目前只产出无引号形态。
- 点 chip 不会跳回编辑器：`vscode-editor-context` 只写文件，没有反向通道。要跳转需要一个入站接口，尚未实现。
- `excludeGlobs` 在**编辑器扩展**侧配置，插件侧没有独立的排除规则。
