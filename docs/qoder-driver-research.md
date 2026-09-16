# Qoder 驱动 — 逆向调研（Research Note）

> 用途：把 Qoder（QoderWork CN）做成 `dsh-llm-bridge` 的 Driver（复用其登录态 + 额度）。
> 框架定位见根 README 与 `docs/loomy-driver.md`。同批调研：`docs/trae-driver-research.md`。
> 状态：**端到端打通**（凭据 → 签名 → 推理 → 流式解密），PoC 见 `scripts/qoder-poc.mjs`。
> 结论：**可实现**，但必须嵌入官方 wasm；工作量约 **3–4x Loomy**（原估 5–10x，因凭据 key 已破解而下调）。

---

## 0. 结论速览

| 项 | 结论 |
|---|---|
| 凭据可读 | ✅ 加密落盘，但 key 已破解（`machine_id[:16]`），**无需 device-flow 重登** |
| 加密可复现 | ✅ `re-encrypt(decrypt(disk)) === disk` —— **逐字节一致** |
| 鉴权 | ✅ 官方 wasm 生成 `Authorization: Bearer COSY.<…>` 与全签名头 |
| 推理端点 | ✅ `POST /algo/api/v2/service/pro/sse/agent_chat_generation` → 200 SSE |
| 请求/响应格式 | ✅ **OpenAI 兼容**（`choices[].delta.content` / `[DONE]`），但 **body 被 must-be-wasm 加密** |
| 模型选择 | ✅ 走 `X-Model-Key` 头（14 个模型，全部 `format=openai`） |
| 与 core 契约的契合 | ✅ 单向转发即可（不像 Trae 是有状态 agent 协议） |
| 剩余风险 | ⚠️ 必须随包分发/内嵌官方 wasm（~289KB，wasm-bindgen）；升级时需重取 |

> **路线 A 胜出（原 §9.5 的 A/B 二选一）**：既然 key 可派生，就不需要 **路线 B** 的 device-flow 浏览器授权。
> 直接读现有登录态即可，走的是用户已登录的账号与额度。

---

## 1. 本机凭据（Credential）

| 文件 | 内容 | 形态 |
|---|---|---|
| `~/.qoderworkcn/.auth-cn/user` | **加密凭据**（`userInfo`） | 1048 字符 base64 → 784 字节密文 |
| `~/.qoderworkcn/.auth-cn/id` | `machine_id`（同时是解密 key 的来源） | 36 字符 UUID 形 |
| `~/.qoderworkcn/.status.json` | 登录态快照（`logged_in` / `plan` / `login_method` …） | 明文 JSON，**不含 token** |
| `~/.qoderworkcn/.models/catalog-*` | 模型目录缓存 | 加密（`model_cache_decrypt`） |
| `~/Library/Keychains/login.keychain-db` | `svce="QoderWork CN Safe Storage"` / `acct="QoderWork CN Key"` | Electron `safeStorage` 随机 key，**与凭据解密无关**（见 §3 注） |

> ⚠️ `.auth-cn/user` 是**唯一可用登录态**；`.auth-cn/id` 与它配对，两者缺一不可。

---

## 2. 凭据解密（决定性突破）

### 2.1 调用现场（`@qoder-ai/qoder-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs`，偏移 3877079）

```js
static decryptCredential(A, e) {              // A = 磁盘密文文本, e = machine_id
  t = GQ().credential_storage_decrypt(A, e.slice(0, 16))
  return { outcome: 'loaded', userInfo: JSON.parse(t) }
}
static async replaceInTransaction(A, e, t) {
  let i = await t()                            // i = machine_id
  let n = GQ().credential_storage_encrypt(JSON.stringify(A), i.slice(0, 16))
  await YJi(i); await LJi(BWA(), n)            // 写回
}
```

### 2.2 key 派生链（原 WIP 卡住的地方）

```js
function mWA(A){ let e = VJi(A); …; return (MK ??= e), A }   // ← 逗号运算符，返回【原始】machine_id，不是哈希
function JJi(A){ let e = await hP(); …; return mWA(e) }      // hP() = 读 machine_id 文件并 trim
function VJi(A){ return sha256(A).digest('hex') }            // MK 只是身份指纹守卫，不是 key
```

于是：

```
key  = machine_id.trim().slice(0, 16)      // 16 个 ASCII 字符
data = .auth-cn/user 的 base64 原文         // wasm 内部自行 base64 解码
```

**关键反直觉点**：`key` 是**纯 ASCII 字符串**，不是二进制。这正是此前把所有「二进制 key 候选」都试失败的原因——`passStringToWasm0` 走 UTF-8，二进制会被撑长（`Key must be 16 bytes, got 25`）。

例（值已脱敏）：`machine_id = "<uuid 形 36 字符>"` → `key = "<前 16 个字符>"`。

### 2.3 密码学特征（实测）

- 算法 **AES**（16 字节 key ⇒ AES-128），padding 为 **PKCS5/PKCS7**（错误 key ⇒ `Invalid PKCS5 padding`；长度错 ⇒ `Key must be 16 bytes, got N`）。
- 输入非 base64 ⇒ `Corrupt input at byte N` / `Invalid symbol N`（证实 wasm 内部先 base64 解码）。
- **可逆性已验证**：`credential_storage_encrypt(JSON.stringify(userInfo), key)` 产出的密文与磁盘原文**逐字节相同**，说明加密是确定性的（固定 key + 固定 IV/派生）。

### 2.4 解出的 `userInfo` 字段（25 个）

```
uid / aid                <uuid>
name                     <redacted>
avatar_url               https://qoder.com.cn/users/<uid>/default/avatars
access_token             "dt-…"（27 chars）    ← 设备 token（短命）
security_oauth_token     "dt-…"（同 access_token）
refresh_token            "drt-…"（28）     ← **不在磁盘明文，必须解密才有**
expire_time              1783558148000（ms）→ 2026-07-09（易过期）
refresh_token_expire_time 1812070148000 → 2027-06-04
personal_access_token    ""（BYOK/PAT 场景才用）
login_method             "browser"
user_type                "personal_professional"   user_tag "Pro"
organization_id / organization_tags   "" / null
data_policy_agreed       true
encrypt_user_info / key  ""  ← 见 §4，**这两个是运行时派生，不是存储值**
allow_byok               0
```

> ⚠️ `token` / `refresh_token` 含 PII，实现时**不得**打印或入库。

---

## 3. 域名与鉴权

| 常量 | 值 | 用途 |
|---|---|---|
| `OPENAPI_DOMAIN` | `openapi.qoder.com.cn` | 鉴权 / 区域节点 / token 刷新 |
| `CENTER_API_DOMAIN` / `INFER_DOMAIN` | **`gateway.qoder.com.cn`** | center + 推理（节点发现后确定） |
| `IM_GATEWAY_DOMAIN` | `openapi.qoder.sh` | IM 网关 |
| 路径前缀 | 所有路径经 `Sv()` 拼成 `{base}/algo{path}` | — |

**Token 刷新（`drt-` → `dt-`）：**

```
POST https://openapi.qoder.com.cn/api/v1/deviceToken/refresh
Body: { "refresh_token": "<drt-…>" }
→ 200 { device_token:"dt-…", refresh_token:"drt-…", token_type:"Bearer",
        expires_at, refresh_token_expires_at, created_at }
```

> ❗**`refresh_token` 会轮换**（实测：旧 `drt-` fp `99dfb047477f` → 新 `570c54daf66c`）。
> 因此 Driver **必须在刷新后把新凭据加密写回** `.auth-cn/user`，否则用户端 App 下次启动会因 refresh token 失效而被迫重登。
> 写回方式：`credential_storage_encrypt(JSON.stringify(userInfo), key)` → 原子替换。SDK 自身亦如此（`replaceInTransaction`）。

**节点发现（纯 HTTP，不需 wasm 签名）：**

```
GET {center}/algo/api/v4/service/region/endpoints        （或 v3 + mode=sign）
Authorization: Bearer <dt-…>
Cosy-MachineId: <machine_id>   Cosy-MachineToken: <machine_token || machine_id>
→ 加密响应 → decrypt_server_response →
  { centerNodes, inferNodes, openapiNodes, nesNodes, dataNodeMap, fallbackIpMap }
本机实测：inferNodes = ["https://gateway.qoder.com.cn"]
```

---

## 4. QoderContext — 请求签名/加密（必须用官方 wasm）

### 4.1 三条完整链路（已复现）

```js
// ① 派生运行时 auth 字段（SDK: regenerateRuntimeFields()）
let gen = JSON.parse(GQ().generate_runtime_auth_fields(JSON.stringify({
  uid, organization_id, organization_tags, data_policy_agreed    // organization_tags 必须是【数组】
})))
// → { encrypt_user_info: "<172 chars>", key: "<172 chars>" }     ← 每次确定性生成

// ② 建上下文（SDK: createWasmContext()）
let authInfo = JSON.stringify({ uid, encrypt_user_info, key,
  organization_id, organization_tags, data_policy_agreed })
let ctx = new QoderContext(machine_id, COSY_VERSION /* "1.1.26" */, authInfo,
  JSON.stringify({ client_type, business_product, business_type, scene }))

// ③ 每次 token 刷新后（SDK: refreshAuthFields）
ctx.refreshAuthFields(authInfo)
```

> ⚠️ **漏掉 ① 或 ③，所有鉴权请求都会 403 `{"code":"101","message":"Signature invalid"}`。**
> 这是本调研踩到的最深的坑：凭据里 `encrypt_user_info`/`key` 是空串，必须由 wasm 现场派生。

### 4.2 `prepareRequest` / `prepareInferRequest`

```js
ctx.prepareRequest(base, path, method, mode /* "auth" | "sign" */, body?, extra?)
ctx.prepareInferRequest(base, bodyJson, modelKey, modelSource)
// 两者都返回 RequestResult { url, headers:Map, body, headerCount, free() }
```

- `mode="sign"`：匿名签名（只加 `Signature` 头），实测 `region/endpoints` **200**。
- `mode="auth"`：COSY 凭据，`Authorization: Bearer COSY.<base64(payload)>.<32hex sig>`。
- `prepareInferRequest` 额外产出：`X-Model-Key` / `X-Model-Source`，并把 **body 加密**（URL 自动加 `Encode=1`）。
- wasm 生成的头部还包括：`Appcode:cosy`、`Cosy-ClientType:5`、`Cosy-Scene:assistant`、`Cosy-Version:1.1.26`、`Cosy-User`、`Cosy-Key`、`Cosy-Data-Policy`、`Login-Version:v2`、`Cosy-Date`。
- 客户端层（SDK `injectClientIdentityHeaders`）会再补 `Cosy-Version` / `Cosy-ClientType` / `Cosy-MachineOS` / `Cosy-MachineHostname`（后者仅 infer-sse）。

> ❗**不要**用裸 `dt-` 覆盖 `Authorization`——那是 wasm 生成的 COSY token，覆盖即签名失效。

---

## 5. 推理协议（端到端实测）

**端点**（`S4a`，wasm 自动补 `&Encode=1`）：
```
POST {infer}/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common
```

**请求 body —— OpenAI 形状**（这回答了旧版文档 §7 的待解项）：
```jsonc
{
  "model": "<model_key>",                 // 亦可用 "auto"
  "messages": [{ "role": "user", "content": "Reply with exactly: PONG" }],
  "stream": true,
  "request_id": "<uuid>", "session_id": "<uuid>", "task_id": "<uuid>"
}
// SDK 侧完整形状见 zNr()：{ model, messages, tools?, stream, temperature?, max_tokens?,
//   stop?, parameters?, patches?, reasoning_effort?, request_id, request_set_id,
//   session_id, task_id?, business?, custom_model? }
```

**响应**：`text/event-stream`，**逐帧为一个信封**：
```jsonc
{"headers":{"Content-Type":["application/json"]},
 "body":"{\"choices\":[{\"delta\":{\"content\":\"P\",\"role\":\"assistant\"},\"index\":0}],\"created\":…,\"id\":\"chatcmpl-…\"}",
 "statusCodeValue":200,"statusCode":"OK"}
```
- 末帧 `body = "[DONE]"`；另有 `event:finish` + 计时帧 `{firstTokenDuration,totalDuration,serverDuration}`。
- **关键**：SSE 帧是**明文 JSON**（不需解密）；而 `region/endpoints`、`model/list` 是**加密文本**。
  ⇒ 实现必须照抄 SDK 的 `AaA()`：**先试 `decrypt_server_response`，失败即当明文**。

**实测结果：**
```
$ node scripts/qoder-poc.mjs chat auto "Reply with exactly: PONG"
POST https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation?…
http 200 text/event-stream;charset=UTF-8
PONG
[frames=5 finish=true]
```

**错误 oracle（服务端会明说）：**
| 现象 | 含义 |
|---|---|
| `403 {"code":"101","message":"Signature invalid"}` | auth 字段未派生 / COSY token 被覆盖 |
| `403 {"code":"103","message":"Duplicate request"}` | 同一签名（request id）复用；每次请求需新 context |
| `Invalid user info: missing field \`encrypt_user_info\`` | 构造函数收到的 userInfo 不完整 |
| `Invalid user info: invalid type: null, expected a sequence` | `organization_tags` 传了 `null`，必须是 `[]` |

---

## 6. 模型目录（`GET /api/v2/model/list?Encode=1`，auth 模式，实测 200 / 72100 字节）

按 scene 分组（`chat` / `developer` / `assistant`），**14 个模型，全部 `format=openai`、`source=system`**：

| key | display_name | key | display_name |
|---|---|---|---|
| `auto` | Auto | `dfmodel` | DeepSeek-Flash |
| `qmodel_38max` | Qwen3.8-Max | `gmodel` | GLM-5.3 |
| `qfmodel` | Qwen3.8-Flash | `gfmodel` | GLM-5.3-Flash |
| `qmodel_latest` | Qwen3.7-Max | `gm51model` | GLM-5.2 |
| `qmodel` | Qwen3.7-Plus | `kmodel_latest` | Kimi-K3 |
| `q37fmodel` | Qwen3.7-Flash | `kmodel` | Kimi-K2.8-Preview |
| `dmodel` | DeepSeek-V4-Pro | `mmodel` | MiniMax-M2.7 |

> 注：响应里的 `model` 字段恒回 `auto`（装饰性）；**真正的模型选择是 `X-Model-Key` 头**。
> 模型自述身份不可靠（`dmodel` 自述为 Qwen），是否需要按 key 二次校验待定。

---

## 7. 实现路径（Driver 落地）

```
src/drivers/qoder/
  auth.ts      读 .auth-cn/{id,user} → key=machine_id[:16] → wasm 解密 → userInfo
               刷新（drt- → dt-）→ 加密写回（轮换后必须写回）
  wasm.ts      内嵌 qoder_auth_wasm_bg.wasm + 最小 glue（本仓库 PoC 已可直接搬）
  upstream.ts  ctx.prepareInferRequest(...) → POST → safeDecrypt → 转成 SSE 吐出
  catalog.ts   GET /api/v2/model/list?Encode=1 → 14 个模型映射
  meta/shim/heartbeat/plugin/cli/status-paths/adapter   ← 照 loomy/ 模板
```

**wasm 与 glue 的取得方式（关键工程细节）**

- wasm 官方文件：`/Applications/QoderWork CN.app/Contents/Resources/qoder-auth-wasm/qoder_auth_wasm_bg.wasm`（288,929 字节）。
- **glue 无需逆向**：App 打包里有一份**未混淆**的 wasm-bindgen 胶水（`out/main/main.js`），
  用锚点 `function decrypt_server_response(` → `let initialized$1=!1;` 可从 `app.asar`
  直接切出（7877 字节，PoC 即此法，见 `scripts/qoder-poc.mjs` 的 `extractGlue()`）。
- 需从混淆 SDK 移植的只有 4 个类/函数包装（`QoderContext`、`RequestResult`、
  `credential_storage_decrypt/encrypt`、`generate_runtime_auth_fields`），PoC 已全部写好。
- 分发形态待定：随包内嵌 wasm（287KB）vs. 运行时从本机 App 读取（要求已装 Qoder）。

---

## 8. 与 Loomy / Trae 的对比

| 维度 | Loomy | **Qoder** | Trae |
|---|---|---|---|
| 凭据 | 明文 session JSON | 加密落盘，key=`machine_id[:16]` | 自研 byteCrypto，key 内嵌密文 |
| 请求构造 | 手写 HTTP（3 个头） | **wasm 生成 url/headers/body（body 加密）** | 有状态 agent 协议 |
| 响应 | 明文 OpenAI SSE | 混合：SSE 明文 / 其余加密 → `decrypt-or-passthrough` | 有状态 agent 协议 |
| 节点 | 固定 baseURL | 动态 `inferNodes` 发现 | 固定网关 |
| 上游协议形状 | OpenAI | **OpenAI** | 非补全（不可桥接） |
| 能否做 Driver | ✅ 已落地 | ✅ **可行（PoC 已通）** | ❌ 不可行（已排除） |
| 估算工作量 | 1x | **3–4x** | — |

---

## 9. 踩坑清单（实现时逐条对照）

1. **key 是 ASCII 不是二进制**——`machine_id.trim().slice(0,16)`。
2. **凭据 key 文件在本版本叫 `id`**，而 SDK 源码里写的是 `machine_id`（路径常量 `join(.auth, 'machine_id')`），别照抄常量。
3. **`encrypt_user_info` / `key` 必须由 `generate_runtime_auth_fields` 现场派生**，不能从磁盘读（磁盘上是空串）。
4. **`organization_tags` 必须是数组**，`null` 会被拒。
5. **不要覆盖 wasm 生成的 `Authorization`**。
6. **`refresh_token` 会轮换**，刷新后必须加密写回，否则用户 App 掉登录。
7. **响应解密要带 fallback**（`AaA()`）：SSE 帧本来就是明文。
8. **同一 context 复用同一 request id 会被判 `Duplicate request`**；每次请求新建 context。
9. **`.auth-cn/user` 是 base64 文本，不是裸密文**；wasm 内部自行 base64 解码，输入必须是文本。
10. Keychain 里的 `QoderWork CN Safe Storage`（Electron `safeStorage`）**与凭据解密无关**，别走错路。

---

## 10. 可复现命令

```bash
node scripts/qoder-poc.mjs auth               # 解密凭据 + 派生校验 + 逐字节往返校验
node scripts/qoder-poc.mjs models             # 14 个模型（3 个 scene）
node scripts/qoder-poc.mjs chat auto "…"      # 真实对话（流式）
node scripts/qoder-poc.mjs refresh            # 只看轮换情况，不写盘
node scripts/qoder-poc.mjs refresh --write    # 刷新并加密写回（自动备份 .bak-<ts>）
```

> 逆向来源：`/Applications/QoderWork CN.app/Contents/{Resources/app.asar,Resources/qoder-auth-wasm/}`，
> 解包至 `/tmp/qoder-asar-extract`；`@qoder-ai/qoder-agent-sdk` v1.0.25 的 `_worker/qoder-worker-runtime.obf.mjs`（31MB，混淆）。
