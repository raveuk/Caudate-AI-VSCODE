# Security Policy — Caudate IDE

## Supported Versions

| Version | Supported |
| ------- | --------- |
| `1.x`   | Yes       |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

If you discover a security vulnerability in **Caudate IDE** or **Caudate AI**, please report it privately using GitHub Security Advisories:

- **Private Security Advisory:** https://github.com/raveuk/Caudate-AI-VSCODE/security/advisories/new

Please include:
1. A clear description of the vulnerability and affected component/file.
2. Steps to reproduce or a minimal proof of concept.
3. Suggested mitigation or impact assessment (if known).

## Security Design Principles

- **Zero Mandatory Telemetry / Cloud Sign-In:** Caudate IDE runs completely locally with Ollama or LM Studio by default; API keys for external providers are stored in the OS keychain via VS Code `SecretStorage`.
- **Workspace Trust & Secret Guardrails:** Workspace-defined MCP servers require VS Code Workspace Trust, file tools are confined to the open workspace root, `.caudateignore` / `.env` / private key patterns are blocked by default, and destructive shell commands require explicit user confirmation.
