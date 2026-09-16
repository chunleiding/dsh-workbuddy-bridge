# Loomy 驱动 — 集成与逆向笔记 (Driver Integration Note)

> 用途：本文是 Loomy 驱动 `src/drivers/loomy/` 的逆向过程沉淀，供后续新增 Driver（Qoder / Trae）时直接复用其中的常量与坑。
> 框架目标：复用闭源 AI 桌面 App 已有的登录态与额度，最小成本把它们的模型暴露为 DSH provider（见根 README 的 Core/Driver 架构）。
> 状态：**Loomy 驱动已实现并跑通**（`/models` + `/chat/completions` 非流式 & SSE 均 200，走真实账号额度）。

---

## 0. 结论（Verdict）

✅ **可行，且比 WorkBuddy 驱动简单一个数量级**。

Loomy 内置的 `imodel` provider 后端**本身就是标准 OpenAI 兼容**（`/chat/completions` / `/models`），无需逆向私有线协议。Driver 只需做两件事：① 读本机明文 session；② 给上游请求注入两对鉴权头 + 一个强制 tracking 头。`usage.points_consumed` 字段证明请求走了真实账号额度。

---

## 1. 接线架构（Driver 视角）

```
DSH（pi-ai 适配器）
  └─(OpenAI 协议)→ Core loopback shim
        └─(Loomy Driver: 注入 session 头 + traceparent)→ Loomy 真实后端 loomyad.xunfei.cn/api/v1
              └─ 用本机登录态/积分返回标准 OpenAI 响应
```

Driver 职责：凭证发现 → 上游端点/协议转换 → 模型目录 → 额度/错误/品牌。协议细节全部留在 Driver，Core 不感知 Loomy 的 SSE 流格式或鉴权头。

---

## 2. 已逆向的关键事实（hard constants — 直接可用）

| 项 | 值 |
|---|---|
| session 文件 | `~/Library/Application Support/loomy/auth-session.json`（macOS）；Windows/WSL 路径需另探 |
| session 结构 | `{ "session": "<32位十六进制>", "userid": "...", "phone": "...", "updatedAt": <ms> }` |
| session 形态 | 明文 32-hex（128-bit），**非加密**；`updatedAt` 为登录态刷新时间 |
| imodel baseURL | **`https://loomyad.xunfei.cn/api/v1`** ⚠️ 见坑 #1 |
| `/models` 鉴权 | 头 `token: <session>`（`authMode=token`） |
| `/chat/completions` 鉴权 | 头 `Authorization: Bearer <session>` **+** `token: <session>` |
| 强制追踪头 | `traceparent: 00-<32hex>-<16hex>-01`（W3C 格式）⚠️ 见坑 #2 |
| 可选追踪头 | `ChatId` / `MsgId` / `TurnId` / `loomy-version: <版本号>` |
| 请求 body | 标准 OpenAI `chat.completion` 格式 |
| 响应 body | 标准 OpenAI 格式 **+** `usage.points_consumed`（真实消耗积分） |
| 流式 | SSE 标准 `chat.completion.chunk`，`delta.reasoning_content` 正常透传 |

> 逆向来源（供复核）：解包 `Loomy.app/Contents/Resources/app.asar`；关键文件
> `electron/llm/llm-completion.js`（chat 协议）、`electron/utils/request-headers.js`（traceparent 格式）、
> `electron/model-service.js`（provider 注册）、`electron/xfyun/account-service.js`（session 用法）、
> 真实 baseURL 来自 `~/.config/loomy-opencode/opencode/opencode.json` 的 `imodel` provider 配置。
> 对应实现见 `src/drivers/loomy/meta.ts`（`LOOMY_BASE_URL`）、`src/drivers/loomy/upstream.ts`（traceparent 生成）。

---

## 3. 端点与请求格式

### GET `{baseURL}/models`
Header：`token: <session>`
返回：标准 `{ object:"list", data:[{id, object:"model", ...}] }`，约 12 个模型。
模型样例：`deepseek-v4-flash-0731`、`MiniMax-M3`、`Kimi-k2.6`、`qwen-3.8-max`、`GLM-5.3-Flash`、`spark-x`、`qwen3.5-flash`、`doubao-seed-2.0-mini`…

### POST `{baseURL}/chat/completions`
Headers：
```
Authorization: Bearer <session>
token: <session>
traceparent: 00-<32hex trace-id>-<16hex span-id>-01
content-type: application/json
```
Body：标准 OpenAI chat completion（支持 `stream:true`）。
响应：标准 OpenAI；推理模型（如 `spark-x`）会带 `reasoning_content`，且 `usage.completion_tokens_details.reasoning_tokens` 非空。

---

## 4. 踩过的坑（Pitfalls → 解法）

**坑 #1：`imodel` 的 baseURL 不是 `.env.prod` 里的 Athena 域名。**
`.env.prod` 解密后写着 `ATHENA_API_BASE_URL=https://api-athena.xfinfr.com`，
但 `imodel` provider 实际 baseURL 是 `https://loomyad.xunfei.cn/api/v1`。
对着 athena 域名打 `/models` 会 **404**。真实地址必须读 `~/.config/loomy-opencode/opencode/opencode.json`。
→ 解法：硬编码 `loomyad.xunfei.cn/api/v1`，不要信 athena 域名。

**坑 #2：`traceparent` 缺失 → `/chat/completions` 挂死超时。**
Loomy 要求 W3C `traceparent`（`00-<32hex>-<16hex>-01`），缺了请求会一直 pending 直到 timeout，
不报 4xx/5xx，极难排查。这是 Loomy 最隐蔽的私有怪癖。
→ 解法：Driver 对每个 chat 请求生成合规 `traceparent`（random 32hex + 16hex）。

**坑 #3：鉴权要**同时**带 `Bearer` 和 `token` 两个头。**
只带一个会 401/拒绝。两者值都是同一个 session。
→ 解法：两个头都注入。

**坑 #4：推理模型 `max_tokens` 太小 → `content:null`。**
`spark-x` 等推理模型会把 token 全耗在 `reasoning_content` 上，若 `max_tokens` 不够，
正文 `content` 为 `null`、`finish_reason:"length"`。
→ 解法：调用推理模型时给足 `max_tokens`（≥800）；或默认模型改用非推理模型（如 `qwen3.5-flash`）。

**坑 #5：`.env.prod` 是加密的，不能直接读 endpoint。**
文件以 `LOOMYENC1:` 前缀 + AES-256-GCM + scrypt 加密，口令硬编码在
`electron/utils/env-file-crypto.js`（`loomy::env::3f9c1d2a7b6e4f08::local-obfuscation::v1`）。
→ 解法：不必解密即可打通（真实 baseURL 在 opencode.json）。仅供需要其他后端地址时参考。

**坑 #6：`auth-session.json` 含真实手机号（PII）。**
`phone` 字段是你的私人信息。
→ 解法：Driver/脚本**绝不打印/落日志**该文件内容；`LOOMY_SESSION_FILE` 路径由用户环境提供，提交代码时加进 `.gitignore`，勿上传。

---

## 5. 新增 Driver 时对照本驱动的要点

1. **凭证发现**：在 `src/drivers/<平台>/auth.ts` 定位本机 session/credential 文件，取 token；建议带有效期校验。
2. **端点**：在 `meta.ts` 硬编码真实 baseURL（**不要信 app 自带 env 里的「网关」域名**，见坑 #1）。
3. **鉴权/追踪头**：在 `upstream.ts` 的请求构造里注入；Loomy 的 `traceparent` 模式是最典型的「缺头挂死」怪癖，其他平台很可能有类似隐藏头。
4. **协议转换**：SSE / body 标准 OpenAI 的，Driver 直接透传；非标的才在 Driver 内转换，Core 不感知。
5. **模型目录 + 品牌**：`catalog.ts` 暴露模型 id 与展示名、`plugin.ts` 注册 provider、`client/` 提供 DSH 设置卡。

---

## 6. 安全 / ToS

- 仅限**个人研究/学习用途**，遵守 Loomy / 科大讯飞 ToS。
- 凭据文件属 PII+私密，禁止提交仓库、禁止打印到日志。
- `points_consumed` 表明走真实额度，注意积分消耗。

---

## 7. 已验证证据（Evidence）

- `GET /v1/models` → 200，12 模型。
- `POST /v1/chat/completions` `spark-x` → `content:"2"`，`finish:stop`，`points_consumed:0`。
- `POST /v1/chat/completions` `qwen3.5-flash` → `content:"1+1 等于 2。"`，`points_consumed:3`。
- SSE `stream:true` → 标准 `chat.completion.chunk`，`delta.reasoning_content` 透传正常。

---

## 8. 将 Qoder / Trae 也做成 Driver（框架路线，非「消费桥接器」）

本框架把 WorkBuddy / Loomy / Trae / Qoder 都视为「可桥接的闭源 Agent」，目标是把它们各自做成 Driver，复用各自登录态+额度。只读扫描本机的初步可行性：

| 平台 | 本机凭据形态 | 做 Driver 难度 | 结论 |
|---|---|---|---|
| WorkBuddy | Chromium Session Storage + 私有文件 | 高（私有线协议+CLI 头） | ✅ 已完成（参考实现） |
| Loomy | 明文 `auth-session.json` | 低（标准 OpenAI + traceparent） | ✅ 已完成 |
| **Qoder** | 本地 `.auth` / `.auth-cn` 文件（近明文，形态最像 Loomy） | 低~中（需逆向上游 API） | ✅ **最易的下一个 Driver** |
| **Trae CN** | Chromium Session Storage + Cookies + Trust Tokens（分区） | 高（需解析 LevelDB/Cookies，同 WorkBuddy 类） | ✅ 可行但工作量最大 |

即：Qoder 复用 Loomy 那套「读明文凭据 + 标准 OpenAI 上游」思路最快；Trae 复用 WorkBuddy driver 的「解析 Chromium 存储」思路。两者上游协议都需逆向（同本文对 Loomy 的做法）。

> 注：早期版本曾误写为「反向提取 Qoder/Trae 自有模型不推荐」——那是基于「把它们当消费桥接器的 host」的错误框架。正确路线是它们也作为 Driver 接入本框架。
