/** Minimal frontmatter parser compatible with pi-subagents list fields. */

export function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
	const frontmatter: Record<string, string> = {};
	const normalized = content.replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---")) return { frontmatter, body: normalized };

	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) return { frontmatter, body: normalized };

	const block = normalized.slice(4, endIndex);
	const body = normalized.slice(endIndex + 4).replace(/^\n/, "");
	let currentKey: string | null = null;
	let currentLines: string[] | null = null;
	let currentIndent: number | null = null;

	const flush = () => {
		if (!currentKey || currentLines === null) return;
		frontmatter[currentKey] = currentLines.join("\n").replace(/^\n/, "").replace(/\n+$/, "");
		currentKey = null;
		currentLines = null;
		currentIndent = null;
	};

	for (const line of block.split("\n")) {
		const indent = line.search(/\S|$/);
		const trimmed = line.trim();
		if (currentKey && currentLines && (indent > (currentIndent ?? 0) || trimmed === "")) {
			currentLines.push(line);
			continue;
		}
		flush();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const match = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!match) continue;
		const key = match[1]!;
		const value = match[2] ?? "";
		if (value === "" || value === "|" || value === ">") {
			currentKey = key;
			currentLines = [];
			currentIndent = indent;
			continue;
		}
		frontmatter[key] = value;
	}
	flush();
	return { frontmatter, body };
}

export function parseFrontmatterList(raw: string | undefined): string[] {
	if (raw === undefined) return [];
	return raw
		.split("\n")
		.flatMap((line) => {
			const value = line.trim();
			const listItem = value.match(/^-\s+(.+)$/);
			return (listItem?.[1] ?? value).split(",");
		})
		.map((value) => value.trim())
		.filter(Boolean);
}
