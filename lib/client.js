window.__ModuleLoader__.load({
	id: "dsh-llm-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/core/client/status-card.tsx
		/**
		* Generic driver status card for the Harness Plugin configuration page.
		*
		* Browser-only, platform-agnostic: it polls one driver's same-origin status
		* route and renders the generic {@link DriverWebStatus} document. Every
		* platform word comes from the driver's own locale copy (`t`) and optional
		* badge localizer; this component contains no driver name.
		*
		* It is intentionally a plain presentational component shared by every
		* driver's thin card wrapper, so the polling/expand/error behavior is
		* written once.
		*
		* @module dsh-llm-bridge/core/client/status-card
		*/
		const POLL_INTERVAL_MS = 6e4;
		const cardStyle = {
			overflow: "hidden",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 10,
			background: "var(--dsw-alias-bg-module-platform)"
		};
		const headerStyle = {
			boxSizing: "border-box",
			width: "100%",
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: 16,
			border: 0,
			padding: "13px 14px",
			background: "transparent",
			color: "var(--dsw-alias-label-primary)",
			font: "inherit",
			textAlign: "left",
			cursor: "pointer"
		};
		const headTextStyle = {
			display: "flex",
			minWidth: 0,
			flexDirection: "column",
			gap: 3
		};
		const nameStyle = {
			fontSize: 14,
			lineHeight: "20px",
			fontWeight: 600
		};
		const descriptionStyle = {
			fontSize: 13,
			lineHeight: "18px",
			color: "var(--dsw-alias-label-tertiary)"
		};
		const chevronStyle = {
			flex: "0 0 auto",
			fontSize: 18,
			lineHeight: 1,
			transition: "transform 120ms ease"
		};
		const cardBodyStyle = {
			borderTop: "1px solid var(--dsw-alias-border-l2)",
			padding: "16px 14px 18px"
		};
		const bodyStyle = {
			margin: 0,
			fontSize: 14,
			lineHeight: "22px",
			color: "var(--dsw-alias-label-secondary)"
		};
		const rowStyle = {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			flexWrap: "wrap",
			gap: 12
		};
		const statusStyle = {
			display: "flex",
			alignItems: "center",
			gap: 9,
			fontSize: 15,
			fontWeight: 500,
			color: "var(--dsw-alias-label-primary)"
		};
		const buttonStyle = {
			boxSizing: "border-box",
			minHeight: 34,
			padding: "6px 14px",
			border: "1px solid var(--dsw-alias-border-l2)",
			borderRadius: 18,
			background: "var(--dsw-alias-bg-layer-1)",
			color: "var(--dsw-alias-label-primary)",
			font: "inherit",
			fontSize: 14,
			cursor: "pointer"
		};
		const errorStyle = {
			...bodyStyle,
			color: "var(--dsw-alias-state-error-primary)"
		};
		const quotaListStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 18,
			paddingTop: 2
		};
		const quotaGroupStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 10
		};
		const quotaTitleStyle = {
			margin: 0,
			fontSize: 14,
			lineHeight: "20px",
			fontWeight: 600,
			color: "var(--dsw-alias-label-primary)"
		};
		const quotaLabelStyle = {
			display: "flex",
			justifyContent: "space-between",
			gap: 12,
			fontSize: 13,
			lineHeight: "20px",
			color: "var(--dsw-alias-label-secondary)"
		};
		const modelBadgeStyle = {
			display: "flex",
			alignItems: "center",
			gap: 6,
			flexWrap: "wrap"
		};
		const modelOfferStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 2
		};
		const modelRateStyle = {
			fontSize: 12,
			lineHeight: "18px",
			color: "var(--dsw-alias-label-tertiary)"
		};
		const modelBadgeChipStyle = {
			padding: "1px 8px",
			borderRadius: 999,
			fontSize: 11,
			lineHeight: "18px",
			background: "var(--dsw-alias-state-success-subtle, rgba(34, 160, 107, 0.12))",
			color: "var(--dsw-alias-state-success-primary, #22a06b)"
		};
		const progressTrackStyle = {
			height: 8,
			overflow: "hidden",
			borderRadius: 999,
			background: "var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.08))"
		};
		function progressFillStyle(percent) {
			return {
				width: `${Math.max(0, Math.min(100, percent))}%`,
				height: "100%",
				borderRadius: "inherit",
				background: "var(--dsw-alias-brand-primary, #1677ff)"
			};
		}
		function dotStyle(status) {
			return {
				width: 9,
				height: 9,
				borderRadius: "50%",
				flex: "0 0 auto",
				background: status === "signed-in" ? "var(--dsw-alias-state-success-primary, #22a06b)" : status === "error" ? "var(--dsw-alias-state-error-primary, #d92d20)" : "var(--dsw-alias-label-dimmed, #9aa0a6)"
			};
		}
		function formatNumber(value) {
			return new Intl.NumberFormat(void 0).format(value);
		}
		function formatTime(ms) {
			return new Intl.DateTimeFormat(void 0, {
				dateStyle: "medium",
				timeStyle: "short"
			}).format(new Date(ms));
		}
		/** One quota package as a labeled progress bar. */
		function CreditBar({ label, remain, size, t }) {
			const detail = size > 0 ? t("exactRemaining", {
				remain: formatNumber(remain),
				size: formatNumber(size)
			}) : t("creditPackageUnknownSize", { remain: formatNumber(remain) });
			const percent = size > 0 ? remain / size * 100 : 100;
			const display = new Intl.NumberFormat(void 0, { maximumFractionDigits: 1 }).format(percent);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: quotaGroupStyle,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: quotaLabelStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("percentRemaining", { percent: display }) })]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: progressTrackStyle,
						role: "progressbar",
						"aria-label": label,
						"aria-valuemin": 0,
						"aria-valuemax": 100,
						"aria-valuenow": percent,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { style: progressFillStyle(percent) })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: bodyStyle,
						children: detail
					})
				]
			});
		}
		/**
		* One model offer row: name, promotional badges, and the rate.
		*
		* The rate sits under the name rather than beside it because the row already
		* spends its horizontal budget on badges; stacking keeps long model names and
		* several badges from squeezing the rate into an ellipsis.
		*/
		function ModelOfferRow({ model, t, localizeBadge }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: modelOfferStyle,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: quotaLabelStyle,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: model.name }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: modelBadgeStyle,
						children: [model.badges?.map((badge) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: modelBadgeChipStyle,
							children: localizeBadge(badge)
						}, badge)), model.free === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: modelBadgeChipStyle,
							children: t("freeModel")
						}) : null]
					})]
				}), model.credits === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: modelRateStyle,
					children: t("rate", { rate: model.credits })
				})]
			});
		}
		/** Render one driver's sign-in state as an expandable card. */
		function DriverStatusCard({ t, statusPath, localizeBadge }) {
			const [open, setOpen] = (0, react.useState)(false);
			const [status, setStatus] = (0, react.useState)({ status: "signed-out" });
			const [busy, setBusy] = (0, react.useState)(false);
			const mounted = (0, react.useRef)(true);
			const badgeLocalizer = localizeBadge ?? ((badge) => badge);
			(0, react.useEffect)(() => {
				mounted.current = true;
				return () => {
					mounted.current = false;
				};
			}, []);
			const refresh = (0, react.useCallback)(async (signal) => {
				try {
					const response = await fetch(statusPath, {
						headers: { accept: "application/json" },
						credentials: "same-origin",
						...signal === void 0 ? {} : { signal }
					});
					const value = await response.json().catch(() => void 0);
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					if (mounted.current && signal?.aborted !== true) setStatus(value);
				} catch (error) {
					if (mounted.current && signal?.aborted !== true) setStatus({
						status: "error",
						message: error instanceof Error ? error.message : t("requestFailed")
					});
				}
			}, [statusPath, t]);
			(0, react.useEffect)(() => {
				if (!open) return;
				const controller = new AbortController();
				refresh(controller.signal);
				return () => {
					controller.abort();
				};
			}, [open, refresh]);
			(0, react.useEffect)(() => {
				if (!open || status.status !== "signed-in") return;
				const controller = new AbortController();
				const timer = window.setInterval(() => {
					refresh(controller.signal);
				}, POLL_INTERVAL_MS);
				return () => {
					window.clearInterval(timer);
					controller.abort();
				};
			}, [
				open,
				refresh,
				status.status
			]);
			const manualRefresh = async () => {
				setBusy(true);
				try {
					await refresh();
				} finally {
					if (mounted.current) setBusy(false);
				}
			};
			const title = t("title");
			const label = status.status === "signed-in" ? status.nickname === void 0 ? t("signedInAs", { nickname: "" }).replace(/[:：]\s*$/, "") : t("signedInAs", { nickname: status.nickname }) : status.status === "error" ? t("requestFailed") : t("signedOut");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
				style: cardStyle,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					style: headerStyle,
					"aria-expanded": open,
					"aria-label": `${t(open ? "collapse" : "expand")}: ${title}`,
					onClick: () => {
						setOpen(!open);
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: headTextStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: nameStyle,
							children: title
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: descriptionStyle,
							children: t("intro")
						})]
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						"aria-hidden": "true",
						style: {
							...chevronStyle,
							transform: open ? "rotate(180deg)" : "none"
						},
						children: "⌄"
					})]
				}), open ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: cardBodyStyle,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							style: quotaTitleStyle,
							children: t("accountHeading")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: rowStyle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: statusStyle,
								role: "status",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									"aria-hidden": "true",
									style: dotStyle(status.status)
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label })]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: buttonStyle,
								disabled: busy,
								onClick: () => {
									manualRefresh();
								},
								children: busy ? t("refreshing") : t("refresh")
							})]
						}),
						status.status === "signed-in" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							status.expiresAt === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: bodyStyle,
								children: t("accessTokenExpires", { time: formatTime(status.expiresAt) })
							}),
							status.updatedAt === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: bodyStyle,
								children: t("sessionUpdatedAt", { time: formatTime(status.updatedAt) })
							}),
							status.credits === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: quotaListStyle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: rowStyle,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
										style: quotaTitleStyle,
										children: t("creditsHeading")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: bodyStyle,
										children: t("creditsTotal", { total: formatNumber(status.credits.total) })
									})]
								}), status.credits.accounts.filter((account) => account.remain > 0).map((account, index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CreditBar, {
									label: account.packageName,
									remain: account.remain,
									size: account.size,
									t
								}, `${account.packageName}-${String(index)}`))]
							}),
							status.creditsError === void 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
								style: errorStyle,
								children: t("creditsError", { message: status.creditsError })
							}),
							status.models === void 0 || status.models.length === 0 ? null : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: quotaListStyle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
									style: quotaTitleStyle,
									children: t("modelsHeading")
								}), status.models.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ModelOfferRow, {
									model,
									t,
									localizeBadge: badgeLocalizer
								}, model.id))]
							})
						] }) : null,
						status.status === "signed-out" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: bodyStyle,
							children: t("signedOutHint")
						}) : null,
						status.status === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: errorStyle,
							children: status.message
						}) : null
					]
				}) : null]
			});
		}
		//#endregion
		//#region src/drivers/workbuddy/status-paths.ts
		/** Plugin-owned status endpoint consumed by the WorkBuddy browser half. */
		const WORKBUDDY_STATUS_PATH = "/plugins/dsh-llm-bridge/workbuddy/status";
		//#endregion
		//#region src/drivers/workbuddy/client/WorkBuddyPluginCard.tsx
		/** WorkBuddy status card contributed to Harness Plugin configuration. */
		/** Localize the upstream's own promo badge spellings. */
		function localizeBadge(badge, t) {
			if (badge === "限时免费") return t("badgeLimitedFree");
			if (badge === "夜间折扣") return t("badgeNightDiscount");
			return badge;
		}
		/** Render the WorkBuddy card over the generic driver card. */
		function WorkBuddyPluginCard({ t }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DriverStatusCard, {
				t,
				statusPath: WORKBUDDY_STATUS_PATH,
				localizeBadge: (badge) => localizeBadge(badge, t)
			});
		}
		//#endregion
		//#region src/drivers/workbuddy/client/locales.ts
		/** Plugin-card copy registered under the settings.workbuddy locale namespace. */
		const en$1 = {
			title: "DSH WorkBuddy Connect",
			intro: "Use the models in the WorkBuddy desktop app directly in DSH — zero configuration, ready out of the box.",
			expand: "Expand",
			collapse: "Collapse",
			loading: "Loading account…",
			signedOut: "Not signed in",
			signedOutHint: "Sign in once in the WorkBuddy desktop app; this plugin follows that sign-in automatically.",
			signedInAs: "Signed in as {nickname}",
			accessTokenExpires: "Access token expires {time} (refresh is automatic)",
			sessionUpdatedAt: "Session last updated {time}",
			creditsHeading: "Remaining credit",
			creditsTotal: "Total: {total}",
			percentRemaining: "{percent}% remaining",
			exactRemaining: "{remain} / {size} remaining",
			creditPackageUnknownSize: "{remain} remaining",
			creditsError: "Credit unavailable: {message}",
			refresh: "Refresh",
			refreshing: "Refreshing…",
			requestFailed: "Request failed",
			accountHeading: "Account",
			modelsHeading: "Model offers",
			freeModel: "Free",
			badgeLimitedFree: "Limited-time free",
			badgeNightDiscount: "Night discount",
			rate: "{rate} credits per message"
		};
		const zh$1 = {
			title: "DSH WorkBuddy Connect",
			intro: "在 DSH 中直接使用 WorkBuddy 桌面 App 包含的模型，开箱即用，无需额外配置。",
			expand: "展开",
			collapse: "收起",
			loading: "正在读取账号…",
			signedOut: "未登录",
			signedOutHint: "在 WorkBuddy 桌面 App 里登录一次即可，插件会自动跟随当前登录的账号。",
			signedInAs: "已登录：{nickname}",
			accessTokenExpires: "访问令牌 {time} 过期（自动续期）",
			sessionUpdatedAt: "会话最近更新时间：{time}",
			creditsHeading: "剩余积分",
			creditsTotal: "合计：{total}",
			percentRemaining: "剩余 {percent}%",
			exactRemaining: "剩余 {remain} / {size}",
			creditPackageUnknownSize: "剩余 {remain}",
			creditsError: "积分查询失败：{message}",
			refresh: "刷新",
			refreshing: "正在刷新…",
			requestFailed: "请求失败",
			accountHeading: "账号",
			modelsHeading: "模型优惠",
			freeModel: "免费",
			badgeLimitedFree: "限时免费",
			badgeNightDiscount: "夜间折扣",
			rate: "{rate} 积分/次"
		};
		//#endregion
		//#region src/drivers/workbuddy/client/index.tsx
		/**
		* Register card copy and the WorkBuddy card under Plugin configuration.
		*
		* The body is guarded so that a DSH slot-API breaking change (for example
		* the rc.6→rc.7 `id`→`key` / `order`→`priority` rename) degrades to a
		* `console.error` instead of throwing into the DSH loader and raising the
		* red "Failed to load plugins" banner. The host providers keep working.
		*
		* NOTE: the try/catch boundary of this function is mirrored (duplicated) in
		* `tests/client-fallback.spec.ts`, which cannot import browser-only DSH
		* packages. If you change the guarded body or the `console.error` message
		* here, update that mirror too.
		*/
		function registerWorkBuddyCard(ctx) {
			try {
				const namespace = "settings.workbuddy";
				ctx.effect(() => ctx.locale.register(namespace, {
					zh: zh$1,
					en: en$1
				}), "dsh-llm-bridge: workbuddy settings copy");
				const t = ctx.locale.bind(namespace);
				ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
					name: "settings.plugin.item",
					key: "workbuddy",
					priority: 30,
					inject: () => ({ t })
				}, WorkBuddyPluginCard));
			} catch (error) {
				console.error("[dsh-llm-bridge] workbuddy client card failed to load (host provider unaffected):", error);
			}
		}
		//#endregion
		//#region src/drivers/loomy/status-paths.ts
		/** Plugin-owned status endpoint consumed by the Loomy browser card. */
		const LOOMY_STATUS_PATH = "/plugins/dsh-llm-bridge/loomy/status";
		//#endregion
		//#region src/drivers/loomy/client/LoomyPluginCard.tsx
		/** Loomy status card contributed to Harness Plugin configuration. */
		/** Render the Loomy card as a thin wrapper over the generic driver card. */
		function LoomyPluginCard({ t }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(DriverStatusCard, {
				t,
				statusPath: LOOMY_STATUS_PATH
			});
		}
		//#endregion
		//#region src/drivers/loomy/client/locales.ts
		/** Plugin-card copy registered under the settings.loomy locale namespace. */
		const en = {
			title: "DSH Loomy Connect",
			intro: "Use the models in the Loomy desktop app directly in DSH — zero configuration, ready out of the box.",
			expand: "Expand",
			collapse: "Collapse",
			loading: "Loading session…",
			signedOut: "Not signed in",
			signedOutHint: "Sign in once in the Loomy desktop app; this plugin follows that sign-in automatically.",
			signedInAs: "Signed in{nickname}",
			accessTokenExpires: "Access token expires {time} (refresh is automatic)",
			sessionUpdatedAt: "Session last updated {time}",
			creditsHeading: "Remaining credit",
			creditsTotal: "Total: {total}",
			percentRemaining: "{percent}% remaining",
			exactRemaining: "{remain} / {size} remaining",
			creditPackageUnknownSize: "{remain} remaining",
			creditsError: "Credit unavailable: {message}",
			refresh: "Refresh",
			refreshing: "Refreshing…",
			requestFailed: "Request failed",
			accountHeading: "Account",
			modelsHeading: "Model offers",
			freeModel: "Free",
			badgeLimitedFree: "Limited-time free",
			badgeNightDiscount: "Night discount",
			rate: "{rate} credits per message"
		};
		const zh = {
			title: "DSH Loomy Connect",
			intro: "在 DSH 中直接使用 Loomy 桌面 App 包含的模型，开箱即用，无需额外配置。",
			expand: "展开",
			collapse: "收起",
			loading: "正在读取会话…",
			signedOut: "未登录",
			signedOutHint: "在 Loomy 桌面 App 里登录一次即可，插件会自动跟随当前登录的账号。",
			signedInAs: "已登录{nickname}",
			accessTokenExpires: "访问令牌将于 {time} 过期（自动刷新）",
			sessionUpdatedAt: "会话最近更新时间：{time}",
			creditsHeading: "剩余积分",
			creditsTotal: "合计：{total}",
			percentRemaining: "剩余 {percent}%",
			exactRemaining: "剩余 {remain} / {size}",
			creditPackageUnknownSize: "剩余 {remain}",
			creditsError: "积分不可用：{message}",
			refresh: "刷新",
			refreshing: "刷新中…",
			requestFailed: "请求失败",
			accountHeading: "账号",
			modelsHeading: "优惠模型",
			freeModel: "免费",
			badgeLimitedFree: "限时免费",
			badgeNightDiscount: "夜间折扣",
			rate: "{rate} 积分/条消息"
		};
		//#endregion
		//#region src/drivers/loomy/client/index.tsx
		/**
		* Register card copy and the Loomy card under Plugin configuration. Guarded
		* the same way as the WorkBuddy registration: a slot-API breaking change
		* degrades to a `console.error` instead of breaking the DSH loader; both
		* host providers keep working.
		*/
		function registerLoomyCard(ctx) {
			try {
				const namespace = "settings.loomy";
				ctx.effect(() => ctx.locale.register(namespace, {
					zh,
					en
				}), "dsh-llm-bridge: loomy settings copy");
				const t = ctx.locale.bind(namespace);
				ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
					name: "settings.plugin.item",
					key: "loomy",
					priority: 30,
					inject: () => ({ t })
				}, LoomyPluginCard));
			} catch (error) {
				console.error("[dsh-llm-bridge] loomy client card failed to load (host provider unaffected):", error);
			}
		}
		//#endregion
		//#region src/client/index.tsx
		/** Stable browser-plugin name. */
		const name = "dsh-llm-bridge-client";
		/** Client services required by the Plugin configuration contributions. */
		const inject = ["slots", "locale"];
		/**
		* Register the WorkBuddy and Loomy cards under Plugin configuration.
		*
		* The registrations mirror each driver's guarded `register*Card` (the try/
		* catch shape is duplicated in `tests/client-fallback.spec.ts`, which cannot
		* import browser-only DSH packages).
		*/
		function apply(ctx) {
			registerWorkBuddyCard(ctx);
			registerLoomyCard(ctx);
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
