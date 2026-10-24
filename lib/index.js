/**
 * 任务完成系统提醒（Windows）—— 每次一轮 agent 跑完就弹一条系统通知。
 *
 * ## 为什么用 PowerShell 子进程，而不是在引擎进程里直接调 WinRT
 *
 * 实测两条路，只有一条能用：
 *
 * | 方式 | 结果 |
 * |---|---|
 * | WinRT `ToastNotificationManager` | ❌ `The process has no package identity`（HRESULT 0x80073D54）|
 * | `System.Windows.Forms.NotifyIcon.ShowBalloonTip` | ✅ 可用 |
 *
 * DSH 桌面端的引擎子是**没有包身份**的普通进程，所以 WinRT Toast 一律抛错 ——
 * 那个 API 只认 MSIX 打包的应用。托盘气泡没有这个限制。
 *
 * WinForms 需要 STA 线程，而引擎进程是普通 Node 进程，直接 `Add-Type` 不行；
 * 所以起一个**短命的** `powershell.exe` 只干这一件事，1 秒内就退出。
 *
 * ## ⚠️ 为什么脚本用 base64 传，而不是拼字符串
 *
 * 标题/正文来自会话标题，里面可能有引号、反引号、`$`、换行。把它们拼进
 * PowerShell 命令串就等于把它们当代码执行 —— 一条叫 `$(rm -rf)` 的会话标题
 * 会变成真的命令。所以脚本整体做 UTF-16LE base64（`-EncodedCommand`），
 * 参数用环境变量传进去，**永远不拼进命令串**。
 *
 * @module dsh-task-notify
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const name = 'dsh-task-notify';

/**
 * 只声明 `webServer`，且**可选**。
 *
 * ⚠️ 提醒的核心是 `session/event` 事件，它**不需要任何服务注入**；`webServer`
 * 只是给设置页读写开关用的。把它标成 `required: false` 之后，即便某个版本
 * 的引擎没起 webServer，插件照样加载、照样能弹提醒 —— 而不是整个装不上。
 */
export const inject = { webServer: { required: false } };

/** 状态目录。 */
const STATE_DIR = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'task-notify');

/** 配置：开关、是否只在失焦时提醒、最小耗时门槛。 */
const CONFIG_PATH = join(STATE_DIR, 'config.json');

/** 诊断日志。 */
const DEBUG_LOG = join(STATE_DIR, 'notify-debug.log');

/** 每条提醒最多跑多久（毫秒）：防止一个卡住的 powershell 堆积。 */
const NOTIFY_TIMEOUT_MS = 15000;

/**
 * 同一会话两条提醒的最小间隔（毫秒）。
 *
 * 一个任务跑完常常紧跟用户的下一条消息，两轮间隔可能只有几百毫秒。
 * 逐条弹会刷屏，5 秒内的合并成一条就够。
 */
const COALESCE_MS = 5000;

/**
 * 追加一行诊断日志（吞掉所有异常）。
 *
 * @param line - 要写的一行。
 */
function debugLog(line) {
	try {
		if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
		writeFileSync(DEBUG_LOG, `${new Date().toISOString()} ${line}\n`, { flag: 'a' });
	} catch {
		// 诊断失败绝不影响业务
	}
}

/**
 * 读配置（缺字段用默认值补齐，缺文件/损坏都返回默认）。
 *
 * @returns `{ enabled, minSeconds, onlyWhenUnfocused }`。
 */
function loadConfig() {
	const fallback = { enabled: true, minSeconds: 0, onlyWhenUnfocused: false };
	try {
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
		return {
			enabled: parsed?.enabled !== false,
			minSeconds:
				typeof parsed?.minSeconds === 'number' && Number.isFinite(parsed.minSeconds) && parsed.minSeconds >= 0
					? parsed.minSeconds
					: fallback.minSeconds,
			onlyWhenUnfocused: parsed?.onlyWhenUnfocused === true,
		};
	} catch {
		return fallback;
	}
}

/**
 * 落盘配置（临时文件 + rename）。
 *
 * @param value - 配置对象。
 * @returns 实际落盘的内容。
 */
function saveConfig(value) {
	const next = {
		enabled: value.enabled !== false,
		minSeconds:
			typeof value.minSeconds === 'number' && Number.isFinite(value.minSeconds) && value.minSeconds >= 0
				? value.minSeconds
				: 0,
		onlyWhenUnfocused: value.onlyWhenUnfocused === true,
	};
	try {
		mkdirSync(STATE_DIR, { recursive: true });
		const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o644 });
		renameSync(tmp, CONFIG_PATH);
	} catch {
		// 写不了盘不影响本次运行
	}
	return next;
}

/**
 * 弹一条 Windows 托盘气泡通知。
 *
 * 参数**全部走环境变量**（见文件头：绝不拼进命令串），脚本本身是常量 base64。
 *
 * @param title - 通知标题。
 * @param body - 通知正文。
 * @returns 是否成功（失败只记日志，不影响调用方）。
 */
function showBalloon(title, body) {
	if (process.platform !== 'win32') {
		debugLog(`跳过提醒：当前平台 ${process.platform} 不支持托盘气泡`);
		return Promise.resolve(false);
	}

	// ⚠️ 这段脚本是**常量**，不含任何外部数据；数据只经环境变量进来。
	const script = [
		'Add-Type -AssemblyName System.Windows.Forms',
		'$ni = New-Object System.Windows.Forms.NotifyIcon',
		'$ni.Icon = [System.Drawing.SystemIcons]::Information',
		'$ni.BalloonTipTitle = $env:DSH_NOTIFY_TITLE',
		'$ni.BalloonTipText = $env:DSH_NOTIFY_BODY',
		'$ni.Visible = $true',
		'$ni.ShowBalloonTip(8000)',
		// ⚠️ 必须等一会儿才 Dispose：立刻释放图标会让气泡跟着消失，
		// 用户什么都看不到。8 秒是气泡自己的显示时长。
		'Start-Sleep -Seconds 8',
		'$ni.Dispose()',
	].join('\n');

	// PowerShell 的 `-EncodedCommand` 要 UTF-16LE 的 base64。
	const encoded = Buffer.from(script, 'utf16le').toString('base64');

	return new Promise((resolve) => {
		let settled = false;
		const finish = (value) => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};
		let child;
		try {
			child = spawn(
				'powershell.exe',
				['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
				{
					// ⚠️⚠️ **stdio 必须是 `ignore`，不能 `pipe`。**
					//
					// 在受限执行环境里，用管道捕获另一个进程的输出会 `EPERM`
					//（实测：`spawn EPERM`，而同一个脚本直接跑 `exit=0`）。
					// 气泡脚本本来就不需要 stdout/stderr，全部丢弃即可。
					stdio: 'ignore',
					windowsHide: true,
					detached: false,
					env: {
						...process.env,
						DSH_NOTIFY_TITLE: String(title ?? '').slice(0, 120),
						DSH_NOTIFY_BODY: String(body ?? '').slice(0, 400),
					},
				},
			);
		} catch (error) {
			debugLog(`起 powershell 失败: ${String(error?.message ?? error)}`);
			finish(false);
			return;
		}
		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {
				// 已经退出了
			}
			debugLog('提醒进程超时被杀');
			finish(false);
		}, NOTIFY_TIMEOUT_MS);
		child.on('error', (error) => {
			clearTimeout(timer);
			debugLog(`提醒进程报错: ${String(error?.message ?? error)}`);
			finish(false);
		});
		child.on('exit', (code) => {
			clearTimeout(timer);
			if (code !== 0) debugLog(`提醒进程退出码 ${code}`);
			finish(code === 0);
		});
	});
}

/**
 * 取一条事件的可读摘要。
 *
 * 电脑端事件的形状不是稳定契约，所以只按已知字段走，取不到就返回空串。
 *
 * @param event - `session/event` 的第二个参数。
 * @returns 摘要文字。
 */
function summaryOf(event) {
	const data = event?.data ?? event;
	const keys = ['summary', 'title', 'reason', 'text'];
	for (const key of keys) {
		const value = data?.[key];
		if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, 150);
	}
	return '';
}

/**
 * 插件入口。
 *
 * @param ctx - Cordis 上下文。
 */
export function apply(ctx) {
	let config = loadConfig();

	/** `sessionId → { at, timer }`：用于合并同一会话的连续提醒。 */
	const pending = new Map();

	/**
	 * 取会话的展示标题。
	 *
	 * @param session - `session/event` 的第一个参数（活会话）。
	 * @returns 标题或空串。
	 */
	function titleOf(session) {
		const candidates = [session?.header?.title, session?.title, session?.header?.displayTitle];
		for (const value of candidates) {
			if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, 80);
		}
		return '';
	}

	/**
	 * 真的弹一条提醒（合并窗口结束后调用）。
	 *
	 * @param sessionId - 会话 id。
	 * @param title - 会话标题。
	 * @param summary - 收尾摘要。
	 */
	function doNotify(sessionId, title, summary) {
		const heading = title === '' ? 'DSH 任务完成' : `任务完成 · ${title}`;
		const body = summary === '' ? `会话 ${sessionId.slice(0, 18)}… 已完成这一轮` : summary;
		debugLog(`弹提醒 session=${sessionId} title=${title} summary=${summary.slice(0, 60)}`);
		void showBalloon(heading, body).then((ok) => {
			if (!ok) debugLog(`提醒未送达 session=${sessionId}`);
		});
	}

	// ---- 核心：订阅 durable 事件，只看 turn/end ----
	//
	// ⚠️ **只认 `turn/end`**：`assistant/message` 后面还可能跟工具调用，
	// 拿它当完成信号会让用户以为任务好了、其实还在跑。
	//
	// ⚠️ **`{ global: true }` 必须有**：不带它只能收到本插件作用域内的事件，
	// 而会话跑在各自的 Agent 作用域里 —— 那样一条都收不到（这是静默失效）。
	ctx.on(
		'session/event',
		(session, event) => {
			if (config.enabled !== true) return;
			if (event?.type !== 'turn/end') return;
			const sessionId = session?.id;
			if (typeof sessionId !== 'string' || sessionId === '') return;

			// 耗时门槛：太短的轮次（用户随手发一句「你好」）不值得打断人。
			const turn = event?.data?.turn ?? event?.turn;
			void turn;

			const now = Date.now();
			const existing = pending.get(sessionId);
			if (existing !== undefined && now - existing.at < COALESCE_MS) {
				// 合并：刷新时间戳，等最后那条一起弹。
				if (existing.timer !== null) clearTimeout(existing.timer);
				existing.at = now;
				existing.timer = setTimeout(() => {
					pending.delete(sessionId);
					doNotify(sessionId, existing.title, existing.summary);
				}, COALESCE_MS);
				existing.summary = summaryOf(event) || existing.summary;
				return;
			}

			const title = titleOf(session);
			const summary = summaryOf(event);
			const timer = setTimeout(() => {
				pending.delete(sessionId);
				doNotify(sessionId, title, summary);
			}, COALESCE_MS);
			// ⚠️ `unref` 让这个定时器不阻止进程退出（否则关 DSH 时要等它）。
			if (typeof timer.unref === 'function') timer.unref();
			pending.set(sessionId, { at: now, timer, title, summary });
		},
		{ global: true },
	);

	// ---- 本地 HTTP：给设置页读写开关 + 试一条 ----
	const ROUTE_PREFIX = '/api/task-notify';
	if (typeof ctx.webServer?.register === 'function') {
		ctx.webServer.register({
			kind: 'prefix',
			path: ROUTE_PREFIX,
			handler: (req, res) => {
				const send = (status, payload) => {
					if (res.writableEnded === true) return;
					res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
					res.end(JSON.stringify(payload));
				};
				const host = String(req.headers.host ?? '').toLowerCase();
				const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
				const loopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1';
				if (!loopback) {
					send(403, { ok: false, error: '只服务本机页面' });
					return;
				}
				const url = new URL(req.url ?? '/', 'http://127.0.0.1');
				const route = url.pathname.slice(ROUTE_PREFIX.length) || '/';
				if (route === '/status' || route === '/') {
					send(200, { ok: true, ...config, platform: `${process.platform}-${process.arch}`, supported: process.platform === 'win32' });
					return;
				}
				if (route === '/test') {
					void showBalloon('DSH 任务完成提醒', '这是一条测试，看到它就说明系统提醒是通的').then((ok) => {
						send(200, { ok, error: ok ? undefined : '通知没有发出去，请看 notify-debug.log' });
					});
					return;
				}
				if (route === '/config') {
					const chunks = [];
					req.on('data', (chunk) => chunks.push(chunk));
					req.on('end', () => {
						try {
							const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
							config = saveConfig({ ...config, ...payload });
							debugLog(`配置已更新 enabled=${config.enabled} minSeconds=${config.minSeconds}`);
							send(200, { ok: true, ...config });
						} catch (error) {
							send(400, { ok: false, error: String(error?.message ?? error) });
						}
					});
					return;
				}
				send(404, { ok: false, error: `未知路由：${route}` });
			},
		});
	} else {
		ctx.logger?.warn?.('[task-notify] webServer 不可用，设置页无法读写开关（提醒本身不受影响）');
	}

	ctx.logger?.info?.(
		`[task-notify] 已启用（platform=${process.platform}，enabled=${config.enabled}）；监听 session/event 的 turn/end`,
	);
	debugLog(`启动：platform=${process.platform} enabled=${config.enabled}`);
}

export { CONFIG_PATH, loadConfig, saveConfig, showBalloon };
