# dsh-editor-context：composer chip 设计记录

> **状态：已实现并验证（v0.3.0）。**
>
> 这份文档是按时间顺序写的，保留了当时的判断和推翻过程，所以**读的时候请注意层次**：
>
> - **§12 是最终设计**，对应当前代码。要理解这个插件怎么工作，读 §12 就够。
> - **§11** 是 alpha.3 与 alpha.2 的逐字节接口差异，是 §12 的依据。里面那些"从 tarball 逆出来的接口"现在都能在装好的包里直接读到。
> - **§0–§10 是历史**：那是 alpha.2 时期的方案，其中 §5/§6 已被 §12 取代（开头有标注）。保留它们是因为记录了一次真实的推翻——最初的方案要手搓 chip 管道，alpha.3 的 `UserText` 机制让它变成了"插文本 + 注册规则"。
>
> 文中若干处仍写着"未施工""step 0 待验"，都是当时的状态。实际施工中新增了两条不在原计划里的约束，见 §12.9：
> **插入必须走 `{insert}` 而不是 `{text}`**，以及 **reference 源必须带 `codec`**——两者都只有在浏览器里点下去才会暴露。


---

## 0. 要解决什么

现在的 `/ide` 走**推**模型：往会话里塞一条 `role: user` 的 context 消息。这有两个结构性毛病：

1. **它必须自我声明。** `role` 只有 `user` 一种可用（`tmux-context` 也这样），所以标记只能靠文本区分"这是插入的、不是你说的"。这正是你说的"对话语义有问题"。
2. **它无法表达"插在句子中间"。** 消息只能整条落在你的话之前，所以你插 3 次就得靠 `#1 #2 #3` 补丁去区分——编号是在给推模型擦屁股，不是在解决问题。

Cursor 的 "Add to Chat" 走的是**插**模型：引用进你的草稿，成为你句子的一部分。位置本身就是消歧，不需要编号。

**目标**：让 DSH 输入框能插入 `@hallsrv/.../limit.go (165-185)` 这样的引用，落在光标处，是你句子的一部分。

**非目标**：删掉 `/ide`。推模型在"不想打字"和 `selection` 自动模式下仍然有用（那时编号是必需的）。

---

## 1. 已验证的接口事实

### 1.1 输入框有一个公开的 action face

出处：`dsh-client-ui-conversation/lib/client.js:18262-18320`（`SessionInputShell`）

> The per-session input facade: scoped-event application verbs + setDraft/submit + the published InputState store, over a shell-owned Lexical editor.

```js
// The public provide-channel action face (one stable identity per session).
actions = {
  captureInsertion: () => ({ ...this.caretSpan(), draftRev: this.rev }),
  insertText: (text, span) => {
    if (phase === "adjudicating" || phase === "submitting" || disposed) return false;
    if (span.draftRev !== this.rev) return false;   // 版本失配就拒绝
    return this.draftEditor.insertAsyncText(span, text);
  },
  setDraft: (text) => this.setDraft(text),
  persistDraft, addAttachments, removeAttachment, pruneAttachments, submit, ...
}
```

`setDraft` 吃的是**语义文档**，不只是纯文本（`18370`）：

```js
setDraft(text) {
  const draft = resolveDraftInput(text);
  if (draft.references.length === 0) this.draftEditor.setDraft(draft.text);
  else this.draftEditor.restoreDraft(draft.text, draft.references);   // 真 chip
}
```

**现成先例**：`dsh-experimental-client-ui-voice-input/lib/client.js:5095,5198` —— 语音转写结果就是这么插进草稿的：

```js
inputActions.insertText(pending, inputActions.captureInsertion())
```

### 1.2 输入框槽位暴露 `inputActions`

出处：`dsh-client-ui-conversation/lib/client.js:22042-22056`

> The default composer body: the 'conversation.composer.bar' slot entry. Machine state arrives through the standard provide channel (**useInput + inputActions**)……

```js
const InputBar = React.memo(function InputBar({ useSession, useInput, inputActions, keyboard, ... })
```

可用槽位（`grep slots.inject` 结果）：`conversation.composer.bar`、`conversation.content`、`conversation.header`、`conversation.input.dock`、`conversation.session`、`conversation.session.header`。

### 1.3 `@` 是一个可注册的触发源，而且有完整样例

出处：`dsh-client-ui-reference/lib/client.js:150-235` —— 这就是 DSH 自己的 `@` 文件引用源，是我要照抄的模板。

```js
const source = {
  trigger: "@",
  name: "reference",
  showGroupTitle: false,
  async candidates(session, { query, quoted, drilled, signal }) {
    const fileLookup = ctx.remote.fileReferences.list(session.sessionId, query, signal)
      .then((result) => result.ok ? result.value : []);
    ...
  },
  header(_session, req) { ... },
  onPick({ candidate, action }) {
    return { insert: {
      source: "reference",
      ref: value.mention,          // ← 模型看到的 mention 串
      label: value.label,          // ← chip 上显示的字
      appearance: "file",
      clipboardText: value.mention,
    } };
  },
  openReference(session, { ref, appearance }) { ... },   // 点 chip 跳转
  codec: { clipboardText: (ref) => ref, serialize: (ref) => Promise.resolve(ref) },
};
ctx.effect(() => inputTriggers.registerSource(source), "ui-reference: @ source");
```

服务：`InputTriggerService`（`dsh-client-ui-input-trigger/lib/client.js:1512`），`super(ctx, "inputTriggers")`，方法 `registerSource(src)`。同名同 trigger 重复注册会抛。

**含义**：我可以注册**第二个 `@` 源**，让"当前位置"作为 `@` 菜单里的一个分组出现，不新增按钮、不改布局。

### 1.4 宿主有 HTTP 路由注册接口（这是数据面的关键）

出处：`dsh-host-webserver/lib/index.js:270-316`

```js
super(ctx, "webServer");
register(route) {          // route.kind: "exact" | "prefix"
  const table = route.kind === "exact" ? this.exact : this.prefixes;
  if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
  table.set(route.path, route);
  return () => { table.delete(route.path); };
}
```

**这比 RPC 简单一个数量级。** 另一条路是 Typert remote（见 §7.3），但那条要在 host 插件里 `import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol"`——而本插件是 `link:` 安装，裸 `@deepseek-ai/*` 导入解析不到，得把依赖 vendor 进插件目录，还要手写 `@Remote` 的装饰器编译产物（Node 22 没有原生装饰器）。**HTTP 路由不需要任何 import**：`ctx.get('webServer')` 就够了。

### 1.5 client 插件包是手写得了的

出处：`dsh-client-modules/lib/index.js:170-181, 712-728`；`dsh-experimental-client-ui-voice-input/package.json`

声明：

```json
"dsh": { "client": {
  "platform": "web",
  "inject": ["@deepseek-ai/dsh-client-ui-input-trigger", ...],
  "external": [...]
} }
```

包必须暴露 `exports["./client"]` 指向 bundle，否则报错：

> `client-modules: ${packageName} declares dsh.client but exports no "./client" bundle`

bundle 就是一个自注册脚本（`head -c 600` 实测）：

```js
window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-experimental-client-ui-voice-input",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    let react = require("react");
    let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    ...
  }
});
```

**没有构建工具链也能写**——不需要 tsdown，不需要 DSH 源码树（本机装的是预构建包，没有 `apps/web`）。

---

## 2. 架构

```
┌─ Cursor ──────────────┐        ┌─ DSH host (dsh-web) ──────────────────────┐
│ editor-context 扩展    │        │  dsh-editor-context (已有插件，加一条路)   │
│  写 ~/.editor-context/ │───────▶│   GET /editor-context/position            │
│  windows/<pid>.json   │  文件   │     → 现成的 readPosition() → JSON        │
└───────────────────────┘        └───────────────┬───────────────────────────┘
                                                 │  HTTP (同源 fetch)
┌─ 浏览器 ────────────────────────────────────────▼───────────────────────────┐
│  dsh-editor-context-client (新包，手写 bundle)                              │
│    ctx.inputTriggers.registerSource({ trigger: "@", name: "editor-position" })│
│      candidates() → fetch('/editor-context/position') → 候选行               │
│      onPick()     → { insert: { ref: "@<path> (A-B)", label, appearance } }  │
│                          ↓                                                  │
│                    composer 里的 chip，落在光标处                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

**为什么不让 client 直接读文件**：`~/.editor-context/` 在宿主文件系统上，浏览器碰不到。同源 HTTP 是最短的那条线。

---

## 3. 文件级改动清单

### 3.1 改：`dsh-editor-context`（已有 host 插件）

| 文件 | 改动 |
|---|---|
| `lib/index.js` | 加 `registerHttpRoute(ctx, stateDir, maxAgeMs)`；`apply` 里用 `ctx.inject(['webServer'], ...)` 挂上。纯增，不动现有 `/ide` 与 `selection` 逻辑 |
| `lib/http.js`（新） | 路由 handler：`readPosition` → 选好字段 → JSON。抽出来是为了能单测 |
| `test/http.test.mjs`（新） | 用 fake `webServer.register` 断言路由形状、404 语义、排除路径不出门 |
| `cordis.patch.yml` | 加 `httpPath: /editor-context/position`、`httpEnabled: true` |
| `README.md` | 补一节"给 composer 用的只读端点" |

### 3.2 新增：`dsh-editor-context-client`

```
dsh-editor-context-client/
├── package.json          ← dsh.client 声明 + exports["./client"]
├── lib/client.js         ← 手写 __ModuleLoader__.load bundle（本方案唯一的"新形态"）
├── lib/index.js          ← host 半边：空壳（client-only 插件也要有 main）
├── test/client.test.mjs  ← 用假 require / 假 inputTriggers 断言候选与 onPick 返回值
└── README.md
```

**注意**：`dsh-client-modules` 扫描的是**宿主 Loader 的条目**里声明 `dsh.client` 的包。client-only 包是否需要一个能挂载的 host 半边、`link:` 安装能否被扫到，是 §8 的 step 0-4。

### 3.3 不动

- `editor-context` 扩展（TypeScript）：它只管写状态文件，位置格式没变。
- `~/.dsh/hooks/hooks.json`：已经干净。

---

## 4. host 半边：HTTP 路由（骨架）

```js
// dsh-editor-context/lib/http.js —— 骨架，未实现
/**
 * Read-only position endpoint for the browser-side composer source.
 * Same-origin fetch only; the reading is already published to the filesystem,
 * so this exposes nothing the local user cannot already read.
 */
export function createPositionHandler({ stateDir, maxAgeMs, path }) {
  return {
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
      const position = await readPosition(stateDir, maxAgeMs);
      if (position === undefined || position.context === '') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({
        ok: true,
        absolutePath: position.activeFile,
        relativePath: position.relativePath,
        appName: position.appName,
        selection: position.selection,      // {startLine,endLine,isEmpty} | null
        updatedAt: position.updatedAt,
      }));
    },
  };
}
```

```js
// dsh-editor-context/lib/index.js —— apply 里的增量
ctx.inject(['webServer'], (scoped) => {
  const handler = createPositionHandler({ stateDir, maxAgeMs, path: httpPath });
  scoped.effect(() => scoped.webServer.register(handler), 'editor-context: position route');
});
```

**要点**

- `ctx.inject` 而不是 `ctx.get`：挂载顺序不归我们决定（和计数器那次同一个理由）。
- `cache-control: no-store`：位置是实时的，不能被缓存。
- 排除规则（`context === ''`）返回 404，**不泄露被排除的路径**。
- 不返回文件内容，只返回地址。

---

## 5. client 半边：`@` 触发源（骨架）

> **⚠ 本节已被 §12 取代。** alpha.3 引入了 `UserText` 机制，"插入 chip"变成了"插入文本 + 注册解析规则"。本节的候选列表部分仍然有效，chip 部分作废。以 §12 为准。

```js
// dsh-editor-context-client/lib/client.js —— 骨架，未实现
window.__ModuleLoader__.load({
  id: 'dsh-editor-context-client',
  factory: (require) => {
    const name = 'editor-context-client';
    const inject = ['inputTriggers', 'locale'];   // 与 package.json 的 dsh.client.inject 对齐

    const ENDPOINT = '/editor-context/position';

    /** 把一次读数变成候选行：选区优先，其次光标。 */
    function rowsFrom(reading) { /* ... 未实现 ... */ }

    function apply(ctx) {
      const source = {
        trigger: '@',
        name: 'editor-position',        // 与 name:"reference" 共存，不冲突
        showGroupTitle: true,
        order: 50,                      // 排在文件引用之后
        async candidates(session, { signal }) {
          const response = await fetch(ENDPOINT, { signal, cache: 'no-store' });
          if (!response.ok) return [];  // 编辑器没开 / 位置过期，就是一个空分组
          const reading = await response.json();
          return rowsFrom(reading);
        },
        onPick({ candidate }) {
          return { insert: {
            source: name,
            ref: candidate.ref,                       // 模型看到的串，含行号
            label: candidate.label,                   // chip 上显示的字
            appearance: 'file',
            clipboardText: candidate.ref,
          } };
        },
        openReference() { return false; },            // 没有"打开"动作，见 §7.2
        codec: {
          clipboardText: (ref) => ref,
          serialize: (ref) => Promise.resolve(ref),
        },
      };
      ctx.effect(() => ctx.get('inputTriggers').registerSource(source),
        'editor-context-client: @ source');
    }

    return { name, inject, apply };
  },
});
```

```json
// dsh-editor-context-client/package.json —— 形态骨架
{
  "name": "dsh-editor-context-client",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js"
  },
  "dsh": { "client": {
    "platform": "web",
    "inject": ["@deepseek-ai/dsh-client-ui-input-trigger", "@deepseek-ai/dsh-client-locale"]
  } }
}
```

---

## 6. 关键设计选择

### 6.1 插什么串

| 方案 | 模型看到 | chip 显示 | 评价 |
|---|---|---|---|
| `ref = '@path (165-185)'` | `@path (165-185)` | 同上 | **推荐**。`@` 让模型认路径，行号作为紧邻文本被理解为范围 |
| `ref = '@path:165-185'` | `@path:165-185` | 同上 | ❌ 会被当成一个叫 `path:165-185` 的文件（`@` 语法只认路径，无 `#L` 处理） |
| `ref = '@path'` + 正文另行说明 | `@path` | `@path` | ❌ 行号丢了——这正是 chip 相对 `/ide` 的优势 |

**绝对路径 vs 工作区相对路径**：chip 的 `ref` 用**工作区相对路径**（可读、和 Cursor 一致），但候选行里可以带上绝对路径供 `/ide` 那类场景复用。注意 agent 的 cwd 通常不是编辑器工作区根目录——`read` 打不开相对路径。**这一条要在 step 0 验证**：模型拿到 `@hallsrv/...` 到底能不能读到文件（现在 `/ide` 的标记里两条路径都给，是绝对路径在救场）。

如果验证下来相对路径读不到，退路是 `ref = '/abs/path (165-185)'`（`@` 语法接受绝对路径）。

### 6.2 要不要保留 `/ide`

**保留**，理由：

- 不想打字时 `/ide` 更快（不用敲 `@` 再选）。
- `selection` 自动模式没有 composer 对应物——它本来就是"你没说话时也提醒我"。
- 编号在推模型下是必需的，不是白做工。

两种模型并存时，编号只在推模型侧出现，插模型侧靠句子位置消歧，不会互相干扰。

### 6.3 为什么不走 Typert remote

见 §1.4。概括：要 vendor 依赖 + 手写装饰器产物，而 HTTP 路由零依赖、零 import、同源即可。代价是少了类型化的 `{ok, value}` 信封，但一个只读端点不需要。

---

## 7. 施工前必须验证的 6 件事（step 0）

按"验证成本从低到高 / 阻塞度从高到低"排序。**任何一条失败都会改设计，所以先做这一步再写实现。**

| # | 要验证 | 怎么验 | 失败的话 |
|---|---|---|---|
| 0-1 | `webServer.register` 的路由**要不要 token/授权** | 宿主插件挂一条 `GET /editor-context/ping` 返回 `{ok:true}`，重启后 `curl -i http://127.0.0.1:3080/editor-context/ping` | 要么客户端带上 `window.__DSH_BOOT__` 里的 token，要么回退到 Typert remote |
| 0-2 | `@` 源能不能**共存**：新源 + 内置 `reference` 源同时在 `@` 菜单里 | 挂一个返回固定候选的源，手测 `@` | 改用 composer bar 按钮（选项 B），放弃 `@` 集成 |
| 0-3 | 手写 bundle 能不能被加载：`link:` 包 + `dsh.client` 声明 + `exports["./client"]` | 挂一个 `console.log` 版最小 client 包，重启后看浏览器控制台 | 需要走 DSH 源码构建（本机没有源码树）→ 该路线作废，回到选项 D |
| 0-4 | 模型拿到 `@hallsrv/.../limit.go (165-185)` 能不能 `read` 到文件 | 手打一条含该串的消息，看模型行为 | `ref` 改绝对路径 |
| 0-5 | `onPick` 返回的 `{insert: {source, ref, label, appearance}}` 里 `appearance` 的合法取值 | 读 `dsh-client-ui-conversation` 里 chip 的分派逻辑 | 退到 `insertText()` 纯文本插入（少了 chip 外观，但语义已达成） |
| 0-6 | `codec.serialize(ref)` 的返回值是不是**模型实际看到的串** | 对照 `dsh-client-ui-reference` 的 `@path` 行为 | 调整 `ref` 构造 |

**0-3 是唯一的"生死线"**：如果没有源码树就加载不了 client 插件，那么整条 composer chip 路线不成立，应当回到选项 D（纯 host 插件 + `/ide` 编号）。

---

## 8. 风险与回退

| 风险 | 影响 | 回退 |
|---|---|---|
| client 插件需要重建 web 产物 | 路线作废 | 选项 D：保持纯 host 插件 |
| 路由需要授权 | 多一步 token 传递 | 客户端从 `window.__DSH_BOOT__` 取 token 带上 |
| `@` 菜单分组拥挤 | 体验变差 | 把源 `order` 调后，或只在编辑器活着时注册 |
| 双模型（推 + 插）让用户困惑 | 认知负担 | 文档写清：想插进句子用 `@`，不想打字用 `/ide` |
| 引入第二个包，安装/升级变复杂 | 维护成本 | 接受；两者版本独立 |

**回退成本**：host 侧改动是纯增（一条路由 + 一个配置项），删掉即可；client 包是新包，删掉即回到现状。**没有破坏性改动**。

---

## 9. 里程碑

| 阶段 | 产出 | 验收 |
|---|---|---|
| M0 | step 0 六项验证 | 全部有明确结论，写回本文档 |
| M1 | host 路由 + 单测 | `curl` 拿到 JSON；`node --test` 通过 |
| M2 | client 包最小版（固定候选，不接端点） | 浏览器里 `@` 能出现一个新分组 |
| M3 | 接端点 + `onPick` 插真 chip | 选中后草稿出现 `@path (A-B)`，能发出去、模型能读 |
| M4 | 文档 + 收尾 | README 写明两种模型的分工 |

**工作量估计**：M1 小（半天内），M2/M3 是主要不确定项，取决于 step 0-3。

---

## 10. 与现有编号机制的关系

编号（`#1 #2 #3`）**不删**：

- 推模型（`/ide`、`selection` 自动模式）里它是唯一消歧手段，跨重启延续已经验证过（你那条 `#3` 就是证据）。
- 插模型里不需要它，因为引用是句子的一部分、位置自明。

两种机制并存不冲突：`source.form === 'snapshot'` 的 context 卡片和 composer 的 chip 在会话里是两种不同的东西，前者在历史里，后者在你发出去之前。

---

## 11. alpha.3 带来的可用更新（2026-10-15 追加）

**做法**：把 alpha.3 的 tarball 下下来，与本机 alpha.2 逐文件 diff。不是看 release note，是看字节。

```bash
# .research/alpha3/ 下：registry.json（全部版本元数据）+ 每个包的 tgz + 解包目录
diff -rq .research/alpha3/x/<pkg>/package/lib \
         /home/genet/.nvm/.../node_modules/@deepseek-ai/<pkg>/lib
```

### 11.1 结论：`@` 引用从"插入一个 chip"改成了"文本被规则解析成节点"

alpha.3 新增了一整套 **`UserText`** 机制（alpha.2 完全没有）：

| 文件（alpha.3 新增） | 作用 |
|---|---|
| `dsh-client-ui-conversation/lib/types/client/contract/user-text.d.ts` | `UserTextRule` / `UserTextNode` / `UserTextEvaluator` 契约 |
| `.../conversation/user-text-registry.d.ts` | `UserTextRegistry.register(rule)` |
| `.../user-text/UserText.d.ts` | `conversation.user.text` 槽位工厂 |
| `.../user-text/session-reference-rule.d.ts` | **`@` 会话搜索** 的新实现（`UserTextFacts.sessionLabels`） |
| `dsh-client-ui-reference/lib/types/client/user-text-rules.d.ts` | **`fileReferenceRule` / `folderReferenceRule`**（新） |
| `dsh-client-ui-reference/lib/types/client/FileReference.d.ts` | 文件 chip 组件（新） |

核心契约（`contract/user-text.d.ts`）：

```ts
interface UserTextRule<out Id extends string = string> {
  readonly id: Id;
  readonly order: number;                                  // 有限、升序；同值按 id 稳定排序，不按加载顺序
  match(this: void, text: string, from: number,
        context: UserTextTransformContext): (UserTextNode & {readonly id: Id})
                                            | UserTextNode<'text'> | undefined;
}
```

而 `fileReferenceRule` 就是在 alpha.3 里由 `dsh-client-ui-reference` 自己注册的（bundle 实测）：

```js
const fileReferenceRule = { id: "file", order: 30, match(text, from) { ... } };
```

**含义**：文字 → 节点 → 组件，三段都由插件参与。alpha.2 里 chip 是一个不透明对象（`{ref, label, appearance}`）；alpha.3 里你插进去的是**纯文本**，它会**被重新解析**。

### 11.2 哪些地方直接可用

| 我们的需求 | alpha.3 提供 | 用法 |
|---|---|---|
| `@path` 变成 chip | 内置 `fileReferenceRule`（order 30） | 插 `@hallsrv/.../limit.go` 即可，**不用自己做 chip** |
| 行号也变成结构化节点 | `uiConversation.userText.register(rule)` | 注册自己的规则，`id: 'editorPosition'` |
| 节点长什么样 | 键控槽位 `conversation.user.text.node` | 按 `id` 注册组件，拿到 `{path,startLine,endLine}` 渲染 |
| 候选列表 | `inputTriggers`（**alpha.3 里 0 字节改动**） | §5 的触发源方案原样保留 |

`onPick` 的返回形状 **也没变**（两个版本 bundle 实测一致）：

```js
return { insert: { source: "reference", ref: value.mention, label: ..., appearance: ..., clipboardText: ... } };
```

### 11.3 对 §7 step 0 的影响

| step | alpha.3 后 |
|---|---|
| 0-1 路由要不要授权 | **不变**（`webServer.register` 语义未变，只多了 `getOrigin()`/`bindUrlHost`） |
| 0-2 `@` 源能否共存 | **不变** |
| 0-3 client 插件能否加载 | **不变**，仍是唯一生死线。`dsh-client-modules` 只多了 `client.node.*` chunk 的排除 |
| 0-4 相对路径能否 `read` | **不变**（模型侧行为与客户端渲染无关） |
| 0-5 `appearance` 合法取值 | **降级为不重要**：chip 现在由文本规则产生，不再依赖 `appearance` 描述外观 |
| 0-6 `codec.serialize` 是否决定模型所见 | **降级**：文本本身就是模型所见，规则只影响渲染；但仍要确认规则不改变送出的原文 |

新增两项：

| # | 要验证 | 失败的话 |
|---|---|---|
| 0-7 | `ctx.uiConversation.userText.register(rule)` 是否对**第三方 client 插件**开放（alpha.3 自己只注册了内置规则） | 只用内置 `file` 规则，行号作为 `file` 节点之后的纯文本 |
| 0-8 | 自订 `id` 是否需要在 `UserTextDataMap` 里做 declaration merging 才能被键控槽位认领 | 沿用 `file` id，不自建节点类型 |

### 11.4 升级的收益与代价

**收益**

- 方案变简单：不写 chip 管道，只插文本 + 一条规则。
- 渲染变好：编辑器位置可以是**专用节点**（`limit.go 165-185`），而不是`路径 (165-185)` 这种半结构化文本。
- 顺带拿到 alpha.3 自己的两处优化（见 11.5）。

**代价**

- 82 个包同时 bump，全量重发。这是整版升级，不是定向补丁。
- 本机装的是全局 npm 包，升级要重装；我们的 profile patch、`link:` 插件、`~/.dsh/hooks/hooks.json` 都得在升级后重新验证。
- 编号机制（`#1 #2 #3`）建立在 `sessionProjections` 上，`dsh-session-projection` 也 bump 了，要重测跨重启延续。

### 11.5 release note 那两条的实际位置

| release note | 实际改动 |
|---|---|
| **改善 `@` 会话搜索体验** | `dsh-client-ui-reference/lib/types/client/user-text-rules.d.ts` + `session-reference-rule.d.ts`：会话引用改由 `UserTextRule` 在**原文里**识别，用 `UserTextFacts.sessionLabels` 匹配**已知最长标签**；`@imccyu` 作者 |
| **改善会话列表加载** | `dsh-session-reference`：`projectedLabels` 从**逐个 session** 变成**批量**（"a service lookup per listed session would dominate the call"），N 次服务查表 → 1 次 |
| （顺带） | `dsh-client-ui-sidebar` 只改了版本字符串 `0.2.1-alpha.2-ca4b490` → `0.2.1-alpha.3-5255edd`，**没有**会话列表逻辑改动 |

---

## 12. alpha.3 实际接口下的客户端实现（取代 §5/§6）

> 本节是对着**真正装上并正在运行**的 alpha.3 读的接口（`/home/genet/.nvm/versions/node/v22.22.1/lib/node_modules/@deepseek-ai/dsh/`），不是对着 tarball 推测。升级已完成：alpha.2 → alpha.3，302 个嵌套包，`dsh --version` = `0.2.1-alpha.3`，profile 与 `link:` 插件挂载均未变。

### 12.1 唯一模板：`dsh-client-ui-reference` 在 alpha.3 里就这么写

实际安装的 bundle（`lib/client.js`，逐字抄）：

```js
const inject = [ ..., "sidebarRight", "slots", "uiConversation" ];

function apply(ctx) {
  ctx.uiConversation.userText.register(fileReferenceRule);
  ctx.uiConversation.userText.register(folderReferenceRule);
  ctx.slots.inject("conversation.user.text.node", function* () {
    yield ctx.slots.register({
      name: "conversation.user.text.node",
      key: "file",
      priority: 100,
      locale: NS,
      inject: (sessionId) => ({ openFile: (path) => { ... } }),
    }, FileReference);
    yield ctx.slots.register({
      name: "conversation.user.text.node",
      key: "folder",
      priority: 100,
    }, FolderReference);
  });
  ...
  ctx.effect(() => inputTriggers.registerSource(source), "ui-reference: @ source");
}
```

**三个服务**：`ctx.uiConversation`（规则注册）、`ctx.slots`（节点渲染）、`ctx.inputTriggers`（候选）。

### 12.2 排序规则（决定我们的 `order` 填多少）

`UserTextRegistry.refresh()` 实测：

```js
this.rules = [...this.definitions.values()]
  .sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
```

`reconcile()` 的胜出判定实测：

```js
let winner;
for (const traversal of traversals) {            // 按上面的顺序遍历
  const node = nextCandidate(traversal, input, cursor);
  if (node !== void 0 && (winner === void 0 || node.start < winner.start)) winner = node;
}
```

**只按严格更小的 `start` 换人** → 同起点时**数组里靠前的赢**。所以：

- **`order` 升序 = 优先级降序**：小的先匹配、先赢。
- 同 `order` 时**字典序小的 `id` 赢**，与插件加载顺序无关。
- 内置 `fileReferenceRule` 的 `order` 是 **30**。我们的规则要压过它，得 **`order < 30`**（建议 20）。

### 12.3 两段式规则：`@path` 归内置，`#L` 归我们

不动内置规则，只在更高优先级上加一条"带行号"的规则。我们的规则失配时自然落回 `file`，裸 `@path` 行为完全不变。

```js
// dsh-editor-context-client/lib/client.js —— 骨架 v2（对着 alpha.3 写）
const RULE_ID = 'editorPosition';        // 不能是保留的 'text'

/**
 * 匹配 @<path>#L12-34 或 @<path>#L12，返回一个覆盖全串的节点。
 * 纯同步、不读 Facts —— 和内置 file 规则一样，所以它在**历史消息**里也能渲染，
 * 不只是草稿里。
 */
const editorPositionRule = {
  id: RULE_ID,
  order: 20,                             // < 内置 file 的 30 → 同起点我们赢
  match(text, from) {
    for (let at = text.indexOf('@', from); at !== -1; at = text.indexOf('@', at + 1)) {
      const hit = parseAt(at, text);     // 读 path 与非空 #L 区间
      if (hit !== undefined) return { id: RULE_ID, ...hit };
    }
    return undefined;
  },
};
```

```js
function apply(ctx) {
  ctx.uiConversation.userText.register(editorPositionRule);
  ctx.slots.inject('conversation.user.text.node', function* () {
    yield ctx.slots.register({
      name: 'conversation.user.text.node',
      key: RULE_ID,
      priority: 100,
    }, EditorPositionChip);              // ({ node:{data:{path,startLine,endLine}}, raw, interactive }) => JSX
  });
  // 候选列表：§5 的触发源方案原样保留
  ctx.effect(() => ctx.get('inputTriggers').registerSource(positionSource),
    'editor-context-client: @ source');
}
```

`inject` 数组（包 manifest 的 `dsh.client.inject`）需要：

```json
["@deepseek-ai/dsh-client-ui-conversation",
 "@deepseek-ai/dsh-client-ui-slots",
 "@deepseek-ai/dsh-client-ui-input-trigger",
 "@deepseek-ai/dsh-client-locale"]
```

`ctx.uiConversation` 由 `dsh-client-ui-conversation` 提供，`UiConversation` 在构造时 `this.userText = new UserTextRegistry(ctx)`（bundle 实测），是**根作用域**服务，挂载期就能注册。

### 12.4 语法选择：为什么是 `@path#L12-34`

| 语法 | 我们的规则 | 内置 `file` 规则 | 模型怎么读 |
|---|---|---|---|
| `@path (12-34)` | 不匹配 → 落回 `file`，路径成 chip，区间是裸文本 | 匹配路径 | 区间是装饰性文字，编辑时容易和路径脱钩 |
| `@path:12-34` | 匹配 | **也**匹配（`:` 在路径 token 里合法）→ 靠 `order` 决定 | Windows 盘符、带冒号的路径会歧义 |
| **`@path#L12-34`** | 匹配 | 不匹配（`#` 不在路径语法里） | GitHub 约定，模型本来就懂 |

选 `#L`：**归属清晰**（内置规则根本不认它，不存在同起点竞争的解释负担），且是模型预训练里最强的行号约定。单行用 `@path#L12`。

### 12.5 模型看到什么

**原文。** 规则只影响渲染，不改送出去的字节 —— 这一点和 §11.3 的判断一致。所以：

- 送出去的就是 `@hallsrv/.../limit.go#L165-L185` 这串字面量。
- `@` 让模型认路径（`FILE_REFERENCE_PROMPT` 原文：`Tokens prefixed with @ are paths the user explicitly referenced`），`#L165-L185` 跟在后面作为文本。
- **可以再加一道保险**：host 半边用 `ctx.systemPrompt.section(...)` 补一句约定说明。但 `getSectionOrder()` 的取值是有限集合（`HARNESS_IDENTITY` / `FILE_REFERENCE` / `PLAN_POLICY` / `MCP_SERVERS` …），能不能自订一个名字要先验（列进 §12.7）。

**已核实：chip 在历史消息里同样渲染，不只草稿里。** alpha.3 的 `dsh-client-ui-chat` 新增了 `UserContent`（`lib/types/client/chat/UserContent.d.ts`），签名是 `FactoryComponentPropsOf<'conversation.chat.user.content'>`，bundle 里也确实引用了 `conversation.user.text`。也就是说**已发出的消息在回放时走同一条解析管线**——三天后翻回这段对话，`@path#L165-185` 仍是可点的 chip，不会退化成裸文本。这是 alpha.2 的 `{ref, appearance}` 方案做不到的，也是选 alpha.3 路线最实际的一条收益。

### 12.6 这一节替掉的旧结论

| §6 的旧结论 | alpha.3 后 |
|---|---|
| 要在 `onPick` 里构造 `{ref, label, appearance}` | 仍可用（`onPick` 形状未变），但**不再是关键**：插进去的文本会被规则重新解析成节点 |
| 要自己管 chip 外观 | 不用。注册节点组件即可，槽位是 `keyed` + `inline` |
| `codec.serialize` 决定模型所见 | **不是**。原文即真值 |
| `appearance` 合法值要验 | 不需要了 |
| 绝对路径优先 | **仍成立**（模型要能 `read`；相对路径相对于编辑器工作区，不是 agent 的 cwd） |

### 12.7 修订后的 step 0（只有 4 项，且都不阻塞施工）

| # | 要验证 | 怎么验 | 失败的话 |
|---|---|---|---|
| 0-1 | `webServer.register` 的路由**要不要 token** | host 半边挂一条 `GET /editor-context/ping`，`curl -i` | 客户端带上 `window.__DSH_BOOT__` 的 token |
| 0-2 | `link:` 安装的包能否被 `dsh-client-modules` 扫到并供 bundle | 挂一个 `console.log` 版最小 client 包，重启后看浏览器控制台 | **生死线**：不行则整条路线作废，回到 §6 的纯 host `/ide` |
| 0-3 | 自订 `id` 的节点能否被键控槽位认领（`UserTextDataMap` 是纯类型层的 declaration merging，运行时只看 `{id,start,end,data}`） | 注册一个返回固定候选的规则 + 组件 | 沿用内置 `file` id，区间退化为裸文本 |
| 0-4 | 自订 `systemPrompt` section 名是否被 `getSectionOrder` 接受 | 试 `getSectionOrder('EDITOR_CONTEXT')` | 不写系统提示，靠 `#L` 的通用约定 |

**0-2 依然是唯一的生死线**，而这次升级**没有改善它**：`dsh-client-modules` 在 alpha.3 里只多了一行 `client.node.*` chunk 排除，包发现与供给逻辑未变。

### 12.8 升级本身的验证结果（已完成）

| 项 | 结果 |
|---|---|
| 全局版本 | `0.2.1-alpha.3`，302 个嵌套包 |
| 换入方式 | 同设备（`2096`）两次 `rename`，停机 = 一次普通重启 |
| 回滚 | `dsh.bak-alpha2-20261015-182602` 仍在原处，一条 `mv` 可退 |
| profile 组装 | 新版 CLI 读出 `- id: editor-context / mode: on-demand` ✓ |
| 本插件回归 | 挂载正常、状态文件仍在发布、`node --test` **21/21** |
| 启动错误 | `/home/genet/.dsh-web.log` 自 18:26:33 起无 import/activation 失败 |
| 一次性异常 | 换入瞬间脚本自检 `node lib/bin.js --version` 报过一次 `SyntaxError`，之后同命令正常返回 `0.2.1-alpha.3`；服务全程未受影响，判为 rename 瞬间的读取竞态，未复现 |

---

## 12.9 施工中新增的两条约束（原计划里没有）

两条都是**只有真的点下去才会暴露**的：静态检查不会报，主机侧日志也看不见。

### 12.9.1 插入必须走 `{insert}`，不能走 `{text}`

原计划 §12.3 打算让 `onPick` 返回 `{ text: <mention> }`，理由是 conversation 包自己写着：

> the editor gains ordinary characters — no chip node; the chip look is a scan-derived decoration, never state.

这句话是对的，但**它描述的是两条路里的哪一条**被漏掉了。实际的 `execute()` 分派：

```js
if ("claim" in outcome) → slash/input-begin-command
if ("text"  in outcome) → slash/input-insert-text      // 普通字符
else                    → slash/input-insert-reference // reference 记录
```

`{text}` 落进的是普通字符，**只有命中某个源通过 `lexicon` 发布的名单才会被装饰**，而且 chip 显示的是整个名字——对我们的场景就是那条长绝对路径，比没有 chip 更糟。

`{insert}` 造一条 reference 记录，自带 `label`，所以 chip 能显示 `limit.go:146-154` 而文档文本仍是完整 token。`appearance` 是封闭枚举（`session | file | folder`，见 `referenceSchema`），取 `file`。`ref` 必须等于 `clipboardText`——draft schema 强制文档跨度长度等于 clipboard 文本长度。

### 12.9.2 reference 源必须带 `codec`

```js
serializeReference(source, ref, signal) {
  const owner = roster.all().find((s) => s.name === source);
  if (owner?.codec === void 0) return Promise.reject(new Error(`slash: no serializer for reference source "${source}"`));
  return owner.codec.serialize(ref, signal);
}
```

发送前把每个 chip 经其属主的 codec 展开成模型形态，**属主没有 codec 时整条提交被拒**，注释原文是 `blocks instead of silently downgrading to the clipboard text`。

`serialize` 返回的必须是 **token 而不是 chip 标签**：label 给人看，token 给模型看（模型要靠它 `read`）。所以 `serialize: (ref) => Promise.resolve(ref)`。

### 12.10 后记（0.4.0）：push 通道已删除

上面 §11/§12 描述的架构里有两条通道，chip 通道和 push 通道。**push 通道已经删掉**，
包括 `mode`、`commands`、`/ide`、编号标记，以及为了编号跨重启延续而存在的 session
projection 和 `agent/pre-step` 监听器。

理由不是"没人用"，而是**它默认就够不着**：`mode` 默认 `off`，`commands` 默认 `[]`，
所以除非手写配置，那条路根本走不到。而它存在的唯一目的，是让"一条用户没写的消息"
能被区分出来——编号、`source.form: snapshot`、折叠的 context 卡片，全是为了处理
chip 天然没有的问题。

现在 `apply` 只做两件事：挂一条只读路由，往系统提示里加一段 `#L` 语法说明。
`test/editor-context.test.mjs` 断言 `apply` 之后没有 slash 命令、没有 per-turn
listener、没有 session projection——也就是**这个插件没有任何办法把消息放进对话**。
