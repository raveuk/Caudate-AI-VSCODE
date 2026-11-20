/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Aether IDE. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { McpServerStatus, OpenAIToolSchema } from './types';

interface McpServerConfig {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	disabled?: boolean;
}

interface McpConfigFile {
	mcpServers?: Record<string, McpServerConfig>;
}

interface McpRemoteTool {
	serverName: string;
	toolName: string;
	qualifiedName: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

class StdioMcpConnection {
	private proc: ChildProcessWithoutNullStreams | undefined;
	private nextId = 1;
	private buffer = '';
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

	constructor(
		public readonly name: string,
		private readonly config: McpServerConfig
	) {}

	public async connect(): Promise<void> {
		if (!this.config.command) {
			throw new Error('Missing command for stdio MCP server');
		}
		const cmd = this.config.command.trim();
		if (!cmd || /[;&|`$<>()\r\n]/.test(cmd)) {
			throw new Error(`Rejected unsafe MCP server command: "${this.config.command}"`);
		}
		const args = (this.config.args ?? []).map(a => String(a));
		const needsWindowsCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
		if (needsWindowsCmd && args.some(a => /[&|<>^%\r\n]/.test(a))) {
			throw new Error(`Rejected unsafe shell metacharacters in arguments for MCP server "${this.name}"`);
		}
		const spawnBin = needsWindowsCmd ? (process.env.COMSPEC || 'cmd.exe') : cmd;
		const spawnArgs = needsWindowsCmd ? ['/d', '/s', '/c', cmd, ...args] : args;
		this.proc = spawn(spawnBin, spawnArgs, {
			env: { ...process.env, ...(this.config.env ?? {}) },
			shell: false,
		});

		this.proc.stdout.on('data', chunk => {
			this.buffer += chunk.toString('utf8');
			const lines = this.buffer.split(/\r?\n/);
			this.buffer = lines.pop() ?? '';
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) {
					continue;
				}
				try {
					const msg = JSON.parse(trimmed) as { id?: number; result?: unknown; error?: { message?: string } };
					if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
						const p = this.pending.get(msg.id)!;
						this.pending.delete(msg.id);
						if (msg.error) {
							p.reject(new Error(msg.error.message || 'MCP error'));
						} else {
							p.resolve(msg.result);
						}
					}
				} catch {
					// Ignore non-JSON log lines on stdout
				}
			}
		});

		this.proc.on('exit', () => {
			for (const [, p] of this.pending) {
				p.reject(new Error(`MCP server "${this.name}" exited`));
			}
			this.pending.clear();
		});

		await this.request('initialize', {
			protocolVersion: '2024-11-05',
			capabilities: {},
			clientInfo: { name: 'aether-ide', version: '1.0.0' },
		});
		this.notify('notifications/initialized', {});
	}

	public async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
		if (!this.proc || this.proc.killed) {
			throw new Error(`MCP server "${this.name}" is not running`);
		}
		const id = this.nextId++;
		return await new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.pending.has(id)) {
					this.pending.delete(id);
					reject(new Error(`MCP request "${method}" timed out after 15s`));
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
			const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }) + '\n';
			this.proc!.stdin.write(payload);
		});
	}

	private notify(method: string, params?: Record<string, unknown>): void {
		if (!this.proc || this.proc.killed) {
			return;
		}
		const payload = JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} }) + '\n';
		this.proc.stdin.write(payload);
	}

	public dispose(): void {
		try {
			this.proc?.kill();
		} catch {
			// Ignore kill error
		}
		this.proc = undefined;
	}
}

class HttpMcpConnection {
	private nextId = 1;

	constructor(
		public readonly name: string,
		private readonly config: McpServerConfig
	) {}

	public async connect(): Promise<void> {
		if (!this.config.url) {
			throw new Error('Missing url for HTTP MCP server');
		}
		const parsed = new URL(this.config.url);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			throw new Error(`Unsupported MCP URL protocol "${parsed.protocol}". Only http: and https: are allowed.`);
		}
		await this.request('initialize', {
			protocolVersion: '2024-11-05',
			capabilities: {},
			clientInfo: { name: 'caudate-ide', version: '1.0.0' },
		}).catch(() => undefined);
	}

	public async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
		const id = this.nextId++;
		const res = await fetch(this.config.url!, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/json, text/event-stream',
				...(this.config.headers ?? {}),
			},
			body: JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }),
		});
		if (!res.ok) {
			throw new Error(`HTTP ${res.status} from MCP server "${this.name}"`);
		}
		const text = await res.text();
		// Support direct JSON or SSE data: lines
		let jsonText = text.trim();
		if (jsonText.startsWith('event:') || jsonText.startsWith('data:')) {
			const dataLine = jsonText.split(/\r?\n/).find(l => l.startsWith('data:'));
			if (dataLine) {
				jsonText = dataLine.slice(5).trim();
			}
		}
		const parsed = JSON.parse(jsonText) as { result?: unknown; error?: { message?: string } };
		if (parsed.error) {
			throw new Error(parsed.error.message || 'MCP HTTP error');
		}
		return parsed.result;
	}

	public dispose(): void {
		// Stateless HTTP
	}
}

export class McpClientManager implements vscode.Disposable {
	private stdioConns = new Map<string, StdioMcpConnection>();
	private httpConns = new Map<string, HttpMcpConnection>();
	private tools = new Map<string, McpRemoteTool>();
	private statuses: McpServerStatus[] = [];

	public getStatuses(): McpServerStatus[] {
		return [...this.statuses];
	}

	public getToolSchemas(): OpenAIToolSchema[] {
		return [...this.tools.values()].map(t => ({
			type: 'function',
			function: {
				name: t.qualifiedName,
				description: `[MCP:${t.serverName}] ${t.description}`,
				parameters: {
					type: 'object',
					properties: (t.inputSchema.properties as Record<string, unknown>) ?? {},
					required: Array.isArray(t.inputSchema.required) ? (t.inputSchema.required as string[]) : undefined,
				},
			},
		}));
	}

	public hasTool(qualifiedName: string): boolean {
		return this.tools.has(qualifiedName);
	}

	public async callTool(qualifiedName: string, args: Record<string, unknown>): Promise<string> {
		const tool = this.tools.get(qualifiedName);
		if (!tool) {
			throw new Error(`Unknown MCP tool: ${qualifiedName}`);
		}
		const conn = this.stdioConns.get(tool.serverName) ?? this.httpConns.get(tool.serverName);
		if (!conn) {
			throw new Error(`MCP server "${tool.serverName}" is not connected`);
		}
		const res = await conn.request('tools/call', {
			name: tool.toolName,
			arguments: args,
		}) as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };

		if (Array.isArray(res?.content)) {
			return res.content.map(c => c.text ?? JSON.stringify(c)).join('\n');
		}
		return JSON.stringify(res ?? {}, null, 2);
	}

	public async openOrCreateConfig(workspaceRoot?: string): Promise<void> {
		const configPath = workspaceRoot
			? path.join(workspaceRoot, '.caudate', 'mcp.json')
			: path.join(os.homedir(), '.caudate-ide', 'mcp.json');

		if (!fs.existsSync(configPath)) {
			await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
			const template = {
				mcpServers: {
					// Example stdio MCP server (uncomment and customize):
					// "filesystem": {
					//   "command": "npx",
					//   "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
					// }
				},
			};
			await fs.promises.writeFile(configPath, JSON.stringify(template, null, 2) + '\n', 'utf8');
		}
		const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(configPath));
		await vscode.window.showTextDocument(doc);
	}

	public async reload(workspaceRoot?: string): Promise<McpServerStatus[]> {
		this.disconnectAll();

		const merged: Record<string, McpServerConfig> = {};
		const workspacePaths = workspaceRoot && vscode.workspace.isTrusted
			? [
				path.join(workspaceRoot, '.caudate', 'mcp.json'),
				path.join(workspaceRoot, '.aether', 'mcp.json'),
				path.join(workspaceRoot, '.cursor', 'mcp.json'),
			]
			: [];
		const paths = [
			path.join(os.homedir(), '.caudate-ide', 'mcp.json'),
			path.join(os.homedir(), '.aether-ide', 'mcp.json'),
			...workspacePaths,
		];

		for (const filePath of paths) {
			try {
				if (!fs.existsSync(filePath)) {
					continue;
				}
				const parsed = JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as McpConfigFile;
				if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
					Object.assign(merged, parsed.mcpServers);
				}
			} catch {
				// Ignore invalid JSON
			}
		}

		for (const [name, cfg] of Object.entries(merged)) {
			if (cfg.disabled) {
				continue;
			}
			const transport: 'stdio' | 'http' = cfg.url ? 'http' : 'stdio';
			try {
				const conn = transport === 'http'
					? new HttpMcpConnection(name, cfg)
					: new StdioMcpConnection(name, cfg);
				await conn.connect();
				if (conn instanceof StdioMcpConnection) {
					this.stdioConns.set(name, conn);
				} else {
					this.httpConns.set(name, conn);
				}

				const listRes = await conn.request('tools/list', {}) as {
					tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
				};
				const serverToolNames: string[] = [];
				for (const t of listRes?.tools ?? []) {
					const safeServer = name.replace(/[^a-zA-Z0-9_-]/g, '_');
					const safeTool = t.name.replace(/[^a-zA-Z0-9_-]/g, '_');
					const qualifiedName = `mcp__${safeServer}__${safeTool}`;
					this.tools.set(qualifiedName, {
						serverName: name,
						toolName: t.name,
						qualifiedName,
						description: t.description ?? t.name,
						inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
					});
					serverToolNames.push(t.name);
				}

				this.statuses.push({
					name,
					transport,
					status: 'connected',
					toolCount: serverToolNames.length,
					tools: serverToolNames,
				});
			} catch (err) {
				this.statuses.push({
					name,
					transport,
					status: 'error',
					toolCount: 0,
					tools: [],
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		return this.getStatuses();
	}

	private disconnectAll(): void {
		for (const c of this.stdioConns.values()) {
			c.dispose();
		}
		for (const c of this.httpConns.values()) {
			c.dispose();
		}
		this.stdioConns.clear();
		this.httpConns.clear();
		this.tools.clear();
		this.statuses = [];
	}

	public dispose(): void {
		this.disconnectAll();
	}
}
