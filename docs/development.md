# dsh-llm-bridge 开发工作流（交接文档）

> 面向后续维护者（人类或 Agent）。读完本文应能独立：跑通环境、修复一个上游协议变更、新增一个平台驱动。

## 1. 项目定位（边界意识，先于一切）

**一句话**：复用闭源 AI 桌面 App **已有的登录态与额度**，把它们的对话模型用最小成本暴露给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）。

**是**：一个 DSH 插件；一个"本机 loopback OpenAI 兼容垫片 + 每平台驱动"的薄桥。

**不是**（明确不做，避免范围蔓延）：

- 不是通用 AI Provider SDK / 模型网关
- 不做 auto-router、故障转移、多账号、额度聚合
- 不做 OAuth 登录流程（只复用桌面 App 已建立的会话）
- 不把 loopback 端口暴露到本机以外

每个判断都用同一条准则：**"这是平台无关的机制吗？"**——是 → Core；"只有某个平台才这样吗？"→ Driver；"只是未来可能复用？"→ 先不抽象。

## 2. 架构总览

```
DSH (pi-ai, openai-completions API)
  │  Authorization: Bearer <每进程随机共享密钥>
  ▼
Core shim (127.0.0.1:随机端口, /v1/models, /v1/chat/completions)
  │  ① loopback Host/Origin 门禁 + bearer 校验 + body 限额
  │  ② resolveCredential()  ← Driver 的凭证存储（文件/钥匙链…Core 不关心）
  │  ③ 原始 OpenAI 请求体交给 Driver 做出站方言转换
  ▼
Driver upstream（平台原生端点 + 平台私有鉴权头 + 平台私有错误分类）
  │
  ▲ 响应：标准 OpenAI SSE 时 Core 直接 pipe；非标准时由 Driver 翻译（见 §6 第 4 条）
```

- **Core（`src/core/`）**：机制集合，**禁止出现任何平台名**（CI 可用 grep 自检：`workbuddy|loomy|trae|qoder` 在 src/core 下必须零命中，含注释）。
- **Driver（`src/drivers/<id>/`）**：承载该平台全部私有事实。
- **组合根（`src/index.ts`、`src/bin.ts`、`src/client/index.tsx`）**：把每个驱动各装一遍。驱动数量 = 这里枚举的数量。

## 3. 目录与文件职责

### Core（平台无关）

| 文件 | 职责 |
|---|---|
| `src/core/types.ts` | 最小接缝：`BridgeUpstream<C>`、`BridgeChatResult`、`BridgeErrorKind`、`IdentifiedModel` |
| `src/core/credential.ts` | `CredentialRefresher<C>`：到期 margin、单飞、刷新失败但未过期则继续放行。**不管存储** |
| `src/core/catalog.ts` | `Catalog<M>`：初始清单 + 原子替换的可变容器 |
| `src/core/shim.ts` | loopback HTTP 服务、共享密钥、加固、SSE 透传；出站转换委托 `upstream.chat` |
| `src/core/adapter.ts` | pi-ai 适配器壳；能力映射经 `toModel` 回调、名称装饰经可选 `decorateModelName` 回调 |
| `src/core/heartbeat.ts` | 心跳文件读写 + PID/进程启动时间存活判定；文件名/包标记由驱动注入 |
| `src/core/status-route.ts` | 状态路由的 HTTP 机制（GET-only、loopback 门禁、token 脱敏、webServer 挂载） |
| `src/core/status-types.ts` | node-free 通用状态文档类型（host 与浏览器共用） |
| `src/core/client/status-card.tsx` | 通用插件卡片（轮询/展开/积分条/徽章），纯展示，文案由驱动 locale 注入 |
| `src/core/loopback.ts` | loopback Host/Origin 判定 |
| `src/core/version.ts` | 构建期注入的包版本（`__DSH_LLM_BRIDGE_VERSION__`） |

### Driver（以 workbuddy / loomy 为例，每个驱动一套）

| 文件 | 内容（全是平台私有事实） |
|---|---|
| `meta.ts` | provider id、显示名、超时常量、端点、env 名、文件名 |
| `auth.ts` | 凭证文件路径探测（mac/win/wsl）、解析、存储策略、状态摘要、env 覆盖 |
| `upstream.ts` | 端点、鉴权头、请求体方言、响应/错误分类、模型目录解析 |
| `catalog.ts` | 静态 fallback 模型清单（离线/首帧用）+ `XxxCatalog extends Catalog` |
| `adapter.ts` | catalog→pi-ai 描述符：能力、思考档位映射、可选名称装饰 |
| `shim.ts` | 用 Core `createShim` 绑定本驱动：注入凭证解析器与出站转换 |
| `status-paths.ts` / `web-status.ts` | 卡片状态路由路径与文档构造 |
| `heartbeat.ts` | 用本驱动文件名/包标记绑定 Core 心跳机制 |
| `plugin.ts` | `applyXxxPlugin(ctx, config)`：装配并向 DSH 注册 provider + settings section |
| `cli.ts` | 根 CLI 使用的诊断描述符（store 视图 + 心跳 + 可选额度查询） |
| `client/` | 卡片薄包装（`DriverStatusCard` + 本驱动 locale/徽章本地化）与注册函数 |
| `index.ts` | 驱动的公共导出桶 |

## 4. Core 的最小接缝（抽象就这些，别做厚）

```ts
// 唯一的上游协议接缝
interface BridgeUpstream<C> {
  chat(credential: C, bodyJson: string, signal?: AbortSignal): Promise<BridgeChatResult>
}
// BridgeChatResult = { ok:true, response:{body} } | { ok:false, status, kind: BridgeErrorKind, message }

class Catalog<M> { constructor(initial: readonly M[]); current(): readonly M[]; set(models): void }
class CredentialRefresher<C extends { expiresAtMs: number }> {
  needsRefresh(c): boolean
  refreshIfNeeded(c): Promise<C>      // 单飞 + 未过期兜底；驱动负责存储与刷新协议
}

createShim<C, M extends {id:string}>({ resolveCredential, upstream, catalog, ownedBy, upstreamLabel, logger? })
createBridgeAdapter<M>({ providerId, displayName, credentialName/Source, shim, catalog,
                         toModel, decorateModelName?, streamIdleTimeoutMs, resolveAttachments? })
createHostHeartbeat({ fileName, packageName }, pluginVersion)
registerStatusRoute(ctx, path, build)
```

**刻意没有的东西**：万能 `ProviderDriver` 大接口、SSE 翻译器钩子、FileCredentialStore 通用模型、驱动发现/注册表、统一额度模型。需要时由**第三个真实驱动**逼出来，而不是提前设计。

## 5. 新增一个平台驱动（标准流程）

> 原则：**协议调研全部用 curl/脚本对真实账号验证后，再写一行驱动代码。** 猜协议是最大的返工来源。

### 5.1 调研（产出一张"硬事实表"）

1. 解包/抓包桌面 App，确定：会话存储位置与格式（明文 JSON / leveldb / 钥匙链 / 加密？）、是否有刷新协议、真实 API baseURL（**不要信 .env 里的域名，Loomy 就踩过：env 写的是 Athena，真实 imodel 是 loomyad.xunfei.cn**）。
2. 用真实会话逐个 curl 验证并记录：
   - `/models` 鉴权方式与返回字段（哪些是对话模型、能力字段、思考档位词表）
   - `/chat/completions` 鉴权头、必需的追踪/签名头
   - `stream:false/true` 是否都支持；SSE chunk 是否标准 OpenAI
   - `role:"developer"` 是否接受（WorkBuddy 400 必须改写成 `system`；Loomy 原生接受）
   - `tool_choice` 对象形式是否接受（两个平台都 **400**，都要拍平成字符串）
   - 未知字段是被忽略还是报错
   - 思考强度的**线上字段名与取值**（如 Loomy 用 `reasoning_effort: none|low|medium|high|xhigh`）
   - 错误体长什么样（401/402/429/超时的区分方式；注意"缺头挂死不报 4xx"这类静默怪癖）
3. PII 盘点：会话文件里有没有手机号等隐私字段，解析时**直接不取**。

### 5.2 实现（复制最像的驱动做减法）

- 后端是"OpenAI 兼容 + 少量私货"→ 复制 `drivers/loomy/`；私有信封/多区域/计费复杂 → 参考 `drivers/workbuddy/`。
- 新建 `src/drivers/<id>/` 的全套文件（§3 表），在四处组合根登记：
  1. `src/index.ts`：`export *` 桶、`Config` 加一个可选嵌套节、`apply()` 调一次 `applyXxxPlugin`
  2. `src/bin.ts`：`DRIVERS` 数组加 `xxxCli`
  3. `src/client/index.tsx`：`apply()` 调一次 `registerXxxCard`
  4. `cordis.patch.yml` 一般无需改（插件 id 仍是 `llm-bridge`，一个插件注册多个 provider）
- provider id / settings namespace / 心跳文件名 / 状态路由路径必须各自唯一：
  - 状态路径形如 `/plugins/dsh-llm-bridge/<id>/status`
  - 心跳文件 `.xxx-host-heartbeat.json`
  - 每个驱动独立 shim 端口与共享密钥，不要共享
- 能力声明遵循**宁少勿多**：上游不明确支持的模态/工具/档位不要在 pi-ai 描述符里声明（声明了 DSH 就会发，发了被拒就是用户看到的 400）。参考 `docs/image-modality-gap.md` 的教训。
- 静态 fallback 清单只放**实测可用**的对话模型；非对话类型（图像生成等）在 `fetchModels` 里过滤。

### 5.3 测试（缺一不可）

- `tests/<id>/auth.spec.ts`：解析（含 PII 不落地）、路径/env 覆盖、signed-out、跟随重新登录
- `tests/<id>/upstream.spec.ts`：mock fetch 断言鉴权头/必需头、body 方言、错误分类、models 解析与过滤
- `tests/<id>/shim.spec.ts`：经 shim 的出站转换、SSE pipe、错误码映射、未登录 401
- `tests/<id>/adapter.spec.ts`：fallback 全可 resolve、能力/档位/名称装饰
- 在 `tests/<id>/settings-integration.spec.ts` 或现有多驱动用例里断言：provider 注册、section 安装、namespace 持久化
- **真实账号 E2E**：仿 `scripts/live-e2e-loomy.mjs` 写一个，经完整 adapter→shim→上游 链路跑通流式回复
- `tests/client-fallback.spec.ts`：里面是根客户端 `apply()` 的**手工镜像**（浏览器包无法在 Node 测试里加载）。新增驱动时同步镜像，注释里有 drift 警告。

### 5.4 抽象回流规则

新驱动如果发现 Core 接缝不合适：**改 Core 抽象，不要在驱动里硬塞**（但也不要顺手发明大接口）。Loomy 接入时已验证并回流过两处：通用状态文档类型（`status-types.ts`）与通用卡片（`core/client/status-card.tsx`）。

## 6. 已踩平台陷阱清单（新驱动先对照）

**WorkBuddy（CodeBuddy / copilot.tencent.com）**

- 请求体必须 `stream:true`（上游拒绝非流式）；`tool_choice` 对象形式 400，要拍平；`role:"developer"` 400（code 11128），要改写为 `system`。
- CN/Global 双区域，按会话 domain 选 baseURL；chat 要一组 `X-User-Id/X-Enterprise-Id/X-Domain` 头。
- 响应是 `{code,msg,data}` 信封；错误标记是中英文混合文案；计费是独立的 `v2/billing/meter/get-user-resource`。
- 有 OAuth 刷新：desktop 文件只读 + `$DSH_HOME` own-copy 可写，双源取 expiresAt 更晚者。

**Loomy（讯飞 imodel，loomyad.xunfei.cn/api/v1）**

- 会话是明文 32-hex（`auth-session.json`），**无刷新协议**，每次请求重读文件；`phone` 是 PII 不取。
- chat 必须**同时**带 `Authorization: Bearer` 和 `token` 两个头；`/models` 只要 `token`。
- 每个 chat 请求必须生成新的 W3C `traceparent: 00-<32hex>-<16hex>-01`，**缺失会静默挂死到超时**，没有 4xx。
- `tool_choice` 对象形式 400；`developer` 角色、非流式都原生支持，不用改。
- 档位词表用 `none` 表示关闭（pi-ai 叫 `off`，适配层映射）；`reasoning_content` 走标准 delta。
- catalog 里 2 个 `type:"image"` 是图像生成模型，必须过滤。
- 推理模型 `max_tokens` 太小会正文 `content:null`（finish_reason=length）——fallback 目录用上游给出的大 output 上限。

## 7. 日常开发命令

```sh
pnpm test                              # 全量单测（直接跑可用 ./node_modules/.bin/vitest run）
./node_modules/.bin/tsc -p tsconfig.json         # host 类型检查
./node_modules/.bin/tsc -p tsconfig.client.json  # 浏览器卡片类型检查
pnpm build                             # tsdown 双端构建（host ESM + 浏览器 CJS 包裹层）
node scripts/verify-shim-hardening.mjs # loopback 六项安全加固实测（需先 build）
node scripts/live-e2e.mjs             # WorkBuddy 真实账号链路（非测试集，消耗额度）
node scripts/live-e2e-loomy.mjs       # Loomy 真实账号链路（非测试集）
node lib/bin.js status                # 两驱动聚合诊断；可加 workbuddy|loomy 限定
```

注意：本机 `pnpm` 可能因 lockfile 与 manifest 版本漂移在 preflight 报错（与代码无关），此时直接用 `node_modules/.bin/` 下的二进制。

**回归铁律**：行为一旦与既有驱动不符，**先修回归，不要继续加抽象**。重构后 WorkBuddy 的全部既有断言（模型名装饰、档位、模态、section 持久化、加固）必须保持绿色。

## 8. 安全红线（改动 Core 前逐条确认）

- shim 与状态路由只服务 loopback：Host 必须是 `127.0.0.1/localhost/[::1]`（防 DNS rebinding）；浏览器 Origin 必须 loopback；chat POST 必须 `application/json`（防 simple-request CSRF）；bearer 缺失/错误一律 401。
- 入站 bearer 是每进程随机密钥，**只在 pi-ai 与 shim 之间**；真实平台凭证只由 Core 在服务端经 `resolveCredential()` 取出，永不出现在发给浏览器的任何响应里。
- 状态文档禁止携带 token/手机号；`safeMessage()` 对 JWT、`key=secret`、32 位会话串做脱敏。
- `body.pipe(res)` 透传上游 SSE；上游流中断且没发 `[DONE]` 时补一个，避免 DSH 挂起。
- 凭证文件权限：own-copy 用 `0600`/目录 `0700`；desktop 文件只读，永不写回。

## 9. 发布与版本

- 版本号唯一来源是 `package.json`，tsdown 的 `define` 注入 `src/core/version.ts`；`tests/version.spec.ts` 会校验源码与 `lib/` 产物都带当前版本——**改完版本必须重新 build 并把 lib/ 一起提交**（lib 是入库的预构建产物）。
- `package.json` 的 `dsh` 字段、`cordis.patch.yml`、tsdown 的 banner `PLUGIN_ID` 必须一致（均为 `dsh-llm-bridge`）。
- 与 DSH 核心版本强配对（README 有表），DSH 侧接口（pi-ai profile 的 `modelErrors`、settings 的 namespace 品牌等）变过好几次，升级 DSH 依赖时先跑 settings-integration 实测。
- npm 包名/仓库改名后，旧安装命令（`dsh-workbuddy-bridge`）只保留在旧线文档；provider id（`workbuddy`/`loomy`）、settings namespace、env 名、桌面凭证路径属于**用户配置契约**，不随包名改。

## 10. 排错速查

| 现象 | 优先怀疑 |
|---|---|
| 模型选择器看不到某 provider | shim `ready` 后的注册异常（看 DSH 日志 `provider registration failed`）；心跳文件存在但 PID 不匹配 |
| 选中模型后请求一直 pending | Loomy 系：缺/错 `traceparent`；其它平台：上游是否要求强制 stream |
| 400 invalid_request_error | 先抓出站 body：`tool_choice` 是否对象、`developer` 角色、平台不认的字段 |
| 401 | shim 收到的是共享密钥错误？还是上游会话失效？前者查 loopback 调用方，后者查桌面 App 登录态 |
| 卡片一直 signed-out 但 CLI 正常 | 浏览器缓存了旧 client bundle（硬刷新）；状态路径是否 `/plugins/dsh-llm-bridge/<id>/status` |
| 工具调用无响应 | 该模型 catalog 是否真的声明 function calling；上游是否要求字符串 tool_choice |
| 图片消息被拒 | 该模型 `supportsImages` 是否按上游事实声明；宁少勿多 |
