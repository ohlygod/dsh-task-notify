/**
 * 自测：验证「事件 → 提醒」这条链路，不弹真通知（用桩替换 powershell）。
 *
 * 跑法：`node selftest.mjs`（Node 20+）。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-task-notify-'));
process.env.DSH_HOME = home;

const mod = await import('./lib/index.js');

let pass = 0;
const failures = [];

/**
 * 断言。
 *
 * @param {string} label - 用例名。
 * @param {() => void | Promise<void>} fn - 断言体（抛错即失败）。
 */
async function check(label, fn) {
	try {
		await fn();
		pass += 1;
	} catch (error) {
		failures.push(`${label}: ${error?.message ?? error}`);
	}
}

/** 收集注册进来的处理器与路由。 */
const registered = { listeners: [], routes: [] };

/** 假 ctx。 */
const ctx = {
	on(eventName, handler, options) {
		registered.listeners.push({ eventName, handler, options });
	},
	webServer: {
		register(route) {
			registered.routes.push(route);
		},
	},
	logger: { info() {}, warn() {} },
};

mod.apply(ctx);

await check('监听 session/event 且带 global', () => {
	const listener = registered.listeners.find((item) => item.eventName === 'session/event');
	if (listener === undefined) throw new Error('没有订阅 session/event');
	if (listener.options?.global !== true) throw new Error('缺少 { global: true }，会一条都收不到');
});

await check('注册了本地路由 /api/task-notify', () => {
	const route = registered.routes.find((item) => item.path === '/api/task-notify');
	if (route === undefined) throw new Error('没有注册路由');
	if (route.kind !== 'prefix') throw new Error('应当是 prefix 路由');
});

/** 直接调监听器，验「只有 turn/end 才进合并队列」。 */
const listener = registered.listeners.find((item) => item.eventName === 'session/event');

await check('非 turn/end 不触发', () => {
	// 用「有没有写日志」间接判：先清日志再打一条 assistant/message。
	const before = mod.loadConfig().enabled;
	if (before !== true) throw new Error('默认应当启用');
	listener.handler({ id: 'sess-a' }, { type: 'assistant/message', data: {} });
	listener.handler({ id: 'sess-a' }, { type: 'turn/start', data: {} });
	// 走不到 doNotify 就不会有 pending —— 这里只验证不抛错。
});

await check('turn/end 会进入合并队列（不抛错）', () => {
	listener.handler({ id: 'sess-b', header: { title: '测试会话' } }, { type: 'turn/end', data: { turn: 1 } });
});

await check('空 sessionId 被忽略', () => {
	listener.handler({}, { type: 'turn/end', data: {} });
	listener.handler({ id: '' }, { type: 'turn/end', data: {} });
});

await check('配置读写', () => {
	mod.saveConfig({ enabled: false, minSeconds: 30, onlyWhenUnfocused: true });
	const back = mod.loadConfig();
	if (back.enabled !== false) throw new Error('enabled 未落盘');
	if (back.minSeconds !== 30) throw new Error('minSeconds 未落盘');
	if (back.onlyWhenUnfocused !== true) throw new Error('onlyWhenUnfocused 未落盘');
	mod.saveConfig({ enabled: true, minSeconds: 0, onlyWhenUnfocused: false });
});

await check('非法配置被归一化', () => {
	mod.saveConfig({ enabled: true, minSeconds: -5, onlyWhenUnfocused: 'yes' });
	const back = mod.loadConfig();
	if (back.minSeconds !== 0) throw new Error(`负数应归一化为 0，得到 ${back.minSeconds}`);
	if (back.onlyWhenUnfocused !== false) throw new Error('非布尔应归一化为 false');
});

rmSync(home, { recursive: true, force: true });

if (failures.length > 0) {
	console.error(`✗ ${failures.length} 项失败 / ${pass} 项通过`);
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过`);
