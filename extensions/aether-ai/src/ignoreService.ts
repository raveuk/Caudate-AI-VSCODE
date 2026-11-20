/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Aether IDE. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { AetherSettings } from './types';

const DEFAULT_SECRET_PATTERNS: readonly RegExp[] = [
	/(^|\/)\.env($|\.)/i,
	/\.pem$/i,
	/\.key$/i,
	/\.p12$/i,
	/\.pfx$/i,
	/(^|\/)id_rsa(\.pub)?$/i,
	/(^|\/)id_ed25519(\.pub)?$/i,
	/(^|\/)credentials\.json$/i,
	/(^|\/)secrets?\.(json|ya?ml|toml|env)$/i,
	/(^|\/)\.npmrc$/i,
	/(^|\/)\.pypirc$/i,
];

const DEFAULT_DANGEROUS_COMMANDS: readonly RegExp[] = [
	/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--force)\b/i,
	/\bremove-item\b.*(-recurse|-force)/i,
	/\bdel\s+\/[sqf]/i,
	/\brdd?\s+\/s/i,
	/\bgit\s+push\s+.*(--force|-f)\b/i,
	/\bgit\s+reset\s+--hard\b/i,
	/\bgit\s+clean\s+-[a-z]*f/i,
	/\bformat\s+[a-z]:/i,
	/\bshutdown\b/i,
	/\bdrop\s+(database|table)\b/i,
];

export type CommandDecision = 'allow' | 'ask' | 'deny';

export class IgnoreAndSecurityService {
	private cachedRoot: string | undefined;
	private cachedPatterns: RegExp[] = [];
	private lastLoadedAt = 0;

	public isIgnored(relPath: string, workspaceRoot?: string, respectIgnoreFiles = true): boolean {
		const normalized = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
		if (!respectIgnoreFiles) {
			return false;
		}
		for (const rx of DEFAULT_SECRET_PATTERNS) {
			if (rx.test(normalized)) {
				return true;
			}
		}
		if (workspaceRoot) {
			this.ensureLoaded(workspaceRoot);
			for (const rx of this.cachedPatterns) {
				if (rx.test(normalized)) {
					return true;
				}
			}
		}
		return false;
	}

	public assertAllowedPath(relPath: string, workspaceRoot?: string, respectIgnoreFiles = true): void {
		if (this.isIgnored(relPath, workspaceRoot, respectIgnoreFiles)) {
			throw new Error(
				`Access blocked by Caudate secret/ignore policy for "${relPath}". ` +
				`Files matching .caudateignore, .aetherignore, .cursorignore, or secret patterns (.env, *.key, *.pem) are protected.`
			);
		}
	}

	public evaluateCommand(command: string, settings: AetherSettings): { decision: CommandDecision; reason: string } {
		const trimmed = command.trim();
		if (!trimmed) {
			return { decision: 'deny', reason: 'Empty command' };
		}

		// Check user denylist first
		for (const entry of settings.commandDenylist) {
			const clean = entry.trim();
			if (!clean) {
				continue;
			}
			if (trimmed.toLowerCase().includes(clean.toLowerCase())) {
				return { decision: 'deny', reason: `Matches command denylist pattern "${clean}"` };
			}
		}

		// Built-in dangerous patterns always require explicit approval (even if autoApproveTerminal is true)
		for (const rx of DEFAULT_DANGEROUS_COMMANDS) {
			if (rx.test(trimmed)) {
				return { decision: 'ask', reason: 'Potentially destructive command requires explicit approval' };
			}
		}

		if (settings.autoApproveTerminal) {
			return { decision: 'allow', reason: 'Auto-approve terminal enabled' };
		}

		// Never auto-approve via prefix allowlist if command chains/pipes/substitutes/redirects shell commands
		const hasShellChaining = /(?:&&|\|\||[;|`<>]|\$\(|\r|\n)/.test(trimmed);
		if (!hasShellChaining) {
			const lowerCmd = trimmed.toLowerCase();
			for (const entry of settings.commandAllowlist) {
				const clean = entry.trim();
				if (!clean) {
					continue;
				}
				const lowerPrefix = clean.toLowerCase();
				if (lowerCmd === lowerPrefix || (lowerCmd.startsWith(lowerPrefix) && /\s/.test(trimmed[clean.length]))) {
					return { decision: 'allow', reason: `Allowed by command allowlist "${clean}"` };
				}
			}
		}

		return { decision: 'ask', reason: 'Requires user approval' };
	}

	public invalidate(): void {
		this.lastLoadedAt = 0;
	}

	private ensureLoaded(workspaceRoot: string): void {
		const now = Date.now();
		if (this.cachedRoot === workspaceRoot && now - this.lastLoadedAt < 5000) {
			return;
		}
		this.cachedRoot = workspaceRoot;
		this.lastLoadedAt = now;
		this.cachedPatterns = [];

		for (const fileName of ['.caudateignore', '.aetherignore', '.cursorignore']) {
			const full = path.join(workspaceRoot, fileName);
			try {
				if (!fs.existsSync(full)) {
					continue;
				}
				const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
				for (const raw of lines) {
					const line = raw.trim();
					if (!line || line.startsWith('#') || line.startsWith('!')) {
						continue;
					}
					this.cachedPatterns.push(globToRegex(line));
				}
			} catch {
				// Ignore read error
			}
		}
	}
}

function globToRegex(glob: string): RegExp {
	let g = glob.replace(/\\/g, '/').replace(/^\/+/, '');
	const dirOnly = g.endsWith('/');
	if (dirOnly) {
		g = g.slice(0, -1);
	}
	const escaped = g
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replace(/\*\*/g, '@@DOUBLE_STAR@@')
		.replace(/\*/g, '[^/]*')
		.replace(/\?/g, '[^/]')
		.replace(/@@DOUBLE_STAR@@/g, '.*');
	const prefix = g.includes('/') ? '^' : '(^|/)';
	const suffix = dirOnly ? '(/|$)' : '(/|$)';
	return new RegExp(`${prefix}${escaped}${suffix}`, 'i');
}
