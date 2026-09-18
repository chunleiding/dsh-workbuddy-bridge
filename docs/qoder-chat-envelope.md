# Qoder 千问 Flash 报 `Execution failed: null`：信封结构定位与修复记录

日期：2026-09-18
状态：**已修复并验证**（commit `0bbdb4c`；236 个测试全过；qfmodel / qmodel_38max 真实链路均成功）
适用范围：Qoder 驱动（`src/drivers/qoder/`），QoderWork CN App 0.9.17 / worker runtime 1.1.26

本文同时是一份**调试方法教训**：本次走过最大的弯路是在没有官方流量证据时误判"服务端节点故障"。接手类似私有协议问题时建议先读第 2、7 节。

---

## 1. 问题现象

DSH 通过本 bridge 的 qoder 驱动调用"千问 Qwen3.8-Flash"（模型 key `qfmodel`）时：

- 外层 HTTP **200**；
- SSE 信封（envelope）内层 body 报：

```json
{"code":"400","message":"[FAIL]node:oa_qwen-plus-main msg:Execution failed: null"}
```

- 其他模型（如 `qmodel_38max` 走相同代码路径）在当时也不可用；控制类请求（模型列表、节点发现、token 刷新）全部正常。

**关键反证（用户提供）**：官方桌面客户端 QoderWork CN 用同一账号同一模型可以正常对话。所以根因一定是本驱动发出的请求与官方客户端存在差异，**不是服务端故障**。

---

## 2. 结论先行

`agent_chat_generation` 这个旧网关端点**不是 OpenAI 透传接口**：

- wasm 对任何 body 都能正常签名，网关入口也不校验 body 结构；OpenAI 形状的请求一路到达真正的推理节点（node）后，节点内部取不到必需字段，空指针，于是返回 `[FAIL]node:… Execution failed: null`。
- 官方客户端发送的是平台**私有聊天信封**，字段包括 `request_id` / `business` / `model_config` / `messages` / `parameters` 等（完整字段见第 4 节）。
- 逐字段二分实验确认：**`business` 对象是唯一的关键字段**——删除它精确复现该节点错误；给个空对象 `{}` 就成功。模型选择与身份元数据（CLI vs 桌面端）无关，始终由 `X-Model-Key` 请求头决定。

修复：`prepareQoderChatBody()`（`src/drivers/qoder/upstream.ts`）从"原样透传 OpenAI body"改为"把 OpenAI 文档翻译为私有信封"。

### 方法论教训（最重要）

> **私有协议出问题，且官方客户端正常时，唯一可靠的路径是对比官方真实流量，不能凭 HTTP 状态/错误文案下结论。**
>
> "控制接口正常 + 推理报错 + 错误来自 node"这些表象，非常容易诱导出"服务端节点故障"的错误结论。客户端能成功就是对该结论的直接证伪。

---

## 3. 定位过程（可复用的调查路径）

### 3.1 直接驱动官方 worker，在官方代码里复现成功

桌面客户端的推理实际由一个内置 worker 完成：

```
/Applications/QoderWork CN.app/Contents/Resources/app.asar.unpacked/node_modules/
  @qoder-ai/qoder-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs
```

（约 31MB 单行混淆代码，runtime version 1.1.26。）可以手动 spawn 它、模拟 host 端的 stdin JSON 控制协议。要点：

- 启动参数（**不要带 `--bare`**，带了 user 消息会被拒 `bare_session_control_only`）：

```
node <worker> --print --output-format stream-json --input-format stream-json \
  --session-id <uuid> --permission-mode bypassPermissions \
  --include-partial-messages --disallowed-tools * \
  --permission-prompt-tool stdio --disable-builtin-skills \
  --model qfmodel --context-window 1000000
```

- **stdin/stdout 帧分隔符是换行符 `\n`**。App 自己的 SDK `index.js` 里写的是空格（`JSON.stringify(i)+' '`），那是 host→CLI 另一侧；worker 实际只认 `\n`，用空格时完全无输出。
- 必需环境变量：

```
QODER_AGENT_SDK_ENTRYPOINT=sdk-ts
QODER_AGENT_SDK_VERSION=1.0.25
QODER_SDK_AUTH_PAYLOAD_FILE=<tmp>/payload.json   # 内容 {"type":"jobToken","jobTokenProvider":"host"}，文件 0600
QODER_WORK_INTEGRATION_MODE=1
QODER_SCENE=qwork
QODER_CONFIG_DIR / QODERCN_CONFIG_DIR = ~/.qoderworkcn
NODE_TLS_REJECT_UNAUTHORIZED=0
# 抓包时：
QODER_MODEL_TRANSPORT=legacy
HTTPS_PROXY=https_proxy=HTTP_PROXY=http_proxy=http://127.0.0.1:8899
NO_PROXY=''
```

- 握手序列：
  1. host 发 `initialize` control_request；
  2. worker 回 `fetch_job_token`（reason `initial`）→ host 直接应答 **原始 `dt-` token**（`{subtype:"success", response:{token:"<dt token>"}}`）。**不需要任何 token 兑换**，worker 内 AuthManagerV2 拿到什么用什么；
  3. initialize 成功；
  4. 约 4 秒后发用户消息 `{type:"user", session_id, message:{role:"user",content:[{type:"text",text:"…"}]}}`；
  5. worker 发 `get_model_policy` → 应答 `{model:"qfmodel"}`；
  6. 流式回 assistant，最后 `{type:"result",subtype:"success",result:"…"}`。
- 未识别的 control_request 一律回 `{subtype:"success", response:{}}` 即可。

### 3.2 MITM 抓包：URL 相同，差异在 body

强制 legacy 传输后抓到成功请求：

```
POST https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation
       ?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1
```

**URL 与我们驱动打的完全相同**（`Encode=1` 是 wasm `prepareInferRequest` 签名时自动追加的，JS 源码常量里没有）。凭证、wasm 文件（sha256 `15dad38f…`，288929 字节，与 App 内置文件逐字节一致）也全部相同。所以差异只可能在请求头/body。

### 3.3 解密密封 body，拿到信封真相

wasm 会把请求 body 密封（seal）为可见 ASCII（但不是 UTF-8 文本语义）。同模块的 `decrypt_server_response` 可以解开来路合法的密封体——**官方 worker 发出的请求体可以被我们用同一 wasm 解开**。解密后即第 4 节的信封结构。

> 实现方式见 `src/drivers/qoder/wasm.ts` 的 `loadQoderWasm()`，不要自己重写 wasm 调用 wrapper——见第 7 节踩坑 4。

---

## 4. 信封字段参考（解密自官方成功请求）

解密后的顶层字段（约 125KB，大部分体积是 system prompt 和 32 个 tools 定义）：

| 字段 | 内容 / 取值 | 是否必需 |
|---|---|---|
| `request_id` | 新 uuid | 是 |
| `request_set_id` | 另一个新 uuid（与 request_id 不同） | 是（沿用官方形状） |
| `chat_record_id` | 官方取值与 `request_id` 相同 | 同上 |
| `session_id` | 保留调用方提供的；没有则生成（多轮分组语义） | 是 |
| `stream` | `true` | 是 |
| `chat_task` | `"FREE_INPUT"` | 沿用官方形状 |
| `is_reply` | `true`；`is_retry` `false`；`source` `1`；`version` `"3"` | 沿用官方形状 |
| `agent_id` | `"agent_common"`；`task_id` `"common"` | 沿用官方形状 |
| `model_config` | `{key:<模型key>, source:"system"}`（官方还带 display_name/format/is_vl/is_reasoning/max_input_tokens 等目录信息） | 字段存在即可；**空对象 `{}` 也能成功**，模型实际由 `X-Model-Key` 头选择 |
| **`business`** | 见下 | **唯一经过验证的必需字段：缺失则精确复现 `Execution failed: null`；空对象 `{}` 即成功** |
| `messages` | OpenAI 消息形状：content 可为字符串或 content-part 数组；system / user / assistant / tool 角色、tool_calls 历史均实测可用 | 是（对话本体） |
| `parameters` | 生成参数容器，见下 | 可省略 |
| `tools` | OpenAI tools 数组（`{type:"function",function:{…}}`），**保持顶层** | 可省略 |
| `tool_choice` | 顶层透传 | 可省略 |

`business` 官方形状（遥测/身份信息）：

```json
{
  "product": "qoder_work",
  "version": "1.1.26",
  "type": "agent",
  "id": "<uuid>",
  "name": "<本轮第一条用户文本，截断>",
  "begin_at": 1789710100494,
  "stage": "start"
}
```

本驱动发送时 `product` 取 `QODER_CLIENT_METADATA.business_product`（CLI 身份为 `"cli"`）；实测 `cli` / `qoder_work` 两种 product 都成功，**身份不是决定因素**。

`parameters` 官方形状为 `{max_tokens, context_length, …}`；本驱动把 OpenAI 入参中的生成参数搬到这里：`max_completion_tokens`/`max_tokens` → `max_tokens`，以及 `temperature`/`top_p`/`stop`/`presence_penalty`/`frequency_penalty`/`reasoning_effort`。

### 已实测通过的能力（修复后）

- content-part 数组形式的用户消息；
- tools + tool_choice，模型真实产出 OpenAI 流式 `tool_calls`（分片 delta）；
- 多轮 tool 历史（assistant.tool_calls + role:`tool`）；
- `reasoning_content` 思考流、usage（含 reasoning_tokens / credits）；
- `qfmodel`（Free 账号 v2 凭证、Pro 账号 `.auth-cn` 凭证都测过）与 `qmodel_38max`。

---

## 5. 凭证体系备忘（本机有两套并存）

1. **v2 桌面账号**：`~/Library/Application Support/QoderWork CN/auth-v2.dat`，Electron safeStorage 加密（AES-128-CBC）：

```js
// 去前缀 v10（blob.slice(3)），密钥来自 Keychain
const kp = execFileSync('/usr/bin/security',
  ['find-generic-password','-s','QoderWork CN Safe Storage','-w']).toString().trim()
const key = pbkdf2Sync(kp, 'saltysalt', 1003, 16, 'sha1')
// iv = Buffer.alloc(16, 0x20)，aes-128-cbc
// 解出：{schemaVersion:2, token:'dt-…', refreshToken:'drt-…', expiresAt,
//        user:{id(uid), name, tier, orgId, orgTags}, loginDeviceId}
```

2. **旧体系账号**：`~/.qoderworkcn/.auth-cn/`（`id` + wasm 密封的 `user`），这是**本插件生产路径实际读取**的目录（见 `meta.ts` 的 `QODER_AUTH_SUBDUCTORIES` probe 顺序）。

3. **两个 machine id 不要混淆**：

- `~/.qoderworkcn/machine-id`：桌面 v2 的 device id（= v2 凭证里的 `loginDeviceId`）；
- `~/.qoderworkcn/.auth/machine_id`：CLI 体系 id，**worker 签名时用的是这个**；
- MITM 抓到的成功请求里 `Cosy-MachineId` 与 `loginDeviceId` 不同，曾因此困惑——身份/machine id 不影响成败，`business` 才影响。

签名上下文构造要求（否则 wasm 报错）：`organization_tags` **必须是数组**（`null` 报 Invalid user info）；orgId 可给 `''`；`data_policy_agreed` 给 `true`。

---

## 6. 修复内容与验证

**改动**（均在 qoder driver 内，core 未动）：

- `src/drivers/qoder/upstream.ts`：`prepareQoderChatBody()` 重写为信封构造；新增 `parametersOf()` / `businessNameOf()`；`modelKeyOf()` 同时支持原始 body 的 `model` 与信封里的 `model_config.key`。
- `src/drivers/qoder/meta.ts`：新增 `QODER_TASK_ID = 'common'`。
- 响应侧 `translateQoderStream()` **未改**——信封内本来就是标准 OpenAI chunk，翻译逻辑早已兼容。
- 测试：`tests/qoder/upstream.spec.ts` / `tests/qoder/shim.spec.ts` 更新并新增信封行为用例。

**验证**：

```bash
./node_modules/.bin/tsc --noEmit          # 通过
./node_modules/.bin/vitest run            # 236/236 通过（24 个测试文件）
./node_modules/.bin/tsdown                # 构建通过
```

真实链路（生产凭证解析 → 信封 → wasm 签名 → 真实网络 → 流翻译）：

- `qfmodel` → 返回"验证成功"（v2 Free 账号与 .auth-cn Pro 账号各测一次）；
- `qmodel_38max` → 返回"测试通过"，reasoning 流与 usage 正常。

---

## 7. 踩坑清单（下次别再踩）

1. **误判服务端故障**：在没有官方流量对比时，凭"控制接口正常 + 推理 node 报错"判定节点故障。用户一句"客户端能用"直接证伪。私有协议问题**先对比官方流量**。
2. **MITM 必须全程 Buffer 处理**：密封 body 是 ASCII 但按 UTF-8 字符串拼接会破坏字节（多字节序列被拆散重组），表现为 worker 端 `api_retry attempt 1..10 error:"unknown"` 无限重试。正确做法：Buffer 聚合，仅写日志时再 `toString`。GET（无 body）不受影响，曾因此误以为代理没问题。
3. **worker 帧分隔符是 `\n` 不是空格**；且不能带 `--bare`。
4. **不要手抄 wasm wrapper**：从混淆 bundle 转录 `QoderContext` wrapper 时极易抄错（如漏写参数），症状是构造 context 时 wasm `RuntimeError: unreachable`，且与入参无关、全用例都挂。直接用项目内 `src/drivers/qoder/wasm.ts` 的 `loadQoderWasm()`。
5. **`data_policy_agreed:false` 会导致 wasm `unreachable`**：抓包里成功请求的响应头是 `Cosy-Data-Policy: disagree`，但那是另一套来源；构造签名上下文时该字段必须给 `true`。
6. **zsh 的未匹配 glob 会中止整条命令**：`rm -f body-*.bin` 在无匹配文件时 zsh 直接报 `no matches found` 并中止，导致后续启动代理的命令从未执行——结果"新代理"一直没起来，实际服务的是旧代理实例，浪费了多轮排查。写法：加引号 `rm -f '/tmp/…/body-*.bin'`，或先判断文件存在。排查这类问题时务必确认"我以为启动的进程"的真实 pid 和监听端口（`lsof -nP -iTCP:<port>`）。
7. **端口残留**：旧 mitm 进程会造成 EADDRINUSE 或"假新代理"；启动前 `lsof -ti tcp:<port> | xargs kill -9`。
8. **`pnpm run` 可能被 lockfile 不一致拦截**；直接调用 `./node_modules/.bin/tsc|vitest|tsdown`。跑 `.mts` 脚本用 `node --experimental-strip-types`（Node 22）。
9. **已排除的错误方向**（不必重试）：新端点 `api2-v2.qoder.sh`（Bearer + Cosy 头各种组合一律 401；`model_server_transport` feature gate 默认 `enabled:false`，且强制 legacy 官方仍成功）；jobToken 兑换（`{personal_token}` 打 openapi 400，且根本不需要兑换）。

---

## 8. 复测入口

- wasm 重 vendor：`scripts/vendor-qoder-wasm.mjs`（升级后先核对 wasm sha256 与 `QODER_COSY_VERSION`）。
- 抓包设施要点：自签证书即可（客户端不校验，配合 `NODE_TLS_REJECT_UNAUTHORIZED=0`）；CONNECT 拦截、ALPN 强制 `http/1.1`、Buffer 安全。
- 修复对应的测试：`tests/qoder/upstream.spec.ts` 的 `prepareQoderChatBody` describe 块、`tests/qoder/shim.spec.ts` 中 `model_config.key` 断言。
