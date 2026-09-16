# DSH LLM Bridge

English | [中文](./README.md)

Reuses the sign-in and quota of closed AI desktop apps inside [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — zero configuration in the DSH chat. One install ships three drivers:

- **WorkBuddy driver**: GLM-5.3, GLM-5.2, DeepSeek-V4-Pro/Flash, Kimi-K3, MiniMax-M3, Hy3, and more from the WorkBuddy/CodeBuddy desktop app.
- **Loomy driver**: DeepSeek V4 Flash, MiniMax M3, Kimi k2.6, Qwen 3.8 Max, GLM 5.3 Flash, Spark X2.5, MiMo V2.5, Qwen3.5 Flash, and more from the Loomy (iFlytek) desktop app's imodel backend.
- **Qoder driver**: 14 models from the Qoder (QoderWork CN) desktop app — Qwen3.8-Max/Flash, Qwen3.7-Max/Plus/Flash, DeepSeek-V4-Pro/Flash, GLM-5.3/Flash, GLM-5.2, Kimi-K3/K2.8-Preview, MiniMax-M2.7, and Auto.

Picking a model from any platform in the model picker is all the "switching" there is — no extra toggle.

## Architecture

The package reuses a closed AI agent's existing sign-in and quota. It is split into a platform-agnostic **core** (credential lifecycle, model catalog, loopback shim, pi-ai adapter shell, SSE pipe, shared secret, heartbeat, status route — no platform names) and **drivers** that own every platform-private fact (credential discovery, token refresh, endpoints, protocol conversion, models, quota, errors, branding):

```
src/core/                 platform-agnostic mechanisms
src/drivers/workbuddy/    the WorkBuddy driver
src/drivers/loomy/        the Loomy driver
src/drivers/qoder/        the Qoder driver (embeds the official wasm)
```

Adding another platform later means adding a driver directory; see `docs/development.md` for the driver checklist. The Qoder driver needed **zero changes to `src/core/`** — it unwraps the upstream's enveloped SSE inside the driver, because core pipes a driver's response body verbatim. Reverse-engineering notes for every platform-private fact live in `docs/`.

## Features

- **Works out of the box**: install and enable the plugin, then use it directly in DSH — no extra configuration.

![WorkBuddy models in the DSH model picker](assets/1.png)

- **Image input**: most models accept images — paste or drop one straight into the conversation (GLM-5.3-Flash, GLM-5.2, the DeepSeek-V4 series, and more); the few text-only models (e.g. GLM-5.1) clearly say so.

- **Thinking effort**: the model picker lets you switch the thinking effort on models that support it — GLM-5.3 offers low / high / xhigh and GLM-5.3-Flash offers low / high / max. Models without the option cannot be adjusted and use WorkBuddy's default.

- **Promo badges**: promo badges (`限时免费`, `夜间折扣`) ride the model name itself (e.g. `Hy4 preview · x0.00 · 限时免费`), visible wherever you pick a model; the status card also collects currently-discounted models. Per the WorkBuddy service data, synced each time DSH starts.

- **Rate**: every model name carries its credits multiplier (e.g. `GLM-5.2 · x0.79`, `Hy3 · x0.00`) in both the `/model` popup and the composer's model dropdown. The rate is display-only and never affects requests.

- **Info at a glance**: Settings → Plugins → DSH WorkBuddy Connect card

![Settings card showing the plugin](assets/2.png)

Expand the card to see the account, token validity, and remaining credit.

![Settings card showing account and remaining credit](assets/3.png)

## Install

Prerequisites:
- WorkBuddy driver: the **WorkBuddy desktop app** installed and signed in (the plugin reuses its sign-in state).
- Loomy driver: the **Loomy desktop app** installed and signed in (reads its local `auth-session.json`).
- Qoder driver: the **Qoder (QoderWork CN) desktop app** installed and signed in (reads the local `~/.qoderworkcn/.auth-cn/` sign-in). Qoder's refresh token rotates on every use, so after a rotation the plugin re-seals the new token back into the app's own credential file and leaves a `.bak-<timestamp>` sibling behind — which is what keeps the plugin's usage and the app's usage from signing each other out.
- The drivers are independent; a platform without its app installed just shows "signed out" in its card and never affects the others.

**Match the plugin version to your DSH core** — a mismatched combination fails to start DSH:

| Plugin | Required DSH core | Desktop app |
|---|---|---|
| **0.4.0+** | `0.1.2-rc.1` or newer | WorkBuddy `2.0.5`+; Loomy `~0.9.37`; Qoder (QoderWork CN) `0.9.17` (the version its embedded wasm came from) |
| **0.3.x** | `0.1.2-rc.1` or newer | WorkBuddy `2.0.5`+ recommended (WorkBuddy-only, old package name `dsh-workbuddy-bridge`) |
| **0.2.6** | `0.1.1-rc.2` (older line) | `2.0.3` / `2.0.4` |

- On DSH `0.1.2-rc.1` or newer, just install the latest: `dsh plugin --profile web add dsh-llm-bridge`
- Still on DSH `0.1.1-rc.2`? Stay on the older release: `dsh plugin --profile web add dsh-workbuddy-bridge@0.2.6`

The plugin runs under all three DSH interfaces: **Web**, **Desktop**, and **TUI**. Pick the install command that matches the profile you use.

```sh
# Web (recommended; ships prebuilt artifacts)
dsh plugin --profile web add dsh-llm-bridge
dsh web

# or install the Web version from the GitHub source
dsh plugin --profile web add github:chunleiding/dsh-workbuddy-bridge
dsh web
```

```sh
# Desktop (the DSH Desktop app)
dsh plugin --profile desktop add dsh-llm-bridge
dsh --profile desktop
```

```sh
# TUI (terminal UI)
dsh plugin --profile dsh-tui add dsh-llm-bridge
dsh --profile dsh-tui
```

> **TUI users, check the version pairing**: the terminal UI package (`@deepseek-harness-tui/dsh-tui`) must be **`0.10.0-beta.5` or newer** — older versions fail at startup with `events is not iterable` when this plugin is installed. Update the shell first (via its built-in update command or a fresh install), then add this plugin; the newest release is a beta, and a stable one will work the same way.

> Note: the `dsh-tui` profile requires pnpm 11 to install packages (a different pnpm on PATH fails with `ERR_PNPM_UNEXPECTED_STORE` — use `npx pnpm@11`).

After installing, pick a WorkBuddy, Loomy, or Qoder model in the model picker. On Web, Settings → Plugins shows three cards (**DSH WorkBuddy Connect**, **DSH Loomy Connect**, and **DSH Qoder Connect**); on TUI, configure `authFile` / `sessionFile` / `authDir` under the `workbuddy` / `loomy` / `qoder` namespaces in `/settings`.

## CLI

```sh
# All drivers at once (omit the driver id for an aggregate report)
dsh plugin --profile <web|desktop|dsh-tui> exec dsh-llm-bridge status

# One driver
dsh plugin --profile <web|desktop|dsh-tui> exec dsh-llm-bridge loomy status
dsh plugin --profile <web|desktop|dsh-tui> exec dsh-llm-bridge qoder status
dsh plugin --profile <web|desktop|dsh-tui> exec dsh-llm-bridge workbuddy doctor --json

# logout requires an explicit driver
dsh plugin --profile <web|desktop|dsh-tui> exec dsh-llm-bridge workbuddy logout
```

`doctor` / `status` / `logout` are supported, with a redacted `--json` document. Override the Loomy session file with `LOOMY_SESSION_FILE`, or the Qoder auth directory with `QODER_AUTH_DIR` (or the `authDir` setting).

## Known limitations

- Verified on macOS with the DSH Web / Desktop / TUI profiles (`0.1.2-rc.1`+, Node 22+; TUI requires the terminal UI package `0.10.0-beta.5` or newer — see the Install section). Windows probes Local and Roaming AppData in order; WSL first reads credentials from the mounted Windows user profile. If the Windows and Linux user names differ and Windows environment variables are not forwarded into WSL, point `WORKBUDDY_AUTH_FILE` / `LOOMY_SESSION_FILE` / `QODER_AUTH_DIR` at the actual file.
- All three drivers rely on their desktop apps' private client interfaces (not public APIs); any app may require a plugin update after an upstream change.
- Loomy's image-generation models (doubao-seedream, qwen-image) are not chat models and are not exposed.
- Qoder's request signing must go through the official wasm (it cannot be reproduced in plain JS), so the plugin embeds the `qoder_auth_wasm_bg.wasm` and wasm-bindgen glue taken from Qoder (QoderWork CN) `0.9.17`. If a Qoder upgrade changes the signing protocol, re-embed it with `node scripts/vendor-qoder-wasm.mjs` (which asserts 11 required exports and fails loudly on an incomplete extraction).
- Qoder's thinking-effort selector offers only the levels the catalog actually declares (e.g. `dmodel` offers high / max). The plugin deliberately offers **no "thinking off" option**: the endpoint accepts any `reasoning_effort` string, so no spelling's "off" meaning can be proven — and a switch that appears to work while the server keeps thinking is worse than no switch. The default level is left to Qoder.

## Disclaimer

- This project is for **personal learning and research only**, driving your own WorkBuddy / Loomy / Qoder accounts on your own machine. Do not use it commercially or beyond reasonable personal use.
- Users must comply with the WorkBuddy / Loomy / Qoder terms of service. Any consequence of using this project (including but not limited to account restrictions, depleted credit, or service interruption) is borne by the user.
- The author is not liable for any direct or indirect loss arising from the use or misuse of this project.
- This project is not affiliated with, endorsed by, or sponsored by Tencent, WorkBuddy, iFlytek, Loomy, Qoder, or DeepSeek. Product names are used for compatibility description only; trademarks belong to their respective owners. The wasm module embedded by the Qoder driver is taken from the locally installed Qoder client and is invoked only to reuse that client's sign-in on the same machine.

## Acknowledgements

- [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api) (MIT) — reference implementation of the WorkBuddy upstream protocol.
- [franksong2702/dsh-codex-connect](https://github.com/franksong2702/dsh-codex-connect) (Apache-2.0) — reference for the DSH plugin structure and provider registration.

## License

[MIT](./LICENSE)
