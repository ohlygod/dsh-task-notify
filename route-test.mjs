import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'notify-route-'));
process.env.DSH_HOME = home;
const mod = await import('./lib/index.js');

let route;
const ctx = {
	on() {},
	webServer: { register: (r) => { route = r; } },
	logger: { info() {}, warn() {} },
};
mod.apply(ctx);
if (!route || route.path !== '/api/task-notify' || route.kind !== 'prefix') {
	throw new Error('route 注册不对: ' + JSON.stringify(route && { k: route.kind, p: route.path }));
}

function fakeRes() {
	return { _h: null, writableEnded: false, writeHead(s, h) { this._h = { s, h }; }, end(b) { this.writableEnded = true; this.body = b; } };
}
function waitEnded(res, ms = 2000) {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const tick = () => {
			if (res.writableEnded) return resolve();
			if (Date.now() - start > ms) return reject(new Error('res 未在期限内结束'));
			setTimeout(tick, 10);
		};
		tick();
	});
}

// ① 非 loopback → 403
let res = fakeRes();
route.handler({ url: '/api/task-notify/status', method: 'GET', headers: { host: 'evil.com' } }, res);
if (res._h.s !== 403) throw new Error('非 loopback 未拦截: ' + res._h.s);

// ② status
res = fakeRes();
route.handler({ url: '/api/task-notify/status', method: 'GET', headers: { host: '127.0.0.1:52608' } }, res);
let out = JSON.parse(res.body);
if (!out.ok || typeof out.enabled !== 'boolean' || out.supported !== (process.platform === 'win32')) {
	throw new Error('status 返回不对: ' + res.body);
}

// ③ 未知路由 → 404
res = fakeRes();
route.handler({ url: '/api/task-notify/nope', method: 'GET', headers: { host: '127.0.0.1' } }, res);
if (res._h.s !== 404) throw new Error('未知路由未 404');

// ④ config 写开关
const body = JSON.stringify({ enabled: false });
res = fakeRes();
route.handler(
	{
		url: '/api/task-notify/config',
		method: 'POST',
		headers: { host: '127.0.0.1', 'content-type': 'application/json' },
		on(ev, cb) { (this._c ||= {})[ev] = cb; },
	},
	res,
);
// 手动触发 data/end
const req = {
	url: '/api/task-notify/config',
	method: 'POST',
	headers: { host: '127.0.0.1' },
	on(ev, cb) { (this._c ||= {})[ev] = cb; },
};
route.handler(req, res);
req._c.data(Buffer.from(body));
req._c.end();
await waitEnded(res);
out = JSON.parse(res.body);
if (!out.ok || out.enabled !== false) throw new Error('config 未生效: ' + res.body);

const back = mod.loadConfig();
if (back.enabled !== false) throw new Error('配置未落盘');

rmSync(home, { recursive: true, force: true });
console.log('✓ 路由围栏 / status / 未知路由 / config 落盘 全部通过');
