/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Aether IDE. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { NotepadItem } from './types';

const NOTEPADS_KEY = 'aether.notepads.v1';

export interface ScopedRule {
	name: string;
	globs: string[];
	alwaysApply: boolean;
	content: string;
}

export interface SlashCommandDef {
	name: string;
	description: string;
	builtin: boolean;
	template?: string;
}

export const BUILTIN_SLASH_COMMANDS: readonly SlashCommandDef[] = [
	{ name: 'fix', description: 'Fix all diagnostics / compiler errors in active file', builtin: true },
	{ name: 'test', description: 'Generate and run tests for the active file or selection', builtin: true },
	{ name: 'review', description: 'AI Code Review & bug finder on current git diff', builtin: true },
	{ name: 'plan', description: 'Create an interactive Implementation Plan artifact', builtin: true },
	{ name: 'compact', description: 'Summarize chat history to free up context tokens', builtin: true },
	{ name: 'index', description: 'Rebuild semantic vector codebase index', builtin: true },
	{ name: 'worktree', description: 'Run task in an isolated parallel Git worktree agent', builtin: true },
];

export class RulesAndSkillsService {
	constructor(private readonly context: vscode.ExtensionContext) {}

	public getNotepads(): NotepadItem[] {
		return this.context.workspaceState.get<NotepadItem[]>(NOTEPADS_KEY, []);
	}

	public async saveNotepad(notepad: Partial<NotepadItem> & { title: string; content: string }): Promise<NotepadItem[]> {
		const list = [...this.getNotepads()];
		const now = Date.now();
		if (notepad.id) {
			const idx = list.findIndex(n => n.id === notepad.id);
			if (idx !== -1) {
				list[idx] = { ...list[idx], title: notepad.title.trim() || 'Untitled Note', content: notepad.content, updatedAt: now };
			} else {
				list.unshift({ id: notepad.id, title: notepad.title.trim() || 'Untitled Note', content: notepad.content, updatedAt: now });
			}
		} else {
			list.unshift({
				id: `np_${now}_${Math.random().toString(36).slice(2, 6)}`,
				title: notepad.title.trim() || 'Untitled Note',
				content: notepad.content,
				updatedAt: now,
			});
		}
		await this.context.workspaceState.update(NOTEPADS_KEY, list);
		return list;
	}

	public async deleteNotepad(id: string): Promise<NotepadItem[]> {
		const list = this.getNotepads().filter(n => n.id !== id);
		await this.context.workspaceState.update(NOTEPADS_KEY, list);
		return list;
	}

	public async loadScopedRules(workspaceRoot: string | undefined, activeFiles: string[]): Promise<string> {
		if (!workspaceRoot) {
			return '';
		}
		const sections: string[] = [];

		// 1. Root legacy/standard rule files
		for (const name of ['.caudaterules', '.aetherrules', '.cursorrules', 'AGENTS.md', 'CLAUDE.md']) {
			const full = path.join(workspaceRoot, name);
			try {
				const stat = await fs.promises.stat(full);
				if (stat.isFile() && stat.size < 64_000) {
					const content = await fs.promises.readFile(full, 'utf8');
					sections.push(`### Workspace Rules (${name})\n${content.trim()}`);
				}
			} catch {
				// Not present
			}
		}

		// 2. Glob-scoped .caudate/rules/*.md, .aether/rules/*.md and .cursor/rules/*.mdc
		for (const rulesDir of [path.join(workspaceRoot, '.caudate', 'rules'), path.join(workspaceRoot, '.aether', 'rules'), path.join(workspaceRoot, '.cursor', 'rules')]) {
			try {
				const entries = await fs.promises.readdir(rulesDir, { withFileTypes: true });
				for (const entry of entries) {
					if (!entry.isFile() || !/\.(md|mdc)$/i.test(entry.name)) {
						continue;
					}
					const raw = await fs.promises.readFile(path.join(rulesDir, entry.name), 'utf8');
					const parsed = parseScopedRule(entry.name, raw);
					const matched = parsed.alwaysApply || parsed.globs.length === 0 || activeFiles.some(f => matchesAnyGlob(f, parsed.globs));
					if (matched && parsed.content.trim()) {
						sections.push(`### Scoped Rule (${parsed.name})\n${parsed.content.trim()}`);
					}
				}
			} catch {
				// Directory not present
			}
		}

		// 3. Skills (.aether/skills/*/SKILL.md)
		const skillsDir = path.join(workspaceRoot, '.aether', 'skills');
		try {
			const skillFolders = await fs.promises.readdir(skillsDir, { withFileTypes: true });
			const skillSummaries: string[] = [];
			for (const folder of skillFolders) {
				if (!folder.isDirectory()) {
					continue;
				}
				const skillFile = path.join(skillsDir, folder.name, 'SKILL.md');
				try {
					const raw = await fs.promises.readFile(skillFile, 'utf8');
					const firstLines = raw.split(/\r?\n/).slice(0, 12).join('\n');
					skillSummaries.push(`- **${folder.name}** (.aether/skills/${folder.name}/SKILL.md): ${firstLines.replace(/\s+/g, ' ').slice(0, 180)}`);
				} catch {
					// No SKILL.md
				}
			}
			if (skillSummaries.length > 0) {
				sections.push(`### Available Workspace Skills (read_file to load full instructions)\n${skillSummaries.join('\n')}`);
			}
		} catch {
			// No skills folder
		}

		return sections.join('\n\n');
	}

	public async listSlashCommands(workspaceRoot: string | undefined): Promise<SlashCommandDef[]> {
		const commands: SlashCommandDef[] = [...BUILTIN_SLASH_COMMANDS];
		if (!workspaceRoot) {
			return commands;
		}
		const cmdDir = path.join(workspaceRoot, '.aether', 'commands');
		try {
			const entries = await fs.promises.readdir(cmdDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isFile() || !entry.name.endsWith('.md')) {
					continue;
				}
				const name = entry.name.replace(/\.md$/i, '');
				const raw = await fs.promises.readFile(path.join(cmdDir, entry.name), 'utf8');
				const firstLine = raw.split(/\r?\n/).find(l => l.trim().length > 0)?.replace(/^#+\s*/, '') ?? `Custom workflow: ${name}`;
				commands.push({
					name,
					description: firstLine.slice(0, 100),
					builtin: false,
					template: raw.trim(),
				});
			}
		} catch {
			// No custom commands dir
		}
		return commands;
	}
}

function parseScopedRule(name: string, raw: string): ScopedRule {
	const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
	if (!fmMatch) {
		return { name, globs: [], alwaysApply: true, content: raw };
	}
	const fm = fmMatch[1];
	const body = fmMatch[2];
	const alwaysApply = /alwaysApply\s*:\s*true/i.test(fm);
	const globs: string[] = [];
	const globsMatch = /globs\s*:\s*(.+)/i.exec(fm);
	if (globsMatch) {
		const rawVal = globsMatch[1].trim().replace(/^\[|\]$/g, '');
		for (const part of rawVal.split(',')) {
			const clean = part.trim().replace(/^["']|["']$/g, '');
			if (clean) {
				globs.push(clean);
			}
		}
	}
	return { name, globs, alwaysApply, content: body };
}

function matchesAnyGlob(filePath: string, globs: string[]): boolean {
	const norm = filePath.replace(/\\/g, '/');
	for (const glob of globs) {
		const rxStr = glob
			.replace(/\\/g, '/')
			.replace(/[.+^${}()|[\]\\]/g, '\\$&')
			.replace(/\*\*/g, '@@DS@@')
			.replace(/\*/g, '[^/]*')
			.replace(/@@DS@@/g, '.*');
		const rx = new RegExp(`(^|/)${rxStr}$`, 'i');
		if (rx.test(norm)) {
			return true;
		}
	}
	return false;
}
