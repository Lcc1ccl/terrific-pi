const SECRET_PATTERNS: RegExp[] = [
	/\b(?:api[_-]?key|token|secret|password|passwd|authorization|bearer)\b\s*[:=]\s*["']?[^\s"'\\]{8,}/gi,
	/\bsk-[A-Za-z0-9_-]{16,}\b/g,
	/\bghp_[A-Za-z0-9]{20,}\b/g,
	/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
	/\bAIza[0-9A-Za-z_-]{20,}\b/g,
	/(?:^|\n)\s*(?:export\s+)?[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\s*=\s*[^\n]+/gi,
];

/** Redact likely secrets and cap preview length. */
export function redactPreview(text: string, maxChars = 300): string {
	let out = text;
	for (const pattern of SECRET_PATTERNS) {
		out = out.replace(pattern, "[redacted]");
	}
	// Collapse long base64-looking blobs
	out = out.replace(/[A-Za-z0-9+/]{80,}={0,2}/g, "[base64 omitted]");
	if (out.length <= maxChars) return out;
	return `${out.slice(0, maxChars)}…`;
}
