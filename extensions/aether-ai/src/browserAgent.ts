/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Aether IDE. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { OpenAIToolSchema } from './types';

export const BROWSER_TOOL_SCHEMAS: OpenAIToolSchema[] = [
	{
		type: 'function',
		function: {
			name: 'browser_navigate',
			description: 'Open a URL in Aether built-in headless browser (e.g. http://localhost:3000), wait for load, and return page title, visible text, console errors, and failed network requests.',
			parameters: {
				type: 'object',
				properties: {
					url: { type: 'string', description: 'URL to open.' },
				},
				required: ['url'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'browser_click',
			description: 'Click an element matching a CSS selector in the active browser page.',
			parameters: {
				type: 'object',
				properties: {
					selector: { type: 'string', description: 'CSS selector to click.' },
				},
				required: ['selector'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'browser_type',
			description: 'Set or type text into an input/textarea matching a CSS selector in the active browser page.',
			parameters: {
				type: 'object',
				properties: {
					selector: { type: 'string', description: 'CSS selector of input element.' },
					text: { type: 'string', description: 'Text to type.' },
				},
				required: ['selector', 'text'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'browser_evaluate',
			description: 'Evaluate a JavaScript expression in the active browser page and return its result.',
			parameters: {
				type: 'object',
				properties: {
					expression: { type: 'string', description: 'JavaScript expression to run in the page.' },
				},
				required: ['expression'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'browser_screenshot',
			description: 'Capture a PNG screenshot of the active browser page (optionally navigating to a URL first) for visual verification.',
			parameters: {
				type: 'object',
				properties: {
					url: { type: 'string', description: 'Optional URL to navigate to before taking the screenshot.' },
				},
			},
		},
	},
];

export interface BrowserActionResult {
	output: string;
	screenshotDataUrl?: string;
	isError?: boolean;
}

export class BuiltinBrowserAgent implements vscode.Disposable {
	private browserProc: ChildProcess | undefined;
	private ws: WebSocket | undefined;
	private port = 0;
	private nextId = 1;
	private consoleErrors: string[] = [];
	private failedRequests: string[] = [];
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

	public isBrowserTool(name: string): boolean {
		return BROWSER_TOOL_SCHEMAS.some(s => s.function.name === name);
	}

	public async execute(name: string, args: Record<string, unknown>, workspaceRoot?: string): Promise<BrowserActionResult> {
		try {
			await this.ensureConnected();
			switch (name) {
				case 'browser_navigate':
					return await this.navigate(String(args.url ?? ''));
				case 'browser_click':
					return await this.click(String(args.selector ?? ''));
				case 'browser_type':
					return await this.type(String(args.selector ?? ''), String(args.text ?? ''));
				case 'browser_evaluate':
					return await this.evaluate(String(args.expression ?? ''));
				case 'browser_screenshot':
					return await this.screenshot(typeof args.url === 'string' ? args.url : undefined, workspaceRoot);
				default:
					return { output: `Unknown browser tool: ${name}`, isError: true };
			}
		} catch (err) {
			return {
				output: `Browser agent error: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	}

	private async ensureConnected(): Promise<void> {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			return;
		}
		const exe = findChromiumExecutable();
		if (!exe) {
			throw new Error('Could not locate Chrome or Edge executable on this system for built-in Browser Agent.');
		}

		this.port = await findFreePort();
		const profileDir = path.join(os.tmpdir(), `aether-browser-${this.port}`);
		this.browserProc = spawn(exe, [
			'--headless=new',
			'--disable-gpu',
			`--remote-debugging-port=${this.port}`,
			`--user-data-dir=${profileDir}`,
			'--window-size=1280,800',
			'--no-first-run',
			'--no-default-browser-check',
			'about:blank',
		], { stdio: 'ignore' });

		this.browserProc.on('exit', () => {
			this.ws = undefined;
			this.browserProc = undefined;
		});

		let pageWsUrl = '';
		for (let i = 0; i < 30; i++) {
			try {
				const res = await fetch(`http://127.0.0.1:${this.port}/json`);
				if (res.ok) {
					const targets = await res.json() as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
					const page = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
					if (page?.webSocketDebuggerUrl) {
						pageWsUrl = page.webSocketDebuggerUrl;
						break;
					}
				}
			} catch {
				// Retry while browser starts
			}
			await sleep(200);
		}

		if (!pageWsUrl) {
			throw new Error('Timed out waiting for headless browser DevTools endpoint.');
		}

		const ws = new WebSocket(pageWsUrl);
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener('open', () => resolve(), { once: true });
			ws.addEventListener('error', () => reject(new Error('Failed to open CDP WebSocket')), { once: true });
		});

		ws.addEventListener('message', event => {
			const msg = JSON.parse(String(event.data)) as {
				id?: number;
				result?: unknown;
				error?: { message?: string };
				method?: string;
				params?: Record<string, unknown>;
			};
			if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
				const p = this.pending.get(msg.id)!;
				this.pending.delete(msg.id);
				if (msg.error) {
					p.reject(new Error(msg.error.message || 'CDP error'));
				} else {
					p.resolve(msg.result);
				}
			} else if (msg.method === 'Runtime.exceptionThrown') {
				const details = msg.params?.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
				this.consoleErrors.push(details?.exception?.description || details?.text || 'Uncaught exception');
			} else if (msg.method === 'Runtime.consoleAPICalled') {
				const type = String(msg.params?.type ?? '');
				if (type === 'error') {
					const args = (msg.params?.args as Array<{ value?: unknown; description?: string }> | undefined) ?? [];
					this.consoleErrors.push(args.map(a => String(a.value ?? a.description ?? '')).join(' '));
				}
			} else if (msg.method === 'Network.responseReceived') {
				const resp = msg.params?.response as { url?: string; status?: number } | undefined;
				if (resp && typeof resp.status === 'number' && resp.status >= 400) {
					this.failedRequests.push(`HTTP ${resp.status} ${resp.url ?? ''}`);
				}
			}
		});

		this.ws = ws;
		await this.cdp('Page.enable');
		await this.cdp('Runtime.enable');
		await this.cdp('Network.enable');
		await this.cdp('Emulation.setDeviceMetricsOverride', {
			width: 1280,
			height: 800,
			deviceScaleFactor: 1,
			mobile: false,
		});
	}

	private async cdp(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
		if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
			throw new Error('Browser CDP connection closed');
		}
		const id = this.nextId++;
		return await new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.pending.has(id)) {
					this.pending.delete(id);
					reject(new Error(`CDP ${method} timed out`));
				}
			}, 15_000);
			this.pending.set(id, {
				resolve: v => {
					clearTimeout(timer);
					resolve(v);
				},
				reject: e => {
					clearTimeout(timer);
					reject(e);
				},
			});
			this.ws!.send(JSON.stringify({ id, method, params }));
		});
	}

	private async navigate(url: string): Promise<BrowserActionResult> {
		this.consoleErrors = [];
		this.failedRequests = [];
		await this.cdp('Page.navigate', { url });
		await sleep(1800);
		const summary = await this.cdp('Runtime.evaluate', {
			returnByValue: true,
			expression: `({ title: document.title, url: location.href, text: (document.body?.innerText || '').slice(0, 2500) })`,
		}) as { result?: { value?: { title: string; url: string; text: string } } };
		const val = summary.result?.value;
		const lines = [
			`URL: ${val?.url ?? url}`,
			`Title: ${val?.title ?? '(none)'}`,
			`Console Errors (${this.consoleErrors.length}): ${this.consoleErrors.slice(0, 10).join(' | ') || 'None'}`,
			`Failed Requests (${this.failedRequests.length}): ${this.failedRequests.slice(0, 10).join(' | ') || 'None'}`,
			`Visible Text:\n${val?.text ?? ''}`,
		];
		return { output: lines.join('\n') };
	}

	private async click(selector: string): Promise<BrowserActionResult> {
		const res = await this.cdp('Runtime.evaluate', {
			returnByValue: true,
			expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'Element not found: ' + ${JSON.stringify(selector)}; el.click(); return 'Clicked ' + el.tagName + ' (' + (el.textContent || '').trim().slice(0, 60) + ')'; })()`,
		}) as { result?: { value?: string } };
		await sleep(700);
		return {
			output: `${res.result?.value ?? 'Done'}\nConsole Errors: ${this.consoleErrors.slice(-5).join(' | ') || 'None'}`,
		};
	}

	private async type(selector: string, text: string): Promise<BrowserActionResult> {
		const res = await this.cdp('Runtime.evaluate', {
			returnByValue: true,
			expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'Element not found: ' + ${JSON.stringify(selector)}; el.focus(); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return 'Typed into ' + el.tagName; })()`,
		}) as { result?: { value?: string } };
		return { output: res.result?.value ?? 'Typed' };
	}

	private async evaluate(expression: string): Promise<BrowserActionResult> {
		const res = await this.cdp('Runtime.evaluate', {
			returnByValue: true,
			awaitPromise: true,
			expression,
		}) as { result?: { value?: unknown; description?: string }; exceptionDetails?: { text?: string } };
		if (res.exceptionDetails) {
			return { output: `JS Exception: ${res.exceptionDetails.text ?? 'error'}`, isError: true };
		}
		const val = res.result?.value !== undefined ? JSON.stringify(res.result.value, null, 2) : (res.result?.description ?? 'undefined');
		return { output: val.slice(0, 6000) };
	}

	private async screenshot(url: string | undefined, workspaceRoot?: string): Promise<BrowserActionResult> {
		if (url) {
			await this.navigate(url);
		}
		const res = await this.cdp('Page.captureScreenshot', { format: 'png' }) as { data: string };
		const dataUrl = `data:image/png;base64,${res.data}`;
		let savedPath = '';
		if (workspaceRoot) {
			const dir = path.join(workspaceRoot, '.aether', 'screenshots');
			await fs.promises.mkdir(dir, { recursive: true });
			savedPath = path.join(dir, `shot_${Date.now()}.png`);
			await fs.promises.writeFile(savedPath, Buffer.from(res.data, 'base64'));
		}
		return {
			output: `Captured screenshot${savedPath ? ` saved to ${path.relative(workspaceRoot!, savedPath).replace(/\\/g, '/')}` : ''}. Console errors: ${this.consoleErrors.length}.`,
			screenshotDataUrl: dataUrl,
		};
	}

	public dispose(): void {
		try {
			this.ws?.close();
			this.browserProc?.kill();
		} catch {
			// Ignore
		}
		this.ws = undefined;
		this.browserProc = undefined;
	}
}

function findChromiumExecutable(): string | undefined {
	const candidates = process.platform === 'win32'
		? [
			'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
			'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
			'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
			'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
			path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
		]
		: process.platform === 'darwin'
			? [
				'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
				'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
			]
			: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
	return candidates.find(p => fs.existsSync(p));
}

function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.listen(0, '127.0.0.1', () => {
			const addr = srv.address();
			const port = typeof addr === 'object' && addr ? addr.port : 9333;
			srv.close(() => resolve(port));
		});
		srv.on('error', reject);
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise(r => setTimeout(r, ms));
}
