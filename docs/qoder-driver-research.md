# Qoder 驱动 — 逆向调研（Research Note, WIP）

> 用途：为把 Qoder（QoderWork CN）也做成 `dsh-llm-bridge` 的 Driver（复用其登录态+额度）积累已逆出的事实。
> 框架定位见根 README 与 `docs/loomy-driver.md`。Qoder 是候选 Driver 中**最难**的一个（见末尾对比）。
> 状态：**凭据 + 鉴权流 + 域名已定位**；**chat 推理路径 + 响应解密待补**（需 live capture 或复现 wasm 解密）。

---

## 1. 本机凭据（Credential）

| 文件 | 内容 | 形态 |
|---|---|---|
| `~/.qoderworkcn/.auth-cn/user` | device / refresh token | 裸字符串（约 88+ 字符，opaque，非 JSON） |
| `~/.qoderworkcn/.auth-cn/id` | 用户/设备 id | 36 字符（疑似 UUID） |
| `~/.qoderworkcn/.status.json` | 登录态快照 | JSON：`logged_in` / `username` / `plan`(Free) / `allow_byok` / `login_method`(browser) / `product`(qoder…) / `version` |

> 与 Loomy 不同：Qoder 凭据是**裸 token 文件**，不是带 `session` 字段的 JSON；且可用 token 是运行时刷新的 `device_token`，不是 `.auth-cn/user` 本身。

---

## 2. 鉴权流（Auth Flow）

**Token 刷新（核心）：**
```
POST https://openapi.qoder.com.cn/api/v1/deviceToken/refresh
Authorization: Bearer <任意或空>
Content-Type: application/json
Body: { "refresh_token": "<来自 ~/.auth-cn/user>" }
→ 200 { device_token, refresh_token, expires_at, refresh_token_expires_at, ... }
```
- `device_token` = 后续所有 API 调用的 **Bearer token**。
- 返回的 `refresh_token` 可写回 `.auth-cn/user` 续期（可选）。
- 源码位置：`out/main/main.js` 的 `auth.refreshDeviceToken`（`/api/v1/deviceToken/refresh`）。

**API 调用鉴权头：** `Authorization: Bearer <device_token>`（见 `openApiJsonRequest`）。

---

## 3. 域名（Domains，来自 app 常量）

| 常量 | 值 | 用途 |
|---|---|---|
| `OPENAPI_DOMAIN` | `openapi.qoder.com.cn` | 鉴权 / 区域节点 / BYOK |
| `CENTER_API_DOMAIN` | `gateway.qoder.com.cn` | center API |
| `INFER_DOMAIN_US/SG/JP` | `gateway.qoder.com.cn` | 推理域（实际节点经 region endpoints 发现） |
| `IM_GATEWAY_DOMAIN` | `openapi.qoder.sh` | IM 网关 |
| TEST 变体 | `test-gateway.qoder.com.cn` / `test-openapi.qoder.com.cn` | 测试环境 |

`resolveAuthEnv()==="test"` 时切测试域。

---

## 4. 推理节点发现（Inference Node Discovery）

模型请求不是打固定域名，而是先发现节点：
```
GET https://openapi.qoder.com.cn/algo/api/v3/service/region/endpoints
Authorization: Bearer <device_token>
→ decryptServerResponse(...) → { inferNodes: [...], fallbackIpMap: {...} }
```
取 `inferNodes[0]` 作为实际 chat 请求目标。健康检查路径 `/algo/api/v1/ping`，标记头 `X-Qoder-HTTPDNS-IP`。

---

## 5. 已知难点（vs Loomy）

1. **响应加密**：服务端响应经 `decryptServerResponse()`（WASM：`qoder-auth-wasm`）解密。模型流大概率同样加密，Driver 需**嵌入该 wasm 复现解密**才能解析。这是比 Loomy（`traceparent` 一个头）大得多的坑。
2. **动态节点**：chat 路径在 `inferNodes` 上，需先跑 region-endpoints 发现，不能硬编码。
3. **token 刷新**：不能像 Loomy 直接拿静态 session 用，要先 refresh 拿 `device_token` 且有过期。

---

## 6. BYOK 旁证

Qoder 设置支持自定义 OpenAI 兼容端点（设置 → 模型 → 自定义），前端拼路径逻辑：
```
n==="anthropic" ? `${base}/v1/messages` : `${base}/chat/completions`
```
证明 Qoder 前端**能讲 OpenAI 格式**。但 Qoder 自有后端的请求 body 是否也是 OpenAI 格式，仍需验证（可能不同）。

`x-qoder-model` / `x-qoder-model-safety-tag` / `x-qoder-session-id` 是 **Qoder 下发的响应头**（给 VM 用），**不是**我们发的请求头——别像 Loomy 的 `traceparent` 那样误当成请求怪癖。

---

## 7. 待解（Open Questions）→ 推荐下一步

- [ ] chat/completions 在 inference node 上的**实际路径**（main.js 未直接暴露，可能前端动态拼或走代理）。
- [ ] 响应 wasm 解密的**复现方式**（提取 wasm 并在 Driver 内调用）。
- [ ] 自有后端请求 body 是否 OpenAI 格式。

**推荐做法**：对一次真实 Qoder 对话做 live capture（MITM 或读运行进程里的 `device_token` + `inferNode`）拿到 chat 路径与流格式，比纯静态逆向 wasm 更快。拿到后按 `src/drivers/loomy/` 模板补 `src/drivers/qoder/`。

---

## 8. 与 Loomy Driver 难度对比

| 维度 | Loomy | Qoder |
|---|---|---|
| 凭据 | 静态明文 session JSON | 裸 refresh token + 运行时 device_token |
| 上游协议 | 标准 OpenAI 兼容（明文） | OpenAI 兼容？ + **响应 wasm 加密** |
| 节点 | 固定 baseURL | 动态 inferNodes 发现 |
| 私有头怪癖 | `traceparent`（请求头） | `x-qoder-*`（响应头，非请求） |
| 估算工作量 | 1x（已落地） | ~2-3x（加密+刷新+发现） |

> 逆向来源：`/Applications/QoderWork CN.app/Contents/Resources/app.asar` 解包至 `out/main/main.js`、`out/renderer/assets/index-C-gQT7kX.js`。

---

## 9. 决定性发现：Qoder 的协议由官方 wasm 生成（2026-09-16 深挖）

结论先行：**Qoder 的凭据加密落盘 + 请求签名/构造 + 响应解密，全部由官方 wasm 完成**；Driver 必须**嵌入该 wasm + 移植最小 glue**，无法像 Loomy 那样手写 HTTP。这是 Qoder 比 Loomy 高一个数量级的根因。

### 9.1 官方 wasm 与导出（可用，已核对）

- 路径：`/Applications/QoderWork CN.app/Contents/Resources/qoder-auth-wasm/qoder_auth_wasm_bg.wasm`（288,929 字节，wasm-bindgen 生成）。
- 导出（`WebAssembly.Module.exports`，共 30 个函数），Driver 需要的核心 4 个：
  | 导出 | 作用 |
  |---|---|
  | `credential_storage_decrypt(data, key)` | **解密 `.auth-cn/user`**（落盘凭据是密文） |
  | `decrypt_server_response(data)` | 解密服务端响应（含模型流） |
  | `model_cache_decrypt/encrypt` | 解密 `.models/catalog-*`（模型目录是加密的） |
  | `qodercontext_new` / `qodercontext_prepareRequest` / `qodercontext_prepareInferRequest` / `qodercontext_refreshAuthFields` / `generate_runtime_auth_fields` | **构造 infer 请求**（返回 `RequestResult{ url, headers, body }`） |
  | `build_httpdns_url` / `get_httpdns_*` | HTTPDNS 路由 |
  | `profile_encrypt` / `profileencryptor_*` | profile 加密 |

### 9.2 凭据是加密落盘的（已实测证实）

- `.auth-cn/user` = **1048 字符 base64 → 784 字节二进制密文**（无 `drt-` 明文）。
- 实测 `POST https://openapi.qoder.com.cn/api/v1/deviceToken/refresh` 传 `.auth-cn/user` 原文 →
  `400 {"errorCode":"DeviceRefreshTokenPrefixInvalid","errorMessage":"invalid refresh_token: must start with drt-"}`。
- ⇒ 真实 refresh token 形如 `drt-…`，**不在磁盘明文**；必须先 `credential_storage_decrypt` 才能拿到。全盘 `grep drt-` 无命中。

### 9.3 glue 有可读副本（移植的起点）

- 协议实现主要在 `node_modules/@qoder-ai/qoder-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs`
  （`@ali/qoder-agent-sdk-next` v1.0.25，31 MB，**混淆**；用自有模块系统 `mn(S8n,{...})`，**非标准 ESM 导出**，`import` 拿不到函数）。
- **但 `out/main/main.js` 里有一份可读的手写最小 glue**：`passStringToWasm0` / `getStringFromWasm0` / `getDataViewMemory0` / `takeObject` / `addHeapObject` / `handleError` / `WASM_VECTOR_LEN` / `__wbg_get_imports()`（@190611）/ `initSync`（@196930）/ `decrypt_server_response` 包装（@189400）。可照此为其余导出补 glue。
- 混淆文件里可见 `credential_storage_decrypt(A,e)` 的包装模式（两参数，均经 `passStringToWasm0`）与 `qodercontext_prepareInferRequest(A,e,t,i)` → `RequestResult.url/.headers`。

### 9.4 待解（阻塞项）

1. `credential_storage_decrypt` 的**第 2 参数**含义（key/context？）——需从调用现场或实验确定。
2. `qodercontext_new/prepareInferRequest` 的**参数语义**（构造 QoderContext 所需字段）。
3. 请求 body 是否 OpenAI 格式（可能由 wasm 生成非同构 body）。
4. 是否另有 macOS Keychain（SDK 打包了 `keytar`）参与 key 派生。

### 9.5 两条实现路线

- **路线 A（推荐，直取额度）**：嵌入官方 wasm + 移植最小 glue，实现 `credential_storage_decrypt` → refresh → `qodercontext_prepareInferRequest` → 发送 → `decrypt_server_response`。
  优点：复用现有登录态；缺点：需移植 wasm glue + 逆清 3 个待解项（**多轮 RE**）。
- **路线 B（绕开落盘加密）**：Driver 自建 **device-flow 登录**（`/api/v1/deviceToken/poll`）自铸 `drt-` refresh token 并自存，绕过 `credential_storage_decrypt`。
  优点：不需要解密落盘凭据；缺点：需用户在浏览器授权一次，且**仍需 wasm** 构造/解密 infer 请求。

> 结论：两条路线都需要 wasm；差别只在「是否解密现有凭据」。**Qoder Driver 是一个多轮工程，不是单次可完成项。**

### 9.6 与 Loomy 的最终难度对比

| 维度 | Loomy | Qoder |
|---|---|---|
| 凭据 | 明文 session，直接可用 | **加密落盘**，需 wasm 解密 |
| 请求构造 | 手写 HTTP（3 个头） | **wasm 生成 url/headers/body** |
| 响应 | 明文 OpenAI SSE | **wasm 解密** |
| 协议可见性 | 源码可读 | 混淆 SDK + wasm |
| 估算 | 1x（已落地） | **5–10x（多轮 RE）** |

---

## 10. PoC 结果（可复现，2026-09-16）

已把 Qoder 的 wasm **跑起来**并调用其导出——**glue 可复用，密码学特征已确认，仅剩 key 来源未知**。

### 10.1 可复现的 glue harness

`out/main/main.js` 的 glue 段（**字符偏移 [189400, 197277]**）是自包含可读的，含 `passStringToWasm0` / `getStringFromWasm0` / `getDataViewMemory0` / `takeObject` / `WASM_VECTOR_LEN` / `__wbg_get_imports()` / `wasm` 变量。抽出后补包装、手动实例化即可用：

```js
const fs = require('node:fs')
const MAIN = '/tmp/qoder-asar-extract/out/main/main.js'                  // app.asar 解包产物
const WASM = '/Applications/QoderWork CN.app/Contents/Resources/qoder-auth-wasm/qoder_auth_wasm_bg.wasm'
const glue = fs.readFileSync(MAIN, 'utf8').slice(189400, 197277)
const stub = `var createCategoryLogger=()=>({info(){},warn(){},error(){},debug(){},trace(){}});`
const w = `
function credential_storage_decrypt(A,e){let t,i;try{
  const l=wasm.__wbindgen_add_to_stack_pointer(-16),
  B=passStringToWasm0(A,wasm.__wbindgen_export2,wasm.__wbindgen_export3),c=WASM_VECTOR_LEN,
  Q=passStringToWasm0(e,wasm.__wbindgen_export2,wasm.__wbindgen_export3),E=WASM_VECTOR_LEN;
  wasm.credential_storage_decrypt(l,B,c,Q,E);
  var n=getDataViewMemory0().getInt32(l+0,!0),r=getDataViewMemory0().getInt32(l+4,!0),
      o=getDataViewMemory0().getInt32(l+8,!0),s=getDataViewMemory0().getInt32(l+12,!0),a=n,g=r;
  if(s)throw a=0,g=0,takeObject(o);return t=a,i=g,getStringFromWasm0(a,g)
}finally{wasm.__wbindgen_add_to_stack_pointer(16),wasm.__wbindgen_export4(t,i,1)}}`
const api = new Function(stub + glue + w + ';return {__wbg_get_imports,setWasm:m=>{wasm=m},credential_storage_decrypt,decrypt_server_response};')()
const mod = new WebAssembly.Module(fs.readFileSync(WASM))
api.setWasm(new WebAssembly.Instance(mod, api.__wbg_get_imports()).exports)   // wasm import module = "./qoder_auth_wasm_bg.js"
// api.credential_storage_decrypt(<.auth-cn/user 文本>, <16字节key>)
```

### 10.2 已确认的结论

- glue 成功 eval + 手动 `WebAssembly.Instance` 成功（imports 命名空间 `./qoder_auth_wasm_bg.js`，31 项）。
- `credential_storage_decrypt(data, key)`：**key 必须恰好 16 字节**（错误 `Key must be 16 bytes, got N`）；错误 key → `Invalid PKCS5 padding` ⇒ 算法为 **AES + PKCS5/PKCS7 填充、16 字节 key（AES-128）**。
- 其余 wasm getter 可用并返回值：`get_httpdns_account_id()`→`"183012"`；`get_httpdns_secret_key()`→32-hex；`get_profile_key_fingerprint()`→64-hex（SHA-256）。
- `decrypt_server_response(data)` glue 亦可用（单参数）。

### 10.3 唯一剩余阻塞：16 字节 key 的来源

已排除：`machine-id`/`.auth/machine_id`/`installation_id` 的原值、去横线前 16、md5/sha1/sha256 前 16、`get_httpdns_secret_key()` 前后 16 字节、以及若干常见 16 字符常量。
⇒ key 由**运行时特定算法**派生（很可能与 machine id 或 keychain 中的 `QoderWork CN Safe Storage` 相关），需在 **`qoder-worker-runtime.obf.mjs` 里定位 `credential_storage_decrypt` 的调用现场**才能确定。

**下一步（交给接手的 agent）**：在 SDK 混淆文件里找到调用 `credential_storage_decrypt` 并构造 16 字节 key 的那段（搜索模块导出 `S8n`/`mn(...)` 的消费方、或 `key:`/`Buffer.from(...)`/`machine` 相关构造），确定 key 派生后即可打通 Qoder Driver。
