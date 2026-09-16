# Qoder 驱动 — 逆向调研（Research Note）

> 用途：把 Qoder（QoderWork CN）做成 `dsh-llm-bridge` 的 Driver（复用其登录态 + 额度）。
> 框架定位见根 README 与 `docs/loomy-driver.md`。同批调研：`docs/trae-driver-research.md`。
> 状态：**驱动已落地并跑通真实链路**（`src/drivers/qoder/`）。逆向阶段的 PoC 保留为
> `scripts/qoder-poc.mjs`（协议探针，可单独跑）；作为回归基线的是
> `scripts/live-e2e-qoder.mjs`（走完整 driver → pi-ai → shim → 真实网关）。
> 结论：**可实现且已实现**；代价是必须内嵌官方 wasm（~289KB），工作量约 **3–4x Loomy**
> （原估 5–10x，因凭据 key 已破解而下调）。

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
| 对 `src/core/` 的改动 | ✅ **零改动**（信封拆解在 driver 内完成，见 §7.1） |
| 剩余风险 | ⚠️ 内嵌官方 wasm（~289KB）；App 升级后需 `node scripts/vendor-qoder-wasm.mjs` 重取 |
| 落地状态 | ✅ `src/drivers/qoder/` 已实现；离线 106 用例 + `scripts/live-e2e-qoder.mjs` live 回归均通过 |

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
- **分发形态已定：随包内嵌 wasm**（见 §7.1）。运行时从本机 App 读取意味着「没装 Qoder 就
  连目录都注册不了」，而且 App 升级会把文件换掉——内嵌只让升级表现为「重新 vendor 一次」。

### 7.1 落地结果（as shipped）

实际落盘的模块（比草案多出的是对外可见面与升级工具）：

```
src/drivers/qoder/
  meta.ts         两台主机、COSY 版本、auth 目录布局、client metadata
  credential.ts   纯派生：key、userInfo→credential、refresh 归一化、merge
  auth.ts         QoderCredentialStore：发现 → 解密 → 按需刷新 → 加密写回
  wasm.ts         内嵌 wasm 的装配与调用（含 openServerPayload 的 try-fallback）
  vendor/artifacts.ts   GENERATED，base64 内嵌 wasm + glue，勿手改
  upstream.ts     节点发现、签名推理、SSE 信封拆解、刷新、模型目录
  catalog.ts      14 个模型的静态 fallback（上游刷新后整体替换）
  adapter.ts      catalog → pi-ai 描述符（图片、思考档位、费率/徽章后缀）
  shim.ts / heartbeat.ts / status-paths.ts / web-status.ts / cli.ts / plugin.ts
  client/         QoderPluginCard + locales（设置页卡片）
scripts/vendor-qoder-wasm.mjs    App 升级后重新 vendor（带 11 个必需导出断言）
scripts/live-e2e-qoder.mjs       完整链路的 live 回归（见 §10）
tests/qoder/                     7 个 spec，106 个离线用例
```

**本案与草案不同的四处判断**（都是实测逼出来的，不是偏好）：

1. **信封拆解放在 driver，不放 core**。core 的 shim 把 driver 返回的 body **原样**转发，
   所以 `translateQoderStream()` 必须在 driver 里把信封的 `body` 字符串拆出来、重新拼成
   普通 `data: <chunk>` 帧。core 一行没改——这正好验证了当初「core 不含平台语义」的拆分。
2. **不做「关闭思考」开关**。实测推理端点**接受任意 `reasoning_effort` 字符串**（含无意义取值，
   全部 200），所以没有任何拼写能被证明等于「关」。只把 catalog 明确声明的档位映射进
   pi-ai 的 `thinkingLevelMap`，`off` 恒为 `null`（即默认不发该字段）。宁可没有开关，
   也不要一个看起来生效、实际服务端继续思考的开关。
3. **请求体近乎原样透传**。实测反序列化很宽松（未知字段、`tool_choice`、`tools`、
   `max_completion_tokens`、`developer` 角色都 200），所以不收缩成白名单——白名单会静默
   丢掉平台其实支持的能力。只做三件事：强制 `stream:true`、盖新的 `request_id`/`task_id`
   （保留 `session_id`）、把 `developer` 改写成 `system`（`system` 才是确定生效的拼写）。
4. **轮换写回带乐观并发**。写盘前先「重加密→解密→比对」，再做时间戳备份，再
   `write temp + rename`；若发现磁盘上的内容不是本次刷新开始时的那一份（App 自己先刷了），
   就放弃写入、改读 App 的新凭据。写错一个字节就毁掉用户登录态，这几步一个都不能省。

`enable: false` 的模型（如 `dmodel`）**不从目录里过滤**：那是 UI 默认值，不是能力上限，
实测可以正常驱动。


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

上表每条都已落进离线用例，改代码时对着跑：

| 坑 | 守护它的用例 |
|---|---|
| 1 / 9 key 派生与 base64 文本 | `tests/qoder/credential.spec.ts`、`tests/qoder/wasm.spec.ts`（确定性封印 + 往返） |
| 2 `id` / `machine_id` 两种文件名 | `tests/qoder/auth.spec.ts`（两种文件名都解析；半个候选目录必须跳过） |
| 3 现场派生 auth fields | `tests/qoder/upstream.spec.ts`（签名后 body 与入参不同、`X-Model-Key` 正确） |
| 4 / 10 `organization_tags` 非空数组 | `tests/qoder/wasm.spec.ts`（`null` 必须抛错） |
| 5 不覆盖 wasm 的 `Authorization` | `tests/qoder/upstream.spec.ts` |
| 6 refresh 轮换写回 | `tests/qoder/auth.spec.ts`（写回、备份、并发被抢占、round-trip 失败拒绝写） |
| 7 响应解密 fallback | `tests/qoder/upstream.spec.ts`（明文帧 / 加密封帧两条路径） |
| 8 每请求新建 context | `tests/qoder/upstream.spec.ts` |

---

## 10. 可复现命令

```bash
# 协议探针（逆向阶段产物，绕过 driver 直接打协议）
node scripts/qoder-poc.mjs auth               # 解密凭据 + 派生校验 + 逐字节往返校验
node scripts/qoder-poc.mjs models             # 14 个模型（3 个 scene）
node scripts/qoder-poc.mjs chat auto "…"      # 真实对话（流式）
node scripts/qoder-poc.mjs refresh            # 只看轮换情况，不写盘
node scripts/qoder-poc.mjs refresh --write    # 刷新并加密写回（自动备份 .bak-<ts>）

# 完整链路 live 回归（driver → pi-ai → shim → 真实网关）
npm run build && node scripts/live-e2e-qoder.mjs          # 默认 auto
node scripts/live-e2e-qoder.mjs dmodel                    # 指定模型

# App 升级后重新 vendor 内嵌资产
node scripts/vendor-qoder-wasm.mjs
```

**最后一次 live 回归的结果**（2026-09-16，`QoderWork CN` 已登录 `Pro`）：

| 观察点 | 结果 |
|---|---|
| shim | `http://127.0.0.1:51708` |
| 静态目录 | 14 个模型（与上游一致） |
| 节点发现 | `https://gateway.qoder.com.cn` |
| 上游目录 | 14 个模型，与静态 fallback 完全一致 |
| `auto` | `Auto · x0.5`，无思考档位，context 180000 → `"链路验证成功"`，911ms |
| `dmodel` | `DeepSeek-V4-Pro · x0.8`，档位 `high/max`，context 200000 → `"链路验证成功"`，550ms |
| 分块类型 | `block-start` / `text-delta`×2 / `block-end` / `usage` / `finish` |
| 凭据轮换 | 本次未触发（token 有效期至 2026-10-16）；但此前探针已实跑过一次写回，`.auth-cn/` 里留着 `user.bak-2026-09-16T11-27-23-453Z` |

> 逆向来源：`/Applications/QoderWork CN.app/Contents/{Resources/app.asar,Resources/qoder-auth-wasm/}`，
> 解包至 `/tmp/qoder-asar-extract`；`@qoder-ai/qoder-agent-sdk` v1.0.25 的 `_worker/qoder-worker-runtime.obf.mjs`（31MB，混淆）。
