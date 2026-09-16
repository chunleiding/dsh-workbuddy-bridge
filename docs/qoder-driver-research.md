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
