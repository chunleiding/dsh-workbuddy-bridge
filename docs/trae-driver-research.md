# Trae CN 驱动 — 逆向调研（Research Note）

> 用途：评估把 Trae CN（`Trae CN.app`，内部代号 **iCube**）做成 `dsh-llm-bridge` 候选 Driver 的可行性。
> 框架定位见根 README 与 `docs/loomy-driver.md`。同批调研：`docs/qoder-driver-research.md`。
> 状态：**凭据已完整解出并实测可用**；**模型面不是补全 API，而是有状态 agent 协议 → 当前 core 契约下不可桥接**（见 §6/§7）。

---

## 1. 结论（先说结果）

| 项 | 结论 |
|---|---|
| 本机凭据可读 | ✅ **可解**（自研 byteCrypto 信封，密钥内嵌密文；已完整复现，见 §3） |
| Bearer 可用 | ✅ token 直连网关，多个端点 200（§5.1） |
| 模型面形态 | ⚠️ `llm_utils_chat` 只暴露**工具函数**（仅 `chat`→FastApply 代码改写模型）；真正的对话是 **`/api/ide/v1/chat` + `/api/agent/v3/*` 有状态 agent 协议**（§5.3） |
| 能否做成 Driver | ❌ **当前 core 契约下不可行**。core 的 `BridgeUpstream.chat()` 假设上游是「OpenAI 形状/单次补全」；Trae 提供的是 agent 会话协议（服务端建 prompt + 会话状态） |
| 反向（把桥接器接进 Trae） | ✅ 很可能可行且**零逆向**：Trae 原生支持自定义模型（BYOK），见 §7 |

---

## 2. 凭据落盘位置

| 文件 | 说明 |
|---|---|
| `~/Library/Application Support/Trae CN/User/globalStorage/storage.json` | Trae 的 `IStorageService`（VSCode 系）应用级存储；`iCubeAuthInfo://*` 键在此 |
| `iCubeAuthInfo://icube.cloudide` | **主凭据**（authProviderId = `icube.cloudide`，来自 `product.json`）→ 解出 userInfo（token/refreshToken/过期/账号） |
| `iCubeAuthInfo://usertag` | `{ "<userId>": "cn" }` 地区标签 |
| `iCubeAuthInfo://icube-dc:<userId>` | 设备密钥对（`privateKeyPEM` / `publicKeyPEM`） |

> `Cookies` 为空、Session/Local Storage（leveldb）内**无** `eyJ` 明文 JWT；
> `state.vscdb` 里只有一条 `secret://{"extensionId":"trae.ai-code-completion","key":"isActivated"}`。
> 即：**唯一可用的登录态就是 `iCubeAuthInfo`**，且它是加密的。
>
> 另注：`vs/platform/encryption/.../encryptionMainService.js`（Electron `safeStorage`，落盘形如 `{"type":"Buffer","data":[...]}`）**不**用于 `iCubeAuthInfo`，别走错路。

---

## 3. 凭据解密（自研 byteCrypto，已完整复现）

**实现在** `app/out/main.js`：
- `out-build/vs/base/common/byteCrypto.js` —— 加解密原语（`Y1` 加密 / `d_` 解密；`NWe/RWe/DWe/Moe/AWe/IWe/PWe`）
- `out-build/vs/platform/iCubeAuth/electron-main/components/userStorage.js` —— 调用点（`getUserInfoFromLocalStorage` → `d_(base64)`）

### 3.1 信封格式

```
blob = base64_decode(storage.json 的值)
     = [ 6B magic ][ 32B 内嵌 key ][ AES-128-CBC 密文 ]
magic = 74 63 05 10 00 00   ('t' 'c', ver=5, ivLen=16, 0, 0)   ← 版本判定为 AES
```
`IWe()` 用 magic 判版本：`t[0]=116,t[1]=99,t[2]=5,t[3]=16,t[4]=0,t[5]=0` → `Nn.AES`。
（另有 `AES_PRIVATE`/`SS_V1..V3` 变体，本机命中 `AES`。）

### 3.2 key/iv 派生（关键）

```
h1   = SHA512( key32 )                 // 64B
mask = joe[0..63] XOR Voe[0..63]       // 64B，常量见下（版本 AES 用 joe^Voe）
h2   = SHA512( h1 || mask )            // 64B
aesKey = h2[0:16]                      // AES-128
iv     = h2[16:32]
```

两个 64 字节常量（从 `byteCrypto.js` 原样抄出，**复现所需**）：

```js
joe = [82,9,106,213,48,54,165,56,191,64,163,158,129,243,215,251,124,227,57,130,155,47,255,135,
       52,142,67,68,196,222,233,203,84,123,148,50,166,194,35,61,238,76,149,11,66,250,195,78,
       8,46,161,102,40,217,36,178,118,91,162,73,109,139,209,37]
Voe = [31,221,168,51,136,7,199,49,177,18,16,89,39,128,236,95,96,81,127,169,25,181,74,13,45,229,
       122,159,147,201,156,239,160,224,59,77,174,42,245,176,200,235,187,60,131,83,153,97,23,43,
       4,126,186,119,214,38,225,105,20,99,85,33,12,125]
```

### 3.3 明文布局（含完整性校验）

```
plaintext = AES-128-CBC-decrypt( ciphertext, aesKey, iv )    // Node 默认 PKCS7
          = [ 64B SHA512(body) ][ body ]
body      = JSON UTF-8；校验 SHA512(body) === 前 64B，不符则视为损坏
```

### 3.4 解出的 userInfo 字段

```
token             : JWT(RS256)，~1004 字符        ← 即 x-ide-token
refreshToken      : ~61 字符
expiredAt         : 2026-09-30T05:35:25.367Z
refreshExpiredAt  : 2027-03-15T05:35:25.367Z
tokenReleaseAt    : 2026-09-16T05:35:25.429Z
userId            : <redacted>
host              : https://api.trae.cn            ← 账号域（非模型域！）
userRegion        : { region: "CN", _aiRegion: "CN" }
account           : { scope: "marscode", userTag: "cn", email/avatar/... }
JWT claims        : { data:{ id, source:"refresh_token", source_id, tenant_id }, exp, iat }
```

> ⚠️ `token`/`refreshToken` 是账号凭据，含 PII（`account.email`）；实现时**不得**打印或入库。

---

## 4. 鉴权与域名

**请求头（两条都带，实测有效）：**
```
x-ide-token: <JWT>
Authorization: Bearer <JWT>
```

**域名（`product.json` → `iCubeApp.nativeAppConfig` / 各 service 段）：**

| 常量 | 值 | 用途 |
|---|---|---|
| `account.trae.normal` | `https://api.trae.cn` | 账号/登录域（**不是**模型域） |
| `agent/remote/ckg/cue.trae.normal` | **`https://trae-api-cn.mchost.guru`** | **模型 / agent / 商业额度 网关** |
| `authProviderId` | `icube.cloudide` | 存储键后缀 |
| `agent.appId` | `6eefa01c-1036-4c7e-9ca5-d891f63bfcd8` | `llm_utils_chat` 必填 `app_id` |
| app 版本 | `3.3.100`（`app_version`） | `app_version_code` 用 int（未校验具体值） |

> 坑：同一路径打到 `api.trae.cn` 全部 404（LB 返回 HTML `TLB`）；必须用 `trae-api-cn.mchost.guru`。

---

## 5. 协议实测

### 5.1 已验证可用（200）

```
GET  /api/v1/commercial/get_session_usage          → 200 JSON（逐会话用量）
GET  /api/v1/commercial/get_user_activity          → 200 {"activity_map":{}}
GET  /api/ide/v1/get_custom_model_type_config      → 200 {"message":"success"}
GET  /api/ide/v1/code_completion/model_configs     → 200（补全模型映射，如 CodeZ）
GET  /api/ide/v1/features                          → 200（功能+配置）
POST /api/agent/v3/llm_utils_chat                  → 200 text/event-stream（见 5.2）
```

日志中另见（未逐一实测）：`/api/v2/pay/ide_user_ent_usage`、`/api/v2/pay/user_current_entitlement_list`、
`/api/v2/pay/cn_credits_billing_status`、`/api/v2/ug/activity/info`、`/api/v1/pay/query_user_usage_group_by_session`（额度/签到族，域名待确认）。

### 5.2 `llm_utils_chat` 请求/响应（已测通）

**请求体（服务端当 oracle 逐步试出，缺字段会明确报错）：**
```jsonc
{
  "app_id": "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8",  // 必填
  "app_version_code": 330100,                        // 必填，int64
  "messages": [                                       // content 必须是【数组】
    { "role": "user", "content": [ { "type": "text", "text": "..." } ] }
  ],
  "function": "chat",                                 // 服务端白名单，见下
  "model_name": "DeepSeek-V4-Flash-Official",         // 实测被忽略
  "conversation_id": "<uuid>", "session_id": "<uuid>",
  "request_seq": 1, "is_remote_req": true
}
```
**响应（SSE，`event:` + `data:` 成对）：**
```
event: metadata     data: {model, session_id, prompt_completion_id, ...}
event: timing_cost  data: {provider_model_name, first_sse_event_time, ...}
event: output       data: {response, reasoning_content, tool_calls, multimodal_contents, phase}
event: token_usage  data: {...}
event: done         data: {"finish_reason":"stop"}
event: error        data: {code, message, extra}
```

**服务端错误 oracle 顺带确认**：`scene_params` 必须是 **string**；`app_version_code` 必须 **int64**；
`function` 缺失 → `[LLMUtilsChat.resolveByUsage] function is empty`。

### 5.3 ⚠️ 为什么这不是通用对话（阻塞点）

- `function` 白名单**只有 `chat`** 被配置；`timing_cost.provider_model_name` = **`FastApply-Gateway`**
  —— 即它映射到「代码改写/FastApply」模型，不是通用助手。
- 实测：无论传哪个 `model_name`（`DeepSeek-V4-Flash-Official` / `glm-5.3-flash` / `Doubao-Seed-2.1-Pro`），
  回包都是同一批 ~20000 个 `output` 事件、跑飞的代码块（忽略 `system` 提示、不遵守「只回答 PONG」）。
- 其它候选 function 名（`side_chat` / `ide_chat` / `chat_completion` / `general_chat` / `code_chat` / `agent_chat` / `default` …）
  一律 `no function config found for appId=..., function=X`。

**真正的对话面是有状态 agent 协议：**
- `POST /api/ide/v1/chat` → 200 `text/event-stream`（参数不足时 `event: error` code 4001，通用话术，不泄露字段）。
- 主 chat 请求结构（从 `libharness.dylib` 符号串还原）含：`turn_id` / `seq_offset` / `history_id_list` /
  `missing_history` / `deleted_message_ids` / `next_min_message_index` / `agent_run_info` / `agent_dsl` /
  `raw_rules` / `custom_agent_list` / `mcp_tool_list` / `render_context` / `ab_info` / `centralized_settings` …
- 亦即：**prompt 由服务端拼装、会话状态由服务端持有**，客户端只发增量。这无法映射到 core 的
  「OpenAI 形状请求 → 上游流」单向转发契约（core 连响应都不做翻译，见 `src/core/types.ts` 的注释）。

**协议代码位置**（原生二进制，非 JS）：`app/modules/ai-agent/libai_agent.dylib`（~200MB）、`libharness.dylib`（~165MB）。
端点串里还可见 `/api/agent/v3/{create_agent_task,commit_toolcall_result,compact,workflow/*,...}`。

---

## 6. 参考数据（日志中出现的真实模型名）

`deepseek-v4.1-flash`、`DeepSeek-V4-Flash-Official`、`DeepSeek-V4-Pro-Official`、`Doubao-Seed-2.1-Pro`、
`Doubao-Seed-2.1-Turbo`、`Doubao-Seed-Code`、`Doubao-Seed-Evolving`、`glm-5.3`、`glm-5.3-flash`、`glm-5.2`、
`kimi-k3`、`kimi-k2.8-preview`、`minimax-m3`、`qwen-3.7-plus`、`qwen3.8-max`、`qwen3.8-flash`、`Atria-Dawn-Preview`
（出自 `~/Library/Application Support/Trae CN/logs/**` 的 `model_name` 字段，可与 WorkBuddy/Loomy 的名单交叉参考）。

---

## 7. 建议与下一步

1. **Trae 不作为 Driver 落地**（理由见 §5.3）。继续投入会变成「在客户端复现 Trae 的 agent 会话协议」，与框架
   「复用登录态 + 额度、把平台原生补全协议接进 loopback」的定位不是一回事，工作量也远超 Loomy/WorkBuddy。
2. **反向仍有价值**：Trae 原生支持自定义模型（`/api/ide/v1/get_custom_model_type_config`、
   `/api/agent/v3/custom_model_connectivity_check`，二进制含 `custom-model-proxy-client` crate）。
   若只是想在 Trae 里用别的模型，走 GUI 自定义模型即可，**零逆向**。
3. **可复用资产**：§3 的 byteCrypto 复现是自包含的（无外部依赖，Node 内建 crypto 即可）。
   若后续任一 ByteDance 系客户端（Trae/CloudIDE/marscode）出现**补全形状**的模型面，这套凭据解密可直接复用。
4. 本文档保留为「已排除/已知边界」记录，避免重复调研。
