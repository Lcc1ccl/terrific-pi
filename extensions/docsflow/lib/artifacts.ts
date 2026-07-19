import { realpathSync } from "node:fs";
import path from "node:path";

export class ArtifactPathError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ArtifactPathError";
	}
}

/** Artifact paths are relative to the project's docsflow/ folder in the vault. */
export function assertRelativeArtifactPath(candidate: string): string {
	const value = candidate.trim().replaceAll("\\", "/");
	if (!value) throw new ArtifactPathError("Artifact path is empty");
	if (path.isAbsolute(value) || /^[A-Za-z]:\//.test(value)) {
		throw new ArtifactPathError("Absolute artifact paths are not allowed");
	}
	if (value.includes("\0")) throw new ArtifactPathError("Artifact path contains NUL");
	const normalized = path.posix.normalize(value).replace(/^\.\//, "");
	if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../") || normalized === "..") {
		throw new ArtifactPathError("Artifact path must not contain parent traversal");
	}
	if (normalized.startsWith(".pi/") || normalized.includes("/.git/")) {
		throw new ArtifactPathError("Artifact path targets a forbidden area");
	}
	return normalized;
}

export function assertAllowlisted(candidate: string, allowlist: readonly string[]): string {
	const normalized = assertRelativeArtifactPath(candidate);
	const allowed = new Set(allowlist.map((item) => assertRelativeArtifactPath(item)));
	if (!allowed.has(normalized)) throw new ArtifactPathError(`Artifact path is not allowlisted: ${normalized}`);
	return normalized;
}

export function resolveDraftPath(targetPath: string, formalExists: boolean): string {
	const normalized = assertRelativeArtifactPath(targetPath);
	if (!formalExists) return normalized;
	if (normalized.endsWith(".draft.md")) return normalized;
	if (normalized.endsWith(".md")) return `${normalized.slice(0, -3)}.draft.md`;
	return `${normalized}.draft.md`;
}

export function resolveInsideOutputRoot(outputRoot: string, relativePath: string): string {
	const normalized = assertRelativeArtifactPath(relativePath);
	const root = path.resolve(outputRoot);
	const target = path.resolve(root, normalized);
	const realRoot = safeRealpath(root) ?? root;
	const existing = safeRealpath(target);
	const candidate = existing ?? path.join(safeRealpath(path.dirname(target)) ?? path.dirname(target), path.basename(target));
	const rel = path.relative(realRoot, candidate);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new ArtifactPathError("Resolved artifact path escapes docsflow output root");
	}
	return existing ?? target;
}

function safeRealpath(value: string): string | undefined {
	try {
		return realpathSync(value);
	} catch {
		return undefined;
	}
}
