/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Aether IDE. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AetherLLMClient } from './llmClient';
import { VectorIndexStatus } from './types';
import { WorkspaceIndex } from './workspaceIndex';

interface VectorChunk {
	id: string;
	relativePath: string;
	startLine: number;
	endLine: number;
	text: string;
	hash: string;
	embedding?: number[];
}

interface StoredVectorCache {
	version: number;
	embeddingModel: string;
	fileHashes: Record<string, string>;
	chunks: VectorChunk[];
}

export interface SemanticHit {
	relativePath: string;
	startLine: number;
	endLine: number;
	score: number;
	snippet: string;
	usedEmbeddings: boolean;
}

export class SemanticVectorIndex implements vscode.Disposable {
	private chunks: VectorChunk[] = [];
	private fileHashes: Record<string, string> = {};
	private usingEmbeddings = false;
	private activeEmbeddingModel = '';
	private isIndexing = false;
	private watcher: vscode.FileSystemWatcher | undefined;
	private pendingTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly _onDidUpdateStatus = new vscode.EventEmitter<VectorIndexStatus>();
	public readonly onDidUpdateStatus = this._onDidUpdateStatus.event;

	constructor(
		private readonly llm: AetherLLMClient,
		private readonly workspaceIndex: WorkspaceIndex
	) {
		this.setupWatcher();
	}

	public getStatus(): VectorIndexStatus {
		return {
			indexedFiles: Object.keys(this.fileHashes).length,
			indexedChunks: this.chunks.length,
			usingEmbeddings: this.usingEmbeddings,
			embeddingModel: this.activeEmbeddingModel,
			isIndexing: this.isIndexing,
		};
	}

	private setupWatcher(): void {
		if (!this.workspaceIndex.getWorkspaceRoot()) {
			return;
		}
		this.watcher = vscode.workspace.createFileSystemWatcher('**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,cs,cpp,c,h,md,json,css,html,vue,svelte}');
		const schedule = (uri: vscode.Uri) => {
			if (this.pendingTimer) {
				clearTimeout(this.pendingTimer);
			}
			this.pendingTimer = setTimeout(() => {
				void this.indexSingleFile(uri.fsPath);
			}, 1500);
		};
		this.watcher.onDidChange(schedule);
		this.watcher.onDidCreate(schedule);
		this.watcher.onDidDelete(uri => {
			const root = this.workspaceIndex.getWorkspaceRoot();
			if (!root) {
				return;
			}
			const rel = path.relative(root, uri.fsPath).replace(/\\/g, '/');
			delete this.fileHashes[rel];
			this.chunks = this.chunks.filter(c => c.relativePath !== rel);
			this._onDidUpdateStatus.fire(this.getStatus());
		});
	}

	public async loadCache(): Promise<void> {
		const cachePath = this.getCachePath();
		if (!cachePath) {
			return;
		}
		try {
			const raw = await fs.promises.readFile(cachePath, 'utf8');
			const parsed = JSON.parse(raw) as StoredVectorCache;
			if (parsed.version === 1 && Array.isArray(parsed.chunks)) {
				this.chunks = parsed.chunks;
				this.fileHashes = parsed.fileHashes ?? {};
				this.activeEmbeddingModel = parsed.embeddingModel ?? '';
				this.usingEmbeddings = this.chunks.some(c => Array.isArray(c.embedding) && c.embedding.length > 0);
				this._onDidUpdateStatus.fire(this.getStatus());
			}
		} catch {
			// No cache yet
		}
	}

	public async rebuildIndex(progress?: (msg: string) => void): Promise<VectorIndexStatus> {
		const root = this.workspaceIndex.getWorkspaceRoot();
		if (!root || this.isIndexing) {
			return this.getStatus();
		}

		this.isIndexing = true;
		this._onDidUpdateStatus.fire(this.getStatus());

		try {
			await this.loadCache();
			const settings = await this.llm.getSettings();
			const files = await this.workspaceIndex.listWorkspaceFiles(280);
			const model = settings.embeddingModel.trim();
			this.activeEmbeddingModel = model;

			let embeddingsAvailable = model.length > 0;
			if (embeddingsAvailable) {
				// Probe embedding endpoint once so we gracefully degrade to lexical chunks if unavailable
				const probe = await this.llm.embedText('healthcheck', model).catch(() => undefined);
				if (!probe || probe.length === 0) {
					embeddingsAvailable = false;
				}
			}

			this.usingEmbeddings = embeddingsAvailable;
			const nextChunks: VectorChunk[] = [];
			const nextHashes: Record<string, string> = {};
			const existingByPath = new Map<string, VectorChunk[]>();
			for (const c of this.chunks) {
				const arr = existingByPath.get(c.relativePath) ?? [];
				arr.push(c);
				existingByPath.set(c.relativePath, arr);
			}

			let processed = 0;
			for (const rel of files) {
				const full = path.join(root, rel);
				let content: string;
				try {
					const stat = await fs.promises.stat(full);
					if (stat.size > 140_000) {
						continue;
					}
					content = await fs.promises.readFile(full, 'utf8');
				} catch {
					continue;
				}

				const fileHash = sha1(content);
				nextHashes[rel] = fileHash;

				const prevChunks = existingByPath.get(rel);
				if (
					prevChunks &&
					this.fileHashes[rel] === fileHash &&
					(!embeddingsAvailable || prevChunks.every(c => Array.isArray(c.embedding) && c.embedding.length > 0))
				) {
					nextChunks.push(...prevChunks);
					continue;
				}

				const fileChunks = chunkSourceFile(rel, content);
				if (embeddingsAvailable) {
					for (const chunk of fileChunks) {
						const vec = await this.llm.embedText(`${rel}\n${chunk.text}`, model).catch(() => undefined);
						if (vec && vec.length > 0) {
							chunk.embedding = vec;
						}
					}
				}
				nextChunks.push(...fileChunks);
				processed++;
				if (processed % 25 === 0) {
					progress?.(`Indexed ${processed}/${files.length} files...`);
				}
			}

			this.chunks = nextChunks;
			this.fileHashes = nextHashes;
			await this.saveCache();
		} finally {
			this.isIndexing = false;
			this._onDidUpdateStatus.fire(this.getStatus());
		}

		return this.getStatus();
	}

	private async indexSingleFile(fsPath: string): Promise<void> {
		const root = this.workspaceIndex.getWorkspaceRoot();
		if (!root || this.isIndexing) {
			return;
		}
		const rel = path.relative(root, fsPath).replace(/\\/g, '/');
		if (rel.startsWith('..') || this.workspaceIndex.isPathIgnored(rel)) {
			return;
		}
		try {
			const stat = await fs.promises.stat(fsPath);
			if (!stat.isFile() || stat.size > 140_000) {
				return;
			}
			const content = await fs.promises.readFile(fsPath, 'utf8');
			const fileHash = sha1(content);
			if (this.fileHashes[rel] === fileHash) {
				return;
			}

			const fileChunks = chunkSourceFile(rel, content);
			if (this.usingEmbeddings && this.activeEmbeddingModel) {
				for (const chunk of fileChunks) {
					const vec = await this.llm.embedText(`${rel}\n${chunk.text}`, this.activeEmbeddingModel).catch(() => undefined);
					if (vec && vec.length > 0) {
						chunk.embedding = vec;
					}
				}
			}

			this.chunks = this.chunks.filter(c => c.relativePath !== rel);
			this.chunks.push(...fileChunks);
			this.fileHashes[rel] = fileHash;
			await this.saveCache();
			this._onDidUpdateStatus.fire(this.getStatus());
		} catch {
			// Ignore transient file watch error
		}
	}

	public async search(query: string, topK = 8): Promise<SemanticHit[]> {
		if (this.chunks.length === 0) {
			await this.loadCache();
		}
		if (this.chunks.length === 0) {
			// Fast lexical fallback via WorkspaceIndex
			const fallback = await this.workspaceIndex.searchCodebase(query, topK);
			return fallback.map(h => ({
				relativePath: h.relativePath,
				startLine: 1,
				endLine: 40,
				score: h.score,
				snippet: h.snippet,
				usedEmbeddings: false,
			}));
		}

		const queryTokens = query.toLowerCase().split(/[^a-z0-9_]+/).filter(t => t.length >= 2);
		let queryVec: number[] | undefined;
		if (this.usingEmbeddings && this.activeEmbeddingModel) {
			queryVec = await this.llm.embedText(query, this.activeEmbeddingModel).catch(() => undefined);
		}

		const scored: SemanticHit[] = [];
		for (const chunk of this.chunks) {
			let score = 0;
			let usedEmb = false;

			if (queryVec && chunk.embedding && chunk.embedding.length === queryVec.length) {
				score += cosineSimilarity(queryVec, chunk.embedding) * 10;
				usedEmb = true;
			}

			// Hybrid lexical boost for exact symbols/filenames
			const lowerPath = chunk.relativePath.toLowerCase();
			const lowerText = chunk.text.toLowerCase();
			for (const tok of queryTokens) {
				if (lowerPath.includes(tok)) {
					score += 2.2;
				}
				if (lowerText.includes(tok)) {
					score += 1.0;
				}
			}

			if (score > 0.2) {
				scored.push({
					relativePath: chunk.relativePath,
					startLine: chunk.startLine,
					endLine: chunk.endLine,
					score,
					snippet: chunk.text,
					usedEmbeddings: usedEmb,
				});
			}
		}

		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, topK);
	}

	private getCachePath(): string | undefined {
		const root = this.workspaceIndex.getWorkspaceRoot();
		if (!root) {
			return undefined;
		}
		return path.join(root, '.aether', 'cache', 'vector-index.json');
	}

	private async saveCache(): Promise<void> {
		const cachePath = this.getCachePath();
		if (!cachePath) {
			return;
		}
		try {
			await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
			const payload: StoredVectorCache = {
				version: 1,
				embeddingModel: this.activeEmbeddingModel,
				fileHashes: this.fileHashes,
				chunks: this.chunks,
			};
			await fs.promises.writeFile(cachePath, JSON.stringify(payload), 'utf8');
		} catch {
			// Best effort cache write
		}
	}

	public dispose(): void {
		if (this.pendingTimer) {
			clearTimeout(this.pendingTimer);
		}
		this.watcher?.dispose();
		this._onDidUpdateStatus.dispose();
	}
}

function chunkSourceFile(relativePath: string, content: string): VectorChunk[] {
	const lines = content.split(/\r?\n/);
	const CHUNK_LINES = 55;
	const OVERLAP = 10;
	const chunks: VectorChunk[] = [];
	for (let start = 0; start < lines.length; start += CHUNK_LINES - OVERLAP) {
		const end = Math.min(lines.length, start + CHUNK_LINES);
		const text = lines.slice(start, end).join('\n');
		if (text.trim().length > 0) {
			chunks.push({
				id: `${relativePath}:${start + 1}-${end}`,
				relativePath,
				startLine: start + 1,
				endLine: end,
				text,
				hash: sha1(text),
			});
		}
		if (end >= lines.length) {
			break;
		}
	}
	return chunks;
}

function sha1(text: string): string {
	return crypto.createHash('sha1').update(text).digest('hex');
}

function cosineSimilarity(a: number[], b: number[]): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return denom > 0 ? dot / denom : 0;
}
