/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Aether IDE. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AGENT_TOOL_SCHEMAS } from './agentTools';
import { AetherLLMClient } from './llmClient';
import { ChatMessageParam, ParallelAgentTask } from './types';
import { WorkspaceIndex } from './workspaceIndex';

export class ParallelWorktreeManager {
	private tasks: ParallelAgentTask[] = [];
	private aborts = new Map<string, AbortController>();
	private readonly _onDidChange = new vscode.EventEmitter<ParallelAgentTask[]>();
	public readonly onDidChange = this._onDidChange.event;

	constructor(
		private readonly llm: AetherLLMClient,
		private readonly workspaceIndex: WorkspaceIndex
	) {}

	public getTasks(): ParallelAgentTask[] {
		return [...this.tasks];
	}

	public async spawnTask(prompt: string): Promise<ParallelAgentTask> {
		const root = this.workspaceIndex.getWorkspaceRoot();
		if (!root) {
			throw new Error('Open a Git repository workspace before spawning a parallel worktree agent.');
		}

		const slug = prompt
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '')
			.slice(0, 26) || 'task';
		const suffix = Date.now().toString(36).slice(-4);
		const branch = `aether/${slug}-${suffix}`;
		const worktreePath = path.join(root, '.aether', 'worktrees', `${slug}-${suffix}`);

		await fs.promises.mkdir(path.dirname(worktreePath), { recursive: true });
		await runGit(root, ['worktree', 'add', '-b', branch, worktreePath]);

		const task: ParallelAgentTask = {
			id: `wt_${Date.now()}_${suffix}`,
			prompt,
			branch,
			worktreePath,
			status: 'running',
			startedAt: Date.now(),
			summary: 'Starting autonomous agent in isolated git worktree...',
			changedFiles: [],
			log: [`Created git worktree ${worktreePath} on branch ${branch}`],
		};

		this.tasks.unshift(task);
		this._onDidChange.fire(this.getTasks());

		const abort = new AbortController();
		this.aborts.set(task.id, abort);
		void this.executeAgentInWorktree(task, abort.signal);

		return task;
	}

	public cancelTask(taskId: string): void {
		const abort = this.aborts.get(taskId);
		if (abort) {
			abort.abort();
			this.aborts.delete(taskId);
		}
	}

	public async openWorktree(taskId: string): Promise<void> {
		const task = this.tasks.find(t => t.id === taskId);
		if (!task) {
			return;
		}
		await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(task.worktreePath), { forceNewWindow: true });
	}

	public async mergeTask(taskId: string): Promise<void> {
		const task = this.tasks.find(t => t.id === taskId);
		const root = this.workspaceIndex.getWorkspaceRoot();
		if (!task || !root) {
			return;
		}
		// Commit any uncommitted changes inside the worktree first
		const status = await runGit(task.worktreePath, ['status', '--short']);
		if (status.trim()) {
			await runGit(task.worktreePath, ['add', '-A']);
			await runGit(task.worktreePath, ['commit', '-m', `feat(aether): ${task.prompt.slice(0, 60)}`]);
		}
		await runGit(root, ['merge', '--no-ff', task.branch, '-m', `Merge Aether Agent branch ${task.branch}`]);
		task.status = 'merged';
		task.log.push(`Merged branch ${task.branch} into current branch.`);
		await this.cleanupWorktree(root, task);
		this._onDidChange.fire(this.getTasks());
		vscode.window.showInformationMessage(`Merged parallel agent branch "${task.branch}".`);
	}

	public async discardTask(taskId: string): Promise<void> {
		const task = this.tasks.find(t => t.id === taskId);
		const root = this.workspaceIndex.getWorkspaceRoot();
		if (!task || !root) {
			return;
		}
		this.cancelTask(taskId);
		await this.cleanupWorktree(root, task);
		await runGit(root, ['branch', '-D', task.branch]).catch(() => undefined);
		task.status = 'discarded';
		task.log.push(`Discarded worktree & deleted branch ${task.branch}.`);
		this._onDidChange.fire(this.getTasks());
	}

	private async cleanupWorktree(root: string, task: ParallelAgentTask): Promise<void> {
		await runGit(root, ['worktree', 'remove', '--force', task.worktreePath]).catch(async () => {
			await fs.promises.rm(task.worktreePath, { recursive: true, force: true }).catch(() => undefined);
			await runGit(root, ['worktree', 'prune']).catch(() => undefined);
		});
	}

	private async executeAgentInWorktree(task: ParallelAgentTask, signal: AbortSignal): Promise<void> {
		try {
			const settings = await this.llm.getSettings();
			const messages: ChatMessageParam[] = [
				{
					role: 'system',
					content:
						`You are an autonomous background Aether Agent working inside an isolated Git worktree at ${task.worktreePath} (branch ${task.branch}). ` +
						`Read files, implement the requested task cleanly, and summarize your changes concisely.`,
				},
				{ role: 'user', content: task.prompt },
			];

			// Safe subset of workspace tools scoped strictly to task.worktreePath
			const worktreeTools = AGENT_TOOL_SCHEMAS.filter(t =>
				['read_file', 'write_file', 'edit_file', 'list_dir', 'search_files'].includes(t.function.name)
			);

			let lastSummary = '';
			const maxSteps = Math.min(settings.agentMaxSteps, 12);

			for (let step = 0; step < maxSteps; step++) {
				if (signal.aborted) {
					throw new Error('Cancelled by user');
				}
				const res = await this.llm.streamChat({
					messages,
					tools: worktreeTools,
					signal,
				});

				if (res.text.trim()) {
					lastSummary = res.text.trim();
				}
				if (res.toolCalls.length === 0) {
					break;
				}

				messages.push({
					role: 'assistant',
					content: res.text || null,
					tool_calls: res.toolCalls.map(tc => ({
						id: tc.id,
						type: 'function',
						function: { name: tc.name, arguments: tc.arguments },
					})),
				});

				for (const tc of res.toolCalls) {
					let args: Record<string, unknown> = {};
					try {
						args = tc.arguments ? JSON.parse(tc.arguments) : {};
					} catch {
						args = {};
					}
					const out = await this.runScopedTool(task, tc.name, args);
					task.log.push(`[${tc.name}] ${String(args.path ?? args.query ?? '')}`);
					this._onDidChange.fire(this.getTasks());
					messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.name, content: out.slice(0, 10_000) });
				}
			}

			const statusOut = await runGit(task.worktreePath, ['status', '--short']).catch(() => '');
			task.changedFiles = statusOut
				.split(/\r?\n/)
				.map(l => l.trim().replace(/^[A-Z?]+\s+/, ''))
				.filter(Boolean);
			task.summary = lastSummary.slice(0, 400) || `Completed with ${task.changedFiles.length} changed file(s).`;
			task.status = 'completed';
			task.finishedAt = Date.now();
		} catch (err) {
			task.status = 'failed';
			task.summary = err instanceof Error ? err.message : String(err);
			task.finishedAt = Date.now();
		} finally {
			this.aborts.delete(task.id);
			this._onDidChange.fire(this.getTasks());
		}
	}

	private async runScopedTool(task: ParallelAgentTask, name: string, args: Record<string, unknown>): Promise<string> {
		const resolveSafe = (rel: string) => {
			const rootAbs = path.resolve(task.worktreePath);
			const abs = path.resolve(rootAbs, rel || '.');
			const relToRoot = path.relative(rootAbs, abs);
			if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
				throw new Error('Path escapes worktree root');
			}
			try {
				const realRoot = fs.realpathSync(rootAbs);
				const probe = fs.existsSync(abs) ? abs : path.dirname(abs);
				if (fs.existsSync(probe)) {
					const realRel = path.relative(realRoot, fs.realpathSync(probe));
					if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
						throw new Error('Symlink escapes worktree root');
					}
				}
			} catch (err) {
				if (err instanceof Error && err.message.includes('escapes worktree root')) {
					throw err;
				}
			}
			const normalizedRel = relToRoot.replace(/\\/g, '/');
			if (normalizedRel && normalizedRel !== '.' && this.workspaceIndex.isPathIgnored(normalizedRel)) {
				throw new Error(`Access blocked by Caudate secret/ignore policy for "${normalizedRel}".`);
			}
			return abs;
		};
		try {
			if (name === 'list_dir') {
				const dir = resolveSafe(String(args.path ?? '.'));
				const entries = await fs.promises.readdir(dir, { withFileTypes: true });
				return entries.slice(0, 80).map(e => `${e.isDirectory() ? '[dir] ' : '[file] '}${e.name}`).join('\n');
			}
			if (name === 'read_file') {
				const abs = resolveSafe(String(args.path ?? ''));
				const lines = (await fs.promises.readFile(abs, 'utf8')).split(/\r?\n/);
				const s = Math.max(1, Number(args.start_line) || 1);
				const e = Math.min(lines.length, Number(args.end_line) || s + 200);
				return lines.slice(s - 1, e).map((l, i) => `${s + i}: ${l}`).join('\n');
			}
			if (name === 'write_file') {
				const abs = resolveSafe(String(args.path ?? ''));
				await fs.promises.mkdir(path.dirname(abs), { recursive: true });
				await fs.promises.writeFile(abs, String(args.content ?? ''), 'utf8');
				return `Wrote ${String(args.path)}`;
			}
			if (name === 'edit_file') {
				const abs = resolveSafe(String(args.path ?? ''));
				const before = await fs.promises.readFile(abs, 'utf8');
				const target = String(args.target ?? '');
				const replacement = String(args.replacement ?? '');
				if (!before.includes(target)) {
					return `Target not found in ${String(args.path)}`;
				}
				await fs.promises.writeFile(abs, before.replace(target, replacement), 'utf8');
				return `Edited ${String(args.path)}`;
			}
			if (name === 'search_files') {
				const query = String(args.query ?? '').toLowerCase();
				const out = await runGit(task.worktreePath, ['grep', '-n', '-i', '--', query]).catch(() => '');
				return out.slice(0, 5000) || `No matches for "${query}"`;
			}
			return `Unsupported tool in worktree: ${name}`;
		} catch (err) {
			return `Error: ${err instanceof Error ? err.message : String(err)}`;
		}
	}
}

function runGit(cwd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile('git', args, { cwd, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) {
				reject(new Error(stderr.trim() || err.message));
			} else {
				resolve(stdout);
			}
		});
	});
}
