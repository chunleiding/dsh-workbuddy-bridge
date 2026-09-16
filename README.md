# DSH LLM Bridge


[English](./README.en.md) | 中文


复用闭源 AI 桌面 App 已有的登录态与额度，把它们包含的模型零配置接入 DeepSeek Harness。当前内置两个驱动，安装一次即可同时使用：

- **WorkBuddy 驱动**：WorkBuddy / CodeBuddy 桌面 App 的 GLM-5.3、GLM-5.2、DeepSeek-V4-Pro、DeepSeek-V4-Flash、Kimi-K3、MiniMax-M3、Hy3 等。
- **Loomy 驱动**：Loomy（讯飞）桌面 App imodel 后端的 DeepSeek V4 Flash、MiniMax M3、Kimi k2.6、Qwen 3.8 Max、GLM 5.3 Flash、Spark X2.5、MiMo V2.5、Qwen3.5 Flash 等。

在模型选择器里选哪个平台的模型，就是在切换使用哪个平台的额度，无需额外开关。

## 架构

项目目标是复用闭源 AI Agent 已有的登录态与额度。代码分为与平台无关的 **Core**（凭证生命周期、模型目录、loopback shim、pi-ai 适配器壳、SSE 管道、共享密钥、心跳、状态路由——不包含任何平台名称）与承载全部平台私有事实（凭证发现、token 刷新、端点、协议转换、模型、额度、错误、品牌）的 **Driver**：

```
src/core/                 平台无关机制
src/drivers/workbuddy/    WorkBuddy 驱动（当前唯一驱动）
src/drivers/trae/ …       后续驱动的预留位置（尚未实现）
```

未来接入 Trae / Qoder 只需新增驱动；本次拆分不改变 WorkBuddy 的任何现有行为。


## 功能

- **开箱即用**：安装和启用插件后，在 DSH 中直接使用，无需额外配置。


![WorkBuddy 模型出现在 DSH 模型选择器中](assets/1.png)


- **图片输入**：大部分模型支持发图，在对话里直接粘贴或拖入图片即可（GLM-5.3-Flash、GLM-5.2、DeepSeek-V4 系列等）；少数只支持文字的模型（如 GLM-5.1）会明确提示不支持。


- **思考强度**：模型选择器里可为支持的模型切换思考强度，例如 GLM-5.3 可选 low / high / xhigh，GLM-5.3-Flash 可选 low / high / max；没有出现选项的模型不支持调整，使用 WorkBuddy 的默认档位。


- **徽章展示**：促销徽章（限时免费、夜间折扣）直接跟在模型名后面（如 `Hy4 preview · x0.00 · 限时免费`），选模型时一眼可见；设置卡片里也会汇总当前有优惠的模型。以 WorkBuddy 服务端的数据为准，每次启动 DSH 时同步。


- **费率比例**：模型选择列表里每个模型名后直接显示积分倍率（如 `GLM-5.2 · x0.79`、`Hy3 · x0.00`），`/model` 弹窗与输入框的模型下拉都能看到。倍率只是显示，不影响实际请求。


- **信息查看**：设置 → 插件 → DSH WorkBuddy Connect 卡片


![设置卡片显示插件](assets/2.png)

卡片展开后，可查看账号信息、令牌有效期与剩余积分。

![设置卡片显示账号与剩余积分](assets/3.png)

## 前置

- WorkBuddy 驱动：已安装并登录 **WorkBuddy 桌面 App**（复用 App 登录状态，账号切换自动跟随）。
- Loomy 驱动：已安装并登录 **Loomy 桌面 App**（读取本机 `auth-session.json` 会话，重新登录后自动跟随）。
- 两个驱动相互独立，装了哪个 App 就能用哪个平台；未安装的平台只会在卡片里显示未登录，不影响另一个。

**版本对应（重要）**：本插件与 DSH 核心版本一一对应，不可混用——不匹配的组合会导致 DSH 启动失败：

| 插件版本 | 要求的 DSH 核心 | 桌面 App |
|---|---|---|
| **0.4.0+** | `0.1.2-rc.1` 及以上 | WorkBuddy `2.0.5`+；Loomy `0.9.37` 左右 |
| **0.3.x** | `0.1.2-rc.1` 及以上 | WorkBuddy 建议 `2.0.5`+（仅 WorkBuddy 驱动，旧包名 `dsh-workbuddy-bridge`） |
| **0.2.6** | `0.1.1-rc.2`（旧线） | `2.0.3` / `2.0.4` |

- DSH `0.1.2-rc.1` 及以上的用户，正常安装最新版即可：`dsh plugin --profile web add dsh-llm-bridge`
- 还在用 DSH `0.1.1-rc.2` 的用户，请安装旧版本并停留在 `0.2.6`：`dsh plugin --profile web add dsh-workbuddy-bridge@0.2.6`

插件在三种 DSH 界面下均可运行：**Web**、**Desktop**、**TUI**。根据你使用的 profile 选对应命令安装。

```sh
# Web（推荐，自带预构建产物）
dsh plugin --profile web add dsh-llm-bridge
dsh web

# 或从 GitHub 源码安装 Web 版
dsh plugin --profile web add github:chunleiding/dsh-workbuddy-bridge
dsh web
```

```sh
# Desktop（DSH Desktop 桌面版）
dsh plugin --profile desktop add dsh-llm-bridge
dsh --profile desktop
```

```sh
# TUI（终端界面）
dsh plugin --profile dsh-tui add dsh-llm-bridge
dsh --profile dsh-tui
```

> **TUI 用户请注意版本搭配**：终端界面插件 `@deepseek-harness-tui/dsh-tui` 需要 **`0.10.0-beta.5` 及以上**（更早的版本装了本插件会启动失败，报 `events is not iterable`）。请先用 TUI 自带的更新方式把壳升到 beta.5 及以上，再安装本插件；当前最新的是 beta 版，正式版发布后同样可用。

> 提示：`dsh-tui` profile 需用 pnpm 11 安装（PATH 里是其他版本会报 `ERR_PNPM_UNEXPECTED_STORE`，用 `npx pnpm@11` 即可）。

安装后，在对应界面的模型选择器里切换到 WorkBuddy / Loomy 模型即可使用；Web 下设置 → 插件里有两张卡片（**DSH WorkBuddy Connect** 与 **DSH Loomy Connect**），分别查看账号信息；TUI 下可在 `/settings` 的 `workbuddy` / `loomy` 命名空间配置 `authFile` / `sessionFile`。

## 命令行

```sh
# 查看全部驱动的状态（省略驱动名即聚合输出）
dsh plugin --profile <web|desktop|dsh-tui> exec dsh-llm-bridge status

# 只看某一个驱动
dsh plugin --profile <web|desktop|dsh-tui> exec dsh-llm-bridge loomy status
dsh plugin --profile <web|desktop|dsh-tui> exec dsh-llm-bridge workbuddy doctor --json

# logout 必须显式指定驱动（WorkBuddy 会删除插件自有的凭据副本；Loomy 无插件侧凭据，为空操作）
dsh plugin --profile <web|desktop|dsh-tui> exec dsh-llm-bridge workbuddy logout
```

支持 `doctor`（诊断）、`status`（登录态/额度/host 健康）、`logout`（清理插件侧凭据），`--json` 输出脱敏后的机器可读文档。Loomy 会话文件位置可用环境变量 `LOOMY_SESSION_FILE` 覆盖。

## 已知限制

- 在 macOS 的 DSH Web / Desktop / TUI 下验证通过（`0.1.2-rc.1`+、Node 22+；TUI 需终端界面插件 `0.10.0-beta.5` 及以上，见安装章节说明）。Windows 会依次探测 Local 与 Roaming AppData；WSL 会优先从挂载的 Windows 用户目录读取登录凭据。若 Windows 与 Linux 用户名不同且 Windows 环境变量未传入 WSL，请通过 `WORKBUDDY_AUTH_FILE` / `LOOMY_SESSION_FILE` 指定实际位置。
- 两个驱动都依赖各自桌面 App 的客户端接口（非官方开放 API），上游更新后插件可能需要随之调整。
- Loomy 的图像生成模型（如 doubao-seedream、qwen-image）不通过对话接口提供，插件只暴露对话模型。

## 免责声明

- 本项目**仅供个人学习和研究使用**，仅驱动使用者自己的 WorkBuddy / Loomy 账号在本机调用，请勿用于商业用途或超出个人合理使用的场景。
- 使用者需遵守 WorkBuddy / Loomy 的服务条款；因使用本项目产生的任何后果（包括但不限于账号被限制、额度被清空、服务中断），由使用者自行承担。
- 本项目作者不对任何因使用或滥用本项目产生的直接或间接损失负责。
- 本项目与腾讯、WorkBuddy、讯飞、Loomy、DeepSeek 均无关联，未获其授权或认可；文中出现的名称仅用于描述兼容关系，其商标权利归各自所有。

## 致谢

- [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api)（MIT）— WorkBuddy 上游协议的参照实现。
- [franksong2702/dsh-codex-connect](https://github.com/franksong2702/dsh-codex-connect)（Apache-2.0）— DSH 插件结构与 provider 注册的参照。

## 许可证

[MIT](./LICENSE)
