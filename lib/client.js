/**
 * dsh-task-notify —— 设置页（client half）。
 *
 * 只在设置里加一页「任务提醒」：开关、试一条、看平台。
 *
 * ⚠️ 语法约束（旧内核）：不用可选链、空值合并、Object.fromEntries、Array.flat。
 *
 * @module dsh-task-notify/client
 */

window.__ModuleLoader__.load({
	id: 'dsh-task-notify',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		var react = require('react');
		var h = react.createElement;

		var primitives = require('@deepseek-ai/dsh-client-ui-primitives');
		var Button = primitives.Button;
		var Pill = primitives.Pill;

		var API = '/api/task-notify';

		/**
		 * 调一条本地接口。
		 *
		 * @param action - `/status` / `/test` / `/config`。
		 * @param body - 请求体；不传就 GET。
		 * @returns 结果 Promise（永不 reject）。
		 */
		function call(action, body) {
			var options = { cache: 'no-store' };
			if (body !== undefined) {
				options.method = 'POST';
				options.headers = { 'content-type': 'application/json' };
				options.body = JSON.stringify(body);
			}
			return fetch(API + action, options).then(
				function (response) {
					return response.json().then(
						function (payload) {
							return payload;
						},
						function () {
							return { ok: false, error: '宿主返回的不是 JSON（HTTP ' + response.status + '）' };
						},
					);
				},
				function (error) {
					return { ok: false, error: '连不上宿主服务：' + String((error && error.message) || error) };
				},
			);
		}

		var CSS_TEXT = {
			page: 'display:flex;flex-direction:column;gap:16px;padding:4px 0 24px;max-width:640px;',
			card: 'display:flex;flex-direction:column;gap:12px;padding:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,10px);',
			title: 'color:var(--dsw-alias-label-primary);font-size:14px;font-weight:510;line-height:22px;margin:0;',
			desc: 'color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;margin:0;',
			hint: 'color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin:0;',
			row: 'display:flex;flex-wrap:wrap;align-items:center;gap:8px;',
			error: 'color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px;margin:0;',
			ok: 'color:var(--dsw-alias-state-success-primary,#3fb950);font-size:13px;line-height:20px;margin:0;',
			kv: 'display:flex;gap:8px;align-items:baseline;',
			kvKey: 'color:var(--dsw-alias-label-tertiary);font-size:12px;min-width:72px;',
			kvVal: 'color:var(--dsw-alias-label-primary);font-size:13px;word-break:break-all;',
		};

		/**
		 * CSS 文本 → React style 对象（React 只收对象，给字符串会抛 #62）。
		 *
		 * @param text - 声明串。
		 * @returns style 对象。
		 */
		function toStyle(text) {
			var out = {};
			var parts = String(text).split(';');
			for (var index = 0; index < parts.length; index += 1) {
				var part = parts[index];
				if (part === '') continue;
				var colon = part.indexOf(':');
				if (colon < 0) continue;
				var key = part.slice(0, colon).trim();
				var value = part.slice(colon + 1).trim();
				if (key === '' || value === '') continue;
				out[key.replace(/-([a-z])/g, function (match, letter) {
					return letter.toUpperCase();
				})] = value;
			}
			return out;
		}

		var CSS = {};
		for (var styleKey in CSS_TEXT) CSS[styleKey] = toStyle(CSS_TEXT[styleKey]);

		/** 一行「键: 值」。 */
		function kv(key, value) {
			return h(
				'div',
				{ key: 'kv-' + key, style: CSS.kv },
				h('span', { style: CSS.kvKey }, key),
				h('span', { style: CSS.kvVal }, value),
			);
		}

		/** 「任务提醒」设置页。 */
		function TaskNotifyPanel() {
			var statusState = react.useState(null);
			var status = statusState[0];
			var setStatus = statusState[1];

			var busyState = react.useState('');
			var busy = busyState[0];
			var setBusy = busyState[1];

			var msgState = react.useState(null);
			var message = msgState[0];
			var setMessage = msgState[1];

			var reload = react.useCallback(function () {
				return call('/status').then(function (payload) {
					if (payload && payload.ok === true) setStatus(payload);
					else setMessage({ kind: 'error', text: (payload && payload.error) || '读取状态失败' });
				});
			}, []);

			react.useEffect(function () {
				reload();
			}, [reload]);

			/** 切换总开关。 */
			var toggle = react.useCallback(function () {
				if (status === null) return;
				setBusy('config');
				call('/config', { enabled: status.enabled !== true }).then(function (payload) {
					setBusy('');
					if (payload && payload.ok === true) {
						setStatus(function (prev) {
							var next = {};
							for (var key in prev) next[key] = prev[key];
							next.enabled = payload.enabled;
							return next;
						});
					} else {
						setMessage({ kind: 'error', text: (payload && payload.error) || '保存失败' });
					}
				});
			}, [status]);

			/** 试弹一条。 */
			var test = react.useCallback(function () {
				setBusy('test');
				setMessage(null);
				call('/test', {}).then(function (payload) {
					setBusy('');
					if (payload && payload.ok === true) {
						setMessage({ kind: 'ok', text: '已经弹了一条 —— 没看到的话请检查系统通知设置（专注助手/免打扰）' });
					} else {
						setMessage({ kind: 'error', text: (payload && payload.error) || '发送失败' });
					}
				});
			}, []);

			if (status === null) {
				return h('div', { style: CSS.page }, h('p', { style: CSS.hint }, '正在读取状态…'));
			}
			if (status.ok === false) {
				return h('div', { style: CSS.page }, h('p', { style: CSS.error }, status.error || '宿主没有返回状态'));
			}

			var children = [];

			children.push(
				h(
					'div',
					{ key: 'status', style: CSS.card },
					h('h3', { style: CSS.title }, '任务完成的系统提醒'),
					h(
						'p',
						{ style: CSS.desc },
						'每次一轮任务跑完（turn/end）就在系统托盘弹一条通知。只在本机弹，不联网、不上传任何内容。',
					),
					h(
						'div',
						{ style: CSS.row },
						status.enabled === true ? h(Pill, { active: true }, '已开启') : h(Pill, null, '已关闭'),
						h(
							'span',
							{ style: CSS.hint },
							status.supported === true
								? '当前平台支持'
								: '当前平台（' + String(status.platform || '?') + '）不支持托盘气泡',
						),
					),
					kv('平台', String(status.platform || '')),
					h(
						'div',
						{ style: CSS.row },
						h(
							Button,
							{ variant: 'outline', size: 'sm', onClick: toggle, disabled: busy !== '' },
							busy === 'config' ? '保存中…' : status.enabled === true ? '关闭提醒' : '开启提醒',
						),
						h(
							Button,
							{ variant: 'primary', size: 'sm', onClick: test, disabled: busy !== '' || status.supported !== true },
							busy === 'test' ? '正在弹…' : '试一条',
						),
						h(Button, { variant: 'ghost', size: 'sm', onClick: reload, disabled: busy !== '' }, '刷新'),
					),
				),
			);

			if (message !== null) {
				children.push(
					h('p', { key: 'message', style: message.kind === 'ok' ? CSS.ok : CSS.error }, message.text),
				);
			}

			children.push(
				h(
					'div',
					{ key: 'note', style: CSS.card },
					h('h3', { style: CSS.title }, '说明'),
					h(
						'p',
						{ style: CSS.hint },
						'Windows 的 Toast 通知需要应用有「包身份」，DSH 桌面端没有，所以这里用的是托盘气泡。它同样会进系统通知中心，但不会出现在「专注助手」的置顶样式里。',
					),
					h(
						'p',
						{ style: CSS.hint },
						'5 秒内同一个会话连续完成的多轮会合并成一条，避免刷屏。',
					),
				),
			);

			return h('div', { style: CSS.page }, children);
		}

		var SLOT = 'settings.section';
		var CELL_ID = 'dsh-task-notify';

		function apply(ctx) {
			try {
				ctx.slots.inject(SLOT, function () {
					return ctx.slots.register(
						{
							name: SLOT,
							id: CELL_ID,
							order: 216,
							label: '任务提醒',
						},
						TaskNotifyPanel,
					);
				});
			} catch (error) {
				try {
					console.warn('[dsh-task-notify] 设置页注册失败（已忽略）:', error);
				} catch (ignored) {
					/* 连 console 都没有也不能炸 */
				}
			}
		}

		exports.apply = apply;
		exports.inject = ['slots'];
		return module.exports;
	},
});
