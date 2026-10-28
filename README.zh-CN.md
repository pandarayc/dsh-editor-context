# dsh-editor-context

> **[English](README.md) · [中文](README.zh-CN.md)**

把「你正在 Cursor / VS Code 里看的那几行」变成 DSH 输入框里的一张 chip。

在输入框打 `@`，选**编辑器位置**，chip 落进你的草稿。发出去，模型收到文件与行区间：

```
@/data/project/qihuan/hallsrv/internal/logic/logic_purchase/limit.go#L146-L154
```

这就是全部功能。位置之所以进入对话，是因为**你把它写进了自己的句子**——没有任何
东西在你背后注入——所以不需要编号去区分，不需要开关去关闭自动注入，也没有任何配置。
你自己打出来的引用，不需要这些。

## 前置

- DSH 0.2.x，跑 web profile（`dsh web`）——在 `0.2.2-alpha.2` 上验证
- 编辑器半边：**Editor Context**，市场里的 `pandarayc.editor-context-bridge`
  （[链接](https://marketplace.visualstudio.com/items?itemName=pandarayc.editor-context-bridge)），
  0.5.0 以上。它负责写 `~/.editor-context/windows/*.json`，并在
  `~/.editor-context/endpoints/` 里公布本插件要拨的 WebSocket。

## 安装

```bash
dsh plugin --profile web add github:pandarayc/dsh-editor-context
# 或者用本地检出：
dsh plugin --profile web add /path/to/dsh-editor-context
# 然后重启 dsh-web —— 插件在进程启动时加载
```

包还没发到 npm，所以 `dsh plugin --profile web add dsh-editor-context` 现在解析不了；
在发之前用上面的仓库形式。

## 用法

在输入框打 `@`，菜单里会多一组**编辑器位置**，只有一行——你现在在哪：

```
@
├─ 编辑器位置
│    limit.go:146-154        hallsrv/internal/logic/…/limit.go
└─ reference
     src/…  tests/…  …
```

选中后 chip 落进草稿，是你句子的一个词：可以放在句子中间、可以改、可以删、可以不发
——它就是普通的草稿文本。回放历史里它同样是 chip。

chip 显示的是短标签（`limit.go:146-154`），但模型收到的是完整 token：发送前每个引用
都会经其属主的 codec 展开，所以模型拿到的是能直接打开的地址，不是一个标签。

| 你插入的 | 模型收到的 |
|---|---|
| `@<绝对路径>#L146` | 光标停在第 146 行 |
| `@<绝对路径>#L146-L154` | 选中了 146-154 行 |

**模型拿到的是绝对路径**：状态文件里的 `relativePath` 相对于**编辑器工作区**，和 agent
的工作目录通常不是一回事，`read` 打不开。

**为什么用 `#L`**：DSH 自带的文件规则把 `@` 后面到空白之前的一切当作路径，所以
`@path:12-34` 会被它连冒号一起吞进路径，变成两条规则争同一段文本。`#` 不在那个语法
里，这个 token 的归属因此是明确的；而 `#L` 又是模型从代码托管平台早就熟悉的行号写法。

## 从编辑器直接发，不用切窗口

同一个位置也可以在 Cursor / VS Code 里送出来：编辑器标题栏上的 **Add to Bot**。
点下去 chip 就出现在你的草稿里，所以你可以连着指三处，然后用一句话一起问。

```
Cursor：在 limit.go:146-154 上点 Add to Bot
   ↓  扩展通过自己的 WebSocket 推一帧 delivery
   ↓  本插件已经连着，同一 tick 收到
   ↓  你打开的标签页上挂着一个 parked 长轮询，它醒来并插入
DSH 输入框：[limit.go:146-154]  ← 已在草稿里，未发送
```

扩展是 WebSocket **服务端**，本插件是**客户端**。这个方向不是随便定的：Node 自带
WebSocket 客户端但不带服务端，所以需要依赖的那一半正好是住在 VSIX 里的扩展——这也是
本插件至今**一个依赖都没有**的原因。

两跳都不是定时器。编辑器推送；插件的长轮询一直挂着，直到有东西要交给浏览器。空闲会话
是一个打开的 socket 加一个挂起的响应，不是每秒一次请求。

投递里除了地址和行区间**还带文本**。投递是快照不是指针：指针在文件被编辑、移动、回滚的
那一刻就失效了，然后 agent 在推理已经不存在的代码。

## 配置

```yaml
- id: editor-context
  name: dsh-editor-context
  config:
    # stateDir: "~/.editor-context"   # 编辑器扩展发布状态的目录
    # maxAgeSeconds: 3600             # 超过这个时间的读数视为过期
    # http: false                     # 关掉整个功能
    # httpPath: /editor-context/position
```

插件在 DSH 的 web server 上挂三条只读路由——`GET /editor-context/position`（当前读数）、
`GET /editor-context/next`（长轮询）、`GET /editor-context/editors`（连上了哪些编辑器窗口），
浏览器半边靠它们拿读数。返回的是地址与行区间，**不含文件内容**。被扩展 `excludeGlobs`
排除的路径返回 404——排除规则不会泄露它本想藏起来的那个路径。

这些路由在 DSH 的 SPA 兜底之前匹配，因此**不额外鉴权**。它的定位是本机（默认如此）；
`http: false` 可以整个去掉。

## 排查

| 现象 | 查什么 |
|---|---|
| 打 `@` 没有**编辑器位置**这一组 | `cat ~/.editor-context/windows/*.json`——没有文件说明扩展没装或没激活 |
| 有这一行，但位置是旧的 | 读数超过了 `maxAgeSeconds`；在编辑器里动一下光标 |
| 某些文件里没有这一行 | 命中扩展侧的 `editorContext.excludeGlobs`。这是有意为之：连路径都不发布 |
| 完全没反应 | `curl -s http://127.0.0.1:3080/editor-context/editors`——没有行说明没有编辑器连上；`refused` 状态会写明原因 |

## 已知限制

- **路径含空格需要引号形式**：`@"a b.go"#L12`。解析规则支持，候选列表目前还产不出这个形态。
- **点 chip 不会跳回编辑器。** 编辑器扩展只写文件，没有反向通道。
- **排除规则在扩展侧配置**，不在这里。插件自己没有任何规则，也不需要：它只能提供扩展
  愿意发布的东西。

## 目录

```
lib/state.js       位置文档：一套 schema，一个解析器
lib/registry.js    host：哪些编辑器窗口在公布端点、在哪
lib/link.js        host：每个窗口一个订阅者，按 registry 对账
lib/subscribe.js   host：拨通某个编辑器窗口的 WebSocket 客户端
lib/deliveries.js  host：那条 socket 与浏览器之间的队列
lib/http.js        host：三条只读路由，纯函数、可单测
lib/index.js       host：挂路由 + token 语法提示段
lib/client.js      浏览器：@ 候选源 + UserText 规则 + chip 组件 +
                   把编辑器送来的位置插进草稿的 intake
```

这是**双面包**：host 半边跑在 DSH 进程里，浏览器半边由 DSH 的 client module 系统按
`dsh.client` 声明喂给页面。浏览器半边是手写的、没有构建步骤，只 `import` 了 `react`；
跨包一律走 cordis service（`ctx.inputTriggers` / `ctx.uiConversation` / `ctx.slots`）。

```bash
npm test    # 82 passed
```

七个文件：`test/editor-context.test.mjs`（读取端、配置、`apply` 到底注册了什么）、
`test/http.test.mjs`（三条路由与浏览器载荷）、`test/deliveries.test.mjs`（队列）、
`test/subscribe.test.mjs`（socket 客户端，对着假 socket）、`test/registry.test.mjs` 与
`test/link.test.mjs`（发现与成员对账）、`test/client.test.mjs`（**加载真实 bundle**，
用假的 `window.__ModuleLoader__` 与 `require`，断言的是要发出去的字节）。

关于「为什么这个插件不可能往对话里塞东西」「它以前塞过什么」，以及客户端那三个容易
踩的点：[docs/internals.md](docs/internals.md)。

## License

MIT
