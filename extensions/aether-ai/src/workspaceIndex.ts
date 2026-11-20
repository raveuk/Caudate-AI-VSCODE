/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Aether IDE. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { IgnoreAndSecurityService } from './ignoreService';

const IGNORED_DIRS = new Set([
	'.git',
	'.aether',
	'node_modules',
	'out',
	'dist',
	'build',
	'.build',
	'.next',
	'.nuxt',
	'.cache',
	'.venv',
	'venv',
	'__pycache__',
	'target',
	'bin',
	'obj',
	'.turbo',
	'coverage',
]);

const BINARY_EXTENSIONS = new Set([
	'.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.svgz',
	'.woff', '.woff2', '.ttf', '.eot', '.otf',
	'.zip', '.tar', '.gz', '.7z', '.rar',
	'.pdf', '.exe', '.dll', '.so', '.dylib', '.node', '.wasm',
	'.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv',
	'.sqlite', '.db', '.lockb',
]);

export interface CodebaseSearchHit {
	relativePath: string;
	score: number;
	snippet: string;
}

export class WorkspaceIndex {
	private recentTerminalLogs: string[] = [];

	constructor(private readonly ignoreService: IgnoreAndSecurityService) {}

	public getWorkspaceRoot(): string | undefined {
		return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	}

	public isPathIgnored(relPath: string): boolean {
		const respect = vscode.workspace.getConfiguration('aether').get<boolean>('privacy.respectIgnoreFiles', true);
		return this.ignoreService.isIgnored(relPath, this.getWorkspaceRoot(), respect);
	}

	public recordTerminalOutput(command: string, output: string): void {
		this.recentTerminalLogs.unshift(`$ ${command}\n${output.slice(0, 2000)}`);
		if (this.recentTerminalLogs.length > 8) {
			this.recentTerminalLogs.length = 8;
		}
	}

	public collectTerminalContext(): string {
		const active = vscode.window.activeTerminal;
		const parts: string[] = [];
		if (active) {
			parts.push(`Active Integrated Terminal: ${active.name}`);
		}
		if (this.recentTerminalLogs.length > 0) {
			parts.push(`Recent Command Outputs:\n${this.recentTerminalLogs.slice(0, 4).join('\n---\n')}`);
		} else {
			parts.push('No recent agent terminal command output recorded yet.');
		}
		return parts.join('\n\n');
	}

	public async collectWorkspaceSymbols(query: string): Promise<string> {
		const q = query.trim().slice(0, 60);
		const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', q) ?? [];
		const root = this.getWorkspaceRoot();
		if (symbols.length === 0) {
			return 'No matching workspace symbols found.';
		}
		return symbols.slice(0, 40).map(s => {
			const rel = root ? path.relative(root, s.location.uri.fsPath).replace(/\\/g, '/') : s.location.uri.fsPath;
			const line = s.location.range.start.line + 1;
			return `${s.name} (${vscode.SymbolKind[s.kind]}) — ${rel}:${line}`;
		}).join('\n');
	}

	public async searchWeb(query: string): Promise<string> {
		const q = query.trim();
		if (!q) {
			return 'Empty web search query.';
		}
		try {
			const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
			const res = await fetch(url, {
				headers: { 'User-Agent': 'CaudateIDE/1.0' },
			});
			if (!res.ok) {
				return `Web search returned HTTP ${res.status}.`;
			}
			const html = (await res.text()).slice(0, 200_000);
			const results = extractDuckDuckGoResults(html, 6);
			return results.length > 0 ? results.join('\n\n') : `No web results parsed for "${q}".`;
		} catch (err) {
			return `Web search failed: ${err instanceof Error ? err.message : String(err)}`;
		}
	}

	public async fetchAndCacheDoc(url: string): Promise<string> {
		const cleanedUrl = assertSafeHttpUrl(url);
		const root = this.getWorkspaceRoot();
		const cacheFile = root
			? path.join(root, '.aether', 'docs', `${crypto.createHash('sha256').update(cleanedUrl).digest('hex').slice(0, 16)}.txt`)
			: undefined;

		if (cacheFile && fs.existsSync(cacheFile)) {
			const cached = await fs.promises.readFile(cacheFile, 'utf8');
			return cached.slice(0, 12_000);
		}

		const res = await fetch(cleanedUrl, { headers: { 'User-Agent': 'CaudateIDE/1.0' } });
		if (!res.ok) {
			throw new Error(`Failed to fetch docs (${res.status}): ${cleanedUrl}`);
		}
		const html = (await res.text()).slice(0, 500_000);
		const text = extractPlainTextFromHtml(html);
		const header = `Documentation URL: ${cleanedUrl}\n\n${text}`;
		if (cacheFile) {
			await fs.promises.mkdir(path.dirname(cacheFile), { recursive: true });
			await fs.promises.writeFile(cacheFile, header.slice(0, 40_000), 'utf8');
		}
		return header.slice(0, 12_000);
	}

	public resolvePath(inputPath: string): { absolutePath: string; relativePath: string } {
		const root = this.getWorkspaceRoot();
		if (!root) {
			throw new Error('No workspace folder is currently open.');
		}
		const normalized = inputPath.trim().replace(/^@/, '');
		if (!normalized) {
			throw new Error('Path must not be empty.');
		}
		const resolvedRoot = path.resolve(root);
		const absolutePath = path.isAbsolute(normalized)
			? path.resolve(normalized)
			: path.resolve(resolvedRoot, normalized);

		const relCheck = path.relative(resolvedRoot, absolutePath);
		if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
			throw new Error(`Access denied: path "${inputPath}" escapes the open workspace root.`);
		}

		// Prevent symlink escapes out of the workspace root
		try {
			const realRoot = fs.realpathSync(resolvedRoot);
			const probe = fs.existsSync(absolutePath) ? absolutePath : path.dirname(absolutePath);
			if (fs.existsSync(probe)) {
				const realProbe = fs.realpathSync(probe);
				const realRel = path.relative(realRoot, realProbe);
				if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
					throw new Error(`Access denied: symlink target for "${inputPath}" escapes the workspace root.`);
				}
			}
		} catch (err) {
			if (err instanceof Error && err.message.startsWith('Access denied:')) {
				throw err;
			}
		}

		const relativePath = relCheck.replace(/\\/g, '/');
		return { absolutePath, relativePath };
	}

	public async listWorkspaceFiles(maxFiles = 400): Promise<string[]> {
		const root = this.getWorkspaceRoot();
		if (!root) {
			return [];
		}
		const results: string[] = [];
		const walk = async (dir: string) => {
			if (results.length >= maxFiles) {
				return;
			}
			let entries: fs.Dirent[];
			try {
				entries = await fs.promises.readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			entries.sort((a, b) => a.name.localeCompare(b.name));
			for (const entry of entries) {
				if (results.length >= maxFiles) {
					return;
				}
				const full = path.join(dir, entry.name);
				const rel = path.relative(root, full).replace(/\\/g, '/');
				if (this.isPathIgnored(rel)) {
					continue;
				}
				if (entry.isDirectory()) {
					if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.vscode-test')) {
						continue;
					}
					await walk(full);
				} else if (entry.isFile()) {
					const ext = path.extname(entry.name).toLowerCase();
					if (BINARY_EXTENSIONS.has(ext)) {
						continue;
					}
					results.push(rel);
				}
			}
		};
		await walk(root);
		return results;
	}

	public async listWorkspaceFolders(maxFolders = 120): Promise<string[]> {
		const root = this.getWorkspaceRoot();
		if (!root) {
			return [];
		}
		const results: string[] = [];
		const walk = async (dir: string, depth: number) => {
			if (results.length >= maxFolders || depth > 4) {
				return;
			}
			let entries: fs.Dirent[];
			try {
				entries = await fs.promises.readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name)) {
					continue;
				}
				const full = path.join(dir, entry.name);
				const rel = path.relative(root, full).replace(/\\/g, '/');
				if (this.isPathIgnored(rel)) {
					continue;
				}
				results.push(rel);
				await walk(full, depth + 1);
			}
		};
		await walk(root, 0);
		return results.sort();
	}

	public collectDiagnostics(targetRelPath?: string): string {
		const allDiagnostics = vscode.languages.getDiagnostics();
		const root = this.getWorkspaceRoot();
		const lines: string[] = [];

		for (const [uri, diags] of allDiagnostics) {
			if (!diags.length) {
				continue;
			}
			const rel = root ? path.relative(root, uri.fsPath).replace(/\\/g, '/') : uri.fsPath;
			if (targetRelPath && rel !== targetRelPath && !rel.endsWith(targetRelPath)) {
				continue;
			}
			for (const d of diags) {
				const sev = d.severity === vscode.DiagnosticSeverity.Error
					? 'ERROR'
					: d.severity === vscode.DiagnosticSeverity.Warning
						? 'WARN'
						: 'INFO';
				lines.push(`${rel}:${d.range.start.line + 1}:${d.range.start.character + 1} [${sev}] ${d.message}${d.source ? ` (${d.source})` : ''}`);
				if (lines.length >= 80) {
					break;
				}
			}
			if (lines.length >= 80) {
				break;
			}
		}

		return lines.length > 0 ? lines.join('\n') : 'No diagnostics / problems found.';
	}

	public async searchCodebase(query: string, topK = 6): Promise<CodebaseSearchHit[]> {
		const root = this.getWorkspaceRoot();
		if (!root) {
			return [];
		}
		const tokens = query
			.toLowerCase()
			.split(/[^a-z0-9_]+/)
			.filter(t => t.length >= 2);
		if (tokens.length === 0) {
			return [];
		}

		const files = await this.listWorkspaceFiles(350);
		const hits: CodebaseSearchHit[] = [];

		for (const rel of files) {
			const full = path.join(root, rel);
			let stat: fs.Stats;
			try {
				stat = await fs.promises.stat(full);
			} catch {
				continue;
			}
			if (stat.size > 160_000) {
				continue;
			}

			let content: string;
			try {
				content = await fs.promises.readFile(full, 'utf8');
			} catch {
				continue;
			}

			const lowerPath = rel.toLowerCase();
			const lowerContent = content.toLowerCase();
			let score = 0;

			for (const tok of tokens) {
				if (lowerPath.includes(tok)) {
					score += 6;
				}
				let idx = lowerContent.indexOf(tok);
				let count = 0;
				while (idx !== -1 && count < 10) {
					count++;
					idx = lowerContent.indexOf(tok, idx + tok.length);
				}
				score += count * 1.5;
			}

			if (score > 0) {
				const snippet = extractBestSnippet(content, tokens);
				hits.push({ relativePath: rel, score, snippet });
			}
		}

		hits.sort((a, b) => b.score - a.score);
		return hits.slice(0, topK);
	}

	public async buildFolderSummary(relFolder: string): Promise<string> {
		const { absolutePath, relativePath } = this.resolvePath(relFolder);
		const entries = await fs.promises.readdir(absolutePath, { withFileTypes: true });
		const lines = entries
			.filter(e => !IGNORED_DIRS.has(e.name))
			.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
			.slice(0, 80)
			.map(e => `${e.isDirectory() ? '[dir]  ' : '[file] '}${e.name}`);
		return `Folder: ${relativePath || '.'}\n${lines.join('\n')}`;
	}
}

function extractBestSnippet(content: string, tokens: string[]): string {
	const lines = content.split(/\r?\n/);
	let bestLine = 0;
	let bestScore = -1;
	for (let i = 0; i < lines.length; i++) {
		const lower = lines[i].toLowerCase();
		let s = 0;
		for (const tok of tokens) {
			if (lower.includes(tok)) {
				s++;
			}
		}
		if (s > bestScore) {
			bestScore = s;
			bestLine = i;
		}
	}
	const start = Math.max(0, bestLine - 6);
	const end = Math.min(lines.length, bestLine + 18);
	return lines
		.slice(start, end)
		.map((l, idx) => `${start + idx + 1}: ${l}`)
		.join('\n');
}

function assertSafeHttpUrl(rawUrl: string): string {
	const trimmed = rawUrl.trim();
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error(`Invalid documentation URL: "${trimmed}"`);
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new Error(`Unsupported URL protocol "${parsed.protocol}". Only http: and https: are allowed.`);
	}
	const host = parsed.hostname.toLowerCase();
	if (
		host === '169.254.169.254' ||
		host === '169.254.170.2' ||
		host.startsWith('169.254.') ||
		host === 'metadata.google.internal' ||
		host === 'metadata.goog'
	) {
		throw new Error(`Blocked cloud metadata host "${host}" for security.`);
	}
	return parsed.toString();
}

function extractDuckDuckGoResults(html: string, maxResults: number): string[] {
	const results: string[] = [];
	let cursor = 0;
	const marker = 'class="result__a"';
	while (results.length < maxResults) {
		const clsIdx = html.indexOf(marker, cursor);
		if (clsIdx === -1) {
			break;
		}
		const tagStart = html.lastIndexOf('<a', clsIdx);
		const tagEnd = html.indexOf('>', clsIdx);
		const closeA = tagEnd !== -1 ? html.indexOf('</a>', tagEnd) : -1;
		if (tagStart === -1 || tagEnd === -1 || closeA === -1) {
			cursor = clsIdx + marker.length;
			continue;
		}
		const openTag = html.slice(tagStart, tagEnd);
		const hrefIdx = openTag.indexOf('href="');
		let href = '';
		if (hrefIdx !== -1) {
			const hrefEnd = openTag.indexOf('"', hrefIdx + 6);
			if (hrefEnd !== -1) {
				href = decodeEntities(openTag.slice(hrefIdx + 6, hrefEnd));
			}
		}
		const title = extractPlainTextFromHtml(html.slice(tagEnd + 1, closeA));

		let snippet = '';
		const snipMarker = 'class="result__snippet"';
		const snipIdx = html.indexOf(snipMarker, closeA);
		const nextResultIdx = html.indexOf(marker, closeA);
		if (snipIdx !== -1 && (nextResultIdx === -1 || snipIdx < nextResultIdx)) {
			const snipTagEnd = html.indexOf('>', snipIdx);
			const snipClose = snipTagEnd !== -1 ? html.indexOf('</a>', snipTagEnd) : -1;
			if (snipTagEnd !== -1 && snipClose !== -1) {
				snippet = extractPlainTextFromHtml(html.slice(snipTagEnd + 1, snipClose));
			}
		}

		if (title && href) {
			results.push(`- **${title}** (${href})\n  ${snippet}`);
		}
		cursor = closeA + 4;
	}
	return results;
}

/**
 * Linear O(n) character-state HTML-to-plain-text extractor (no nested regexes, no ReDoS).
 */
function extractPlainTextFromHtml(html: string): string {
	const out: string[] = [];
	let i = 0;
	const len = html.length;
	const lower = html.toLowerCase();

	while (i < len) {
		const ch = html[i];
		if (ch === '<') {
			if (lower.startsWith('<script', i)) {
				const end = lower.indexOf('</script', i + 7);
				if (end === -1) {
					break;
				}
				const gt = html.indexOf('>', end + 8);
				i = gt === -1 ? len : gt + 1;
				out.push(' ');
				continue;
			}
			if (lower.startsWith('<style', i)) {
				const end = lower.indexOf('</style', i + 6);
				if (end === -1) {
					break;
				}
				const gt = html.indexOf('>', end + 7);
				i = gt === -1 ? len : gt + 1;
				out.push(' ');
				continue;
			}
			const gt = html.indexOf('>', i + 1);
			if (gt === -1) {
				break;
			}
			i = gt + 1;
			out.push(' ');
			continue;
		}
		out.push(ch);
		i++;
	}

	return decodeEntities(out.join('')).replace(/\s+/g, ' ').trim();
}

const ENTITY_MAP: Record<string, string> = {
	'&lt;': '<',
	'&gt;': '>',
	'&quot;': '"',
	'&#39;': "'",
	'&nbsp;': ' ',
	'&amp;': '&',
};

function decodeEntities(s: string): string {
	// Single-pass entity decoding prevents double-unescaping (e.g. &amp;lt; -> &lt;)
	return s.replace(/&(?:lt|gt|quot|#39|nbsp|amp);/g, m => ENTITY_MAP[m] ?? m);
}
