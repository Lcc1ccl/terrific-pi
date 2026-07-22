#!/usr/bin/env python3
"""Fetch provider /models and merge into pi models.json with official enrichment."""

from __future__ import annotations

import argparse
import json
import math
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

DEFAULT_MODELS_JSON = Path.home() / ".pi" / "agent" / "models.json"
DEFAULT_AUTH_JSON = Path.home() / ".pi" / "agent" / "auth.json"
DEFAULT_MODELS_STORE = Path.home() / ".pi" / "agent" / "models-store.json"
# Fallback only when no store/family match; prefer real windows over inflated 500k.
DEFAULT_CONTEXT = 256000

# Hardcoded fallbacks used only when pi-ai catalog files are not found.
KNOWN_CONTEXT: dict[str, int] = {
    "grok-4.3": 1_000_000,
    "grok-4.5": 500_000,
    "grok-build-0.1": 256_000,
}
KNOWN_MAX_TOKENS: dict[str, int] = {
    "grok-4.3": 30_000,
    "grok-4.5": 500_000,
    "grok-build-0.1": 256_000,
}
KNOWN_INPUT: dict[str, list[str]] = {
    "grok-4.3": ["text", "image"],
    "grok-4.5": ["text", "image"],
    "grok-build-0.1": ["text", "image"],
}
KNOWN_THINKING_LEVEL_MAP: dict[str, dict[str, Any]] = {
    "grok-4.5": {"off": None, "minimal": None},
}
# Explicit alias → official catalog id for cost/context enrichment.
KNOWN_ID_ALIASES: dict[str, str] = {
    "grok-4.5-latest": "grok-4.5",
    "grok-build": "grok-build-0.1",
    "grok-build-latest": "grok-build-0.1",
}

THINKING_LEVEL_MAP = {
    "off": None,
    "minimal": None,
    "low": "low",
    "medium": "medium",
    "high": "high",
    "xhigh": None,
    "max": None,
}

PI_AI_CATALOG_PROVIDERS = (
    "xai",
    "anthropic",
    "openai",
    "openai-codex",
    "google",
)
CATALOG_PROVIDER_ALIASES = {
    "grok": "xai",
    "x-ai": "xai",
    "claude": "anthropic",
    "gemini": "google",
}
ANTHROPIC_COMPAT_KEYS = frozenset(
    {
        "supportsEagerToolInputStreaming",
        "supportsLongCacheRetention",
        "sendSessionAffinityHeaders",
        "supportsCacheControlOnTools",
        "supportsTemperature",
        "forceAdaptiveThinking",
        "allowEmptySignature",
        "supportsToolReferences",
    }
)


def strip_json_comments(value: str) -> str:
    """Mirror pi's JSONC support for // comments and trailing commas."""
    without_comments = re.sub(
        r'"(?:\\.|[^"\\])*"|//[^\n]*',
        lambda match: match.group(0) if match.group(0).startswith('"') else "",
        value,
    )
    return re.sub(
        r'"(?:\\.|[^"\\])*"|,(\s*[}\]])',
        lambda match: match.group(1) if match.group(1) is not None else match.group(0),
        without_comments,
    )


def _reject_non_standard_json_constant(value: str) -> None:
    raise ValueError(f"Invalid JSON constant: {value}")


def load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as f:
        data = json.loads(
            strip_json_comments(f.read()),
            parse_constant=_reject_non_standard_json_constant,
        )
    if not isinstance(data, dict):
        raise SystemExit(f"Expected object in {path}")
    return data


def save_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=2, allow_nan=False)
        f.write("\n")


def resolve_api_key(provider: str, cli_key: str | None, auth_path: Path) -> str:
    if cli_key:
        return cli_key
    auth = load_json(auth_path)
    entry = auth.get(provider)
    if isinstance(entry, dict) and entry.get("key"):
        return str(entry["key"])
    raise SystemExit(
        f"No API key for provider '{provider}'. Pass --api-key or store it in {auth_path}."
    )


def normalize_base_url(base_url: str) -> str:
    return base_url.rstrip("/")


def normalize_provider_base_url(base_url: str, api: str) -> str:
    """Anthropic SDK always requests `{baseUrl}/v1/messages` — strip trailing /v1."""
    base = normalize_base_url(base_url)
    if api == "anthropic-messages" and base.endswith("/v1"):
        return base[: -len("/v1")]
    return base


def fetch_models(base_url: str, api_key: str, timeout: float, api: str) -> list[dict[str, Any]]:
    base = normalize_base_url(base_url)
    candidates = [f"{base}/models"]
    # Native Anthropic base often omits /v1, but many proxies still serve /v1/models.
    if api == "anthropic-messages" and not base.endswith("/v1"):
        candidates.append(f"{base}/v1/models")
    # OpenAI-style base with /v1: also try parent /models if needed.
    if base.endswith("/v1"):
        candidates.append(f"{base[: -len('/v1')]}/models")

    last_error = ""
    payload: Any = None
    used_url = ""
    for url in dict.fromkeys(candidates):
        req = urllib.request.Request(
            url,
            headers={
                "Authorization": f"Bearer {api_key}",
                "x-api-key": api_key,
                "Accept": "application/json",
            },
            method="GET",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
                used_url = url
                break
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            last_error = f"GET {url} failed: HTTP {e.code}\n{body}"
        except urllib.error.URLError as e:
            last_error = f"GET {url} failed: {e}"
    if payload is None:
        raise SystemExit(last_error or "Failed to fetch /models")

    data = payload.get("data", payload) if isinstance(payload, dict) else payload
    if not isinstance(data, list):
        raise SystemExit(f"Unexpected /models payload shape from {used_url}: {type(data).__name__}")

    models: list[dict[str, Any]] = []
    for item in data:
        if isinstance(item, str):
            models.append({"id": item})
            continue
        if not isinstance(item, dict):
            continue
        mid = item.get("id") or item.get("model") or item.get("name")
        if not mid:
            continue
        models.append(item if "id" in item else {**item, "id": mid})
    if not models:
        raise SystemExit(f"No models found in /models response from {used_url}")
    return models


def model_id_variants(model_id: str) -> list[str]:
    variants = [model_id]
    alias = KNOWN_ID_ALIASES.get(model_id)
    if alias and alias not in variants:
        variants.append(alias)
    base = re.sub(r"-\d{4}-\d{2}-\d{2}$", "", model_id)
    if base not in variants:
        variants.append(base)
        alias_base = KNOWN_ID_ALIASES.get(base)
        if alias_base and alias_base not in variants:
            variants.append(alias_base)
    if model_id.endswith("-latest"):
        root = model_id[: -len("-latest")]
        if root not in variants:
            variants.append(root)
        alias_root = KNOWN_ID_ALIASES.get(root)
        if alias_root and alias_root not in variants:
            variants.append(alias_root)
    return variants


def is_reasoning_model(model_id: str, raw: dict[str, Any] | None = None) -> bool:
    mid = model_id.lower()
    if "non-reasoning" in mid or "non_reasoning" in mid:
        return False
    if "imagine" in mid or "image" in mid or "video" in mid:
        return False
    if raw:
        if raw.get("supportsReasoningEffort") is True:
            return True
        if raw.get("reasoning") is True:
            return True
        if raw.get("reasoningEfforts") or raw.get("reasoning_efforts"):
            return True
    if "reasoning" in mid or "think" in mid or "multi-agent" in mid:
        return True
    markers = (
        "grok-4",
        "grok-build",
        "gpt-5",
        "o1",
        "o3",
        "o4",
        "claude-opus",
        "claude-sonnet",
        "claude-haiku",
        "claude-fable",
        "claude-4",
        "deepseek-r",
        "gemini-2.5",
        "gemini-3",
    )
    return any(m in mid for m in markers)


def is_vision_model(model_id: str) -> bool:
    """pi only models image input; audio/video special models stay text-only."""
    mid = model_id.lower()
    if any(x in mid for x in ("audio", "realtime", "tts", "transcribe", "whisper", "video")):
        return False
    if "imagine" in mid or "image" in mid:
        return True
    if mid.startswith(("gpt-", "o1", "o3", "o4")) or "codex" in mid:
        return True
    if mid.startswith("grok") or "composer" in mid or "build" in mid:
        return True
    if mid.startswith(("claude", "gemini", "gemma")):
        return True
    return False


def _catalog_model_map(value: Any) -> dict[str, dict[str, Any]]:
    if isinstance(value, list):
        items = [(None, item) for item in value]
    elif isinstance(value, dict) and isinstance(value.get("models"), list):
        items = [(None, item) for item in value["models"]]
    elif isinstance(value, dict):
        items = list(value.items())
    else:
        return {}

    models: dict[str, dict[str, Any]] = {}
    for catalog_id, raw in items:
        if not isinstance(raw, dict):
            continue
        model_id = raw.get("id") or catalog_id
        if not isinstance(model_id, str) or not model_id:
            continue
        model = dict(raw)
        model.setdefault("id", model_id)
        models[model_id] = model
    return models


def _find_active_pi_ai_provider_dir() -> Path | None:
    executable = shutil.which("pi")
    if not executable:
        return None

    entrypoint = Path(executable).resolve()
    for candidate in (entrypoint, *entrypoint.parents):
        manifest = candidate / "package.json"
        if not manifest.is_file():
            continue
        try:
            package = json.loads(manifest.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if package.get("name") != "@earendil-works/pi-coding-agent":
            continue
        provider_dir = candidate / "node_modules" / "@earendil-works" / "pi-ai" / "dist" / "providers"
        return provider_dir if provider_dir.is_dir() else None
    return None


def _catalog_search_roots() -> list[Path]:
    roots: list[Path] = []
    cwd = Path.cwd()
    workspace = next(
        (candidate for candidate in (cwd, *cwd.parents) if (candidate / ".git").exists()),
        None,
    )
    if workspace is not None:
        roots.append(workspace)
    elif (cwd / "node_modules").is_dir():
        roots.append(cwd)
    for parent in Path(__file__).resolve().parents:
        if (parent / ".git").exists():
            roots.append(parent)
            break
    roots.extend(
        [
            Path.home() / ".local" / "share" / "pi-node",
            Path("/usr/lib"),
            Path("/usr/local/lib"),
        ]
    )

    unique: list[Path] = []
    seen: set[Path] = set()
    for root in roots:
        resolved = root.resolve()
        if resolved not in seen:
            seen.add(resolved)
            unique.append(resolved)
    return unique


def _pi_ai_provider_version(provider_dir: Path) -> tuple[int, int, int]:
    manifest = provider_dir.parent.parent / "package.json"
    try:
        version = str(json.loads(manifest.read_text(encoding="utf-8")).get("version", ""))
    except (OSError, json.JSONDecodeError):
        return (0, 0, 0)
    parts = [int(part) for part in re.findall(r"\d+", version)[:3]]
    return tuple((parts + [0, 0, 0])[:3])  # type: ignore[return-value]


def _find_pi_ai_provider_dir() -> Path | None:
    active = _find_active_pi_ai_provider_dir()
    if active is not None:
        return active

    patterns = (
        "node_modules/@earendil-works/pi-ai/dist/providers",
        "node_modules/pi-ai/dist/providers",
    )
    candidates: set[Path] = set()
    for root in _catalog_search_roots():
        if not root.exists():
            continue
        for pattern in patterns:
            candidates.update(path.resolve() for path in root.glob(f"**/{pattern}") if path.is_dir())
    if not candidates:
        return None
    return max(candidates, key=lambda path: (_pi_ai_provider_version(path), path.stat().st_mtime_ns))


def _catalog_file(provider_dir: Path, catalog_provider: str) -> Path | None:
    data_file = provider_dir / "data" / f"{catalog_provider}.json"
    if data_file.is_file():
        return data_file
    legacy_file = provider_dir / f"{catalog_provider}.models.js"
    return legacy_file if legacy_file.is_file() else None


def _catalog_mtime_ms(catalog_provider: str) -> float | None:
    provider_dir = _find_pi_ai_provider_dir()
    if provider_dir is None:
        return None
    path = _catalog_file(provider_dir, catalog_provider)
    return path.stat().st_mtime_ns / 1_000_000 if path is not None else None


def _canonical_catalog_provider(provider: str | None) -> str | None:
    if not provider:
        return None
    value = provider.lower()
    if value in PI_AI_CATALOG_PROVIDERS:
        return value
    return CATALOG_PROVIDER_ALIASES.get(value)


def _catalog_provider_for(
    model_id: str,
    provider: str | None = None,
    transport_api: str | None = None,
) -> str | None:
    provider_key = provider.lower() if provider else ""
    if provider_key == "openai-codex" or transport_api == "openai-codex-responses":
        return "openai-codex"

    model_key = model_id.lower()
    if model_key.startswith("claude"):
        return "anthropic"
    if model_key.startswith("grok"):
        return "xai"
    if model_key.startswith(("gemini", "gemma")):
        return "google"
    if model_key.startswith("gpt-") or re.match(r"o[134](?:[-.]|$)", model_key):
        return "openai"

    known = _canonical_catalog_provider(provider_key)
    if known is not None:
        return known
    if transport_api == "anthropic-messages":
        return "anthropic"
    return provider_key or None


def _load_legacy_catalog(path: Path) -> dict[str, dict[str, Any]]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return {}
    match = re.search(r"export const ([A-Z0-9_]+)\s*=\s*", text)
    if not match:
        return {}
    export_name = match.group(1)
    code = (
        f"import {{ {export_name} }} from {json.dumps(path.as_uri())};\n"
        f"console.log(JSON.stringify({export_name}));\n"
    )
    try:
        proc = subprocess.run(
            ["node", "--input-type=module", "-e", code],
            check=True,
            capture_output=True,
            text=True,
        )
        return _catalog_model_map(json.loads(proc.stdout))
    except (subprocess.CalledProcessError, json.JSONDecodeError, FileNotFoundError):
        return {}


@lru_cache(maxsize=1)
def _load_official_catalog() -> dict[str, dict[str, dict[str, Any]]]:
    """Load current pi-ai catalog JSON, with legacy module support for older pi."""
    provider_dir = _find_pi_ai_provider_dir()
    if provider_dir is None:
        return {}

    catalog: dict[str, dict[str, dict[str, Any]]] = {}
    for catalog_provider in PI_AI_CATALOG_PROVIDERS:
        path = _catalog_file(provider_dir, catalog_provider)
        if path is None:
            continue
        if path.suffix == ".json":
            try:
                models = _catalog_model_map(json.loads(path.read_text(encoding="utf-8")))
            except (OSError, json.JSONDecodeError):
                continue
        else:
            models = _load_legacy_catalog(path)
        if models:
            catalog[catalog_provider] = models
    return catalog


def lookup_official_model(
    model_id: str,
    catalog_provider: str | None = None,
) -> dict[str, Any] | None:
    source = _catalog_provider_for(model_id, catalog_provider)
    if source is None:
        return None
    catalog = _load_official_catalog().get(source, {})
    for candidate in model_id_variants(model_id):
        if candidate in catalog:
            return catalog[candidate]
    return None


def _iter_store_entries() -> list[tuple[str, dict[str, Any]]]:
    store = load_json(DEFAULT_MODELS_STORE)
    entries: list[tuple[str, dict[str, Any]]] = []
    nested = store.get("providers")
    if isinstance(nested, dict):
        entries.extend((str(provider), value) for provider, value in nested.items() if isinstance(value, dict))
    entries.extend(
        (str(provider), value)
        for provider, value in store.items()
        if provider != "providers" and isinstance(value, dict)
    )
    return entries


def _store_entry_is_newer(catalog_provider: str, entry: dict[str, Any]) -> bool:
    local_mtime = _catalog_mtime_ms(catalog_provider)
    if local_mtime is None:
        return True
    last_modified = entry.get("lastModified")
    return isinstance(last_modified, (int, float)) and last_modified > local_mtime


@lru_cache(maxsize=1)
def _load_store_index() -> dict[str, dict[str, dict[str, Any]]]:
    index: dict[str, dict[str, dict[str, Any]]] = {}
    for provider, entry in _iter_store_entries():
        catalog_provider = _catalog_provider_for("", provider)
        if catalog_provider is None or not _store_entry_is_newer(catalog_provider, entry):
            continue
        models = entry.get("models")
        if not isinstance(models, list):
            continue
        target = index.setdefault(catalog_provider, {})
        for model in models:
            if not isinstance(model, dict) or not model.get("id"):
                continue
            model_provider = _canonical_catalog_provider(str(model.get("provider", "")))
            if model_provider is not None and model_provider != catalog_provider:
                continue
            target[str(model["id"])] = model
    return index


def lookup_store_model(
    model_id: str,
    catalog_provider: str | None = None,
) -> dict[str, Any] | None:
    source = _catalog_provider_for(model_id, catalog_provider)
    if source is None:
        return None
    index = _load_store_index().get(source, {})
    for candidate in model_id_variants(model_id):
        if candidate in index:
            return index[candidate]
    return None


def thinking_map_from_raw(raw: dict[str, Any]) -> dict[str, Any] | None:
    efforts = raw.get("reasoningEfforts") or raw.get("reasoning_efforts")
    if not isinstance(efforts, list) or not efforts:
        return None
    values: list[str] = []
    for item in efforts:
        if isinstance(item, dict) and item.get("value") is not None:
            values.append(str(item["value"]).lower())
        elif isinstance(item, str):
            values.append(item.lower())
    if not values:
        return None
    mapping = dict(THINKING_LEVEL_MAP)
    for level in list(mapping):
        if level in ("off", "minimal"):
            continue
        if level not in values and mapping[level] not in values:
            mapping[level] = None
    for value in values:
        if value in mapping:
            mapping[value] = value
    return mapping


def resolve_context_window(
    model_id: str,
    raw: dict[str, Any],
    fallback: int,
    catalog_model: dict[str, Any] | None,
) -> int:
    for key in ("context_window", "contextWindow", "max_model_len"):
        if raw.get(key):
            return int(raw[key])
    if catalog_model:
        context_window = catalog_model.get("contextWindow") or catalog_model.get("context_window")
        if context_window:
            return int(context_window)

    low = model_id.lower()
    if any(x in low for x in ("imagine", "image", "video")):
        return 32_000
    if "audio" in low or "realtime" in low:
        return 128_000
    if low.startswith("claude"):
        if any(x in low for x in ("fable", "opus-4-6", "opus-4-7", "opus-4-8", "sonnet-4-6", "sonnet-5", "sonnet-4-5")):
            return 1_000_000 if "haiku" not in low else 200_000
        return 200_000
    if low.startswith("grok-4.5"):
        return 500_000
    if low.startswith("grok-4.3"):
        return 1_000_000
    if "build" in low or "composer" in low or low.startswith("grok-4") or low in ("grok", "grok-latest"):
        return 256_000
    if "chat-latest" in low or "codex-spark" in low:
        return 128_000
    if any(x in low for x in ("gpt-5.4", "gpt-5.5", "gpt-5.6")) and "pro" not in low and "mini" not in low:
        return 272_000
    if low.startswith("gpt-5") or "codex" in low:
        return 400_000
    if low.startswith("gpt-4o") or low.startswith("o1") or low.startswith("o3") or low.startswith("o4"):
        return 128_000 if low.startswith("gpt-4o") else 200_000
    return fallback


def resolve_max_tokens(
    model_id: str,
    raw: dict[str, Any],
    catalog_model: dict[str, Any] | None,
) -> int | None:
    for key in ("max_tokens", "maxTokens", "max_output_tokens"):
        if raw.get(key):
            return int(raw[key])
    if catalog_model and catalog_model.get("maxTokens"):
        return int(catalog_model["maxTokens"])
    for candidate in model_id_variants(model_id):
        if candidate in KNOWN_MAX_TOKENS:
            return KNOWN_MAX_TOKENS[candidate]
    low = model_id.lower()
    if any(x in low for x in ("imagine", "image", "video", "audio", "realtime")):
        return 16_384
    if low.startswith("claude"):
        if "haiku" in low:
            return 64_000
        if "opus-4-5" in low:
            return 64_000
        if "sonnet-4-5" in low:
            return 64_000
        return 128_000
    if low.startswith("grok-4.5"):
        return 500_000
    if low.startswith("grok-4.3"):
        return 30_000
    if "build" in low or "composer" in low or low.startswith("grok-4") or low in ("grok", "grok-latest"):
        return 256_000
    if low.startswith("gpt-5") or "codex" in low:
        return 128_000
    return None


def resolve_input(
    model_id: str,
    raw: dict[str, Any],
    catalog_model: dict[str, Any] | None,
) -> list[str]:
    if isinstance(raw.get("input"), list) and raw["input"]:
        supported = [value for value in raw["input"] if isinstance(value, str) and value in {"text", "image"}]
        if supported:
            return supported
    if catalog_model and isinstance(catalog_model.get("input"), list) and catalog_model["input"]:
        return list(catalog_model["input"])
    for candidate in model_id_variants(model_id):
        if candidate in KNOWN_INPUT:
            return list(KNOWN_INPUT[candidate])
    return ["text", "image"] if is_vision_model(model_id) else ["text"]


def _is_cost_number(value: Any) -> bool:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def _normalize_cost_rates(
    cost: dict[str, Any],
    fill_missing_cache_rates: bool,
) -> dict[str, Any] | None:
    normalized = dict(cost)
    for key in ("input", "output"):
        if not _is_cost_number(normalized.get(key)):
            return None
    for key in ("cacheRead", "cacheWrite"):
        if key not in normalized and fill_missing_cache_rates:
            normalized[key] = 0
        if not _is_cost_number(normalized.get(key)):
            return None
    return normalized


def normalize_cost(
    cost: Any,
    fill_missing_cache_rates: bool = False,
) -> dict[str, Any] | None:
    """Keep emitted costs valid for pi's four-rate model schema."""
    if not isinstance(cost, dict):
        return None
    normalized = _normalize_cost_rates(cost, fill_missing_cache_rates)
    if normalized is None:
        return None
    tiers = normalized.get("tiers")
    if tiers is None:
        return normalized
    if not isinstance(tiers, list):
        return None
    normalized_tiers: list[dict[str, Any]] = []
    for tier in tiers:
        if not isinstance(tier, dict) or not _is_cost_number(tier.get("inputTokensAbove")):
            return None
        normalized_tier = _normalize_cost_rates(tier, fill_missing_cache_rates)
        if normalized_tier is None:
            return None
        normalized_tiers.append(normalized_tier)
    normalized["tiers"] = normalized_tiers
    return normalized


def resolve_cost(catalog_model: dict[str, Any] | None) -> dict[str, Any] | None:
    """Copy complete catalog pricing only. Never invent rates."""
    return normalize_cost(catalog_model.get("cost") if catalog_model else None)


def to_model_entry(
    raw: dict[str, Any],
    context_window: int,
    transport_api: str | None = None,
    provider: str | None = None,
) -> dict[str, Any]:
    mid = str(raw["id"])
    name = str(raw.get("display_name") or raw.get("name") or mid)
    model_api = raw.get("api") if isinstance(raw.get("api"), str) else transport_api
    catalog_provider = _catalog_provider_for(mid, provider, model_api)
    store_model = lookup_store_model(mid, catalog_provider)
    official = lookup_official_model(mid, catalog_provider)
    catalog_model = store_model or official

    reasoning = is_reasoning_model(mid, raw)
    is_generation_model = any(x in mid.lower() for x in ("imagine", "image", "video"))
    if not is_generation_model and isinstance(raw.get("reasoning"), bool):
        reasoning = bool(raw["reasoning"])
    elif not is_generation_model and catalog_model and isinstance(catalog_model.get("reasoning"), bool):
        reasoning = bool(catalog_model["reasoning"])

    if catalog_model and catalog_model.get("name") and name == mid:
        name = str(catalog_model["name"])

    entry: dict[str, Any] = {
        "id": mid,
        "name": name,
        "reasoning": reasoning,
        "input": resolve_input(mid, raw, catalog_model),
        "contextWindow": resolve_context_window(mid, raw, context_window, catalog_model),
    }

    max_tokens = resolve_max_tokens(mid, raw, catalog_model)
    if max_tokens is not None:
        entry["maxTokens"] = max_tokens

    if reasoning:
        thinking = None
        if isinstance(raw.get("thinkingLevelMap"), dict):
            thinking = dict(raw["thinkingLevelMap"])
        if thinking is None:
            thinking = thinking_map_from_raw(raw)
        if thinking is None and catalog_model and isinstance(catalog_model.get("thinkingLevelMap"), dict):
            thinking = dict(catalog_model["thinkingLevelMap"])
        if thinking is None:
            for candidate in model_id_variants(mid):
                if candidate in KNOWN_THINKING_LEVEL_MAP:
                    thinking = dict(KNOWN_THINKING_LEVEL_MAP[candidate])
                    break
        if thinking is None:
            thinking = dict(THINKING_LEVEL_MAP)
        entry["thinkingLevelMap"] = thinking

    cost = resolve_cost(catalog_model)
    if cost is not None:
        entry["cost"] = cost

    # Only copy Anthropic-specific compat flags for native messages transport.
    if model_api == "anthropic-messages":
        compat: dict[str, Any] = {}
        for source in (catalog_model, raw):
            if not source or not isinstance(source.get("compat"), dict):
                continue
            compat.update({key: value for key, value in source["compat"].items() if key in ANTHROPIC_COMPAT_KEYS})
        if compat:
            entry["compat"] = compat

    return entry


def backup_file(path: Path) -> Path | None:
    if not path.exists():
        return None
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S%f")
    bak = path.with_suffix(path.suffix + f".bak.{stamp}")
    shutil.copy2(path, bak)
    return bak


def upsert_auth(auth_path: Path, provider: str, api_key: str) -> None:
    auth = load_json(auth_path)
    auth[provider] = {"type": "api_key", "key": api_key}
    save_json(auth_path, auth)


def merge_provider(
    models_json: dict[str, Any],
    provider: str,
    base_url: str,
    api: str,
    model_entries: list[dict[str, Any]],
    provider_name: str | None,
) -> dict[str, Any]:
    providers = models_json.setdefault("providers", {})
    if not isinstance(providers, dict):
        raise SystemExit("models.json providers must be an object")

    existing = providers.get(provider, {})
    if not isinstance(existing, dict):
        existing = {}

    entry = dict(existing)
    entry.update(
        {
            "name": provider_name or existing.get("name") or provider,
            "baseUrl": normalize_provider_base_url(base_url, api),
            "api": api,
            "models": model_entries,
        }
    )

    providers[provider] = entry
    models_json["providers"] = providers
    return models_json


def summarize_entries(entries: list[dict[str, Any]]) -> None:
    with_cost = [m["id"] for m in entries if isinstance(m.get("cost"), dict)]
    no_cost = [m["id"] for m in entries if not isinstance(m.get("cost"), dict)]
    vision = sum(1 for m in entries if "image" in m.get("input", []))
    reasoning = sum(1 for m in entries if m.get("reasoning"))
    print(
        f"summary: models={len(entries)} vision={vision} reasoning={reasoning} "
        f"with_cost={len(with_cost)} no_cost={len(no_cost)}"
    )
    if with_cost:
        print("  cost ok: " + ", ".join(with_cost))
    if no_cost:
        print("  cost missing (no official/store price; left unset, UI shows $0):")
        print("    " + ", ".join(no_cost))


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--provider", required=True, help="Provider key, e.g. grok")
    p.add_argument(
        "--base-url",
        default=None,
        help="API base URL. Required unless --enrich-only; anthropic-messages should NOT end with /v1",
    )
    p.add_argument(
        "--api",
        default=None,
        choices=[
            "openai-responses",
            "openai-completions",
            "openai-codex-responses",
            "anthropic-messages",
            "google-generative-ai",
        ],
        help="pi API type; defaults to openai-responses for normal sync",
    )
    p.add_argument("--api-key", default=None, help="API key; defaults to auth.json")
    p.add_argument("--provider-name", default=None, help="Display name for provider")
    p.add_argument("--models-json", type=Path, default=DEFAULT_MODELS_JSON)
    p.add_argument("--auth-json", type=Path, default=DEFAULT_AUTH_JSON)
    p.add_argument("--context-window", type=int, default=DEFAULT_CONTEXT)
    p.add_argument("--timeout", type=float, default=30.0)
    p.add_argument(
        "--write-auth",
        action="store_true",
        help="Also write/update ~/.pi/agent/auth.json for this provider",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Fetch and print planned models; do not write files",
    )
    p.add_argument(
        "--enrich-only",
        action="store_true",
        help="Do not fetch /models; re-enrich existing provider models from store/official catalogs",
    )
    return p.parse_args()


def enrich_existing_provider(models_json: dict[str, Any], provider: str, context_window: int) -> list[dict[str, Any]]:
    providers = models_json.get("providers")
    if not isinstance(providers, dict) or provider not in providers:
        raise SystemExit(f"Provider '{provider}' not found in models.json")
    cfg = providers[provider]
    if not isinstance(cfg, dict) or not isinstance(cfg.get("models"), list):
        raise SystemExit(f"Provider '{provider}' has no models list")

    provider_api = cfg.get("api") if isinstance(cfg.get("api"), str) else None
    endpoint_keys = (
        "context_window",
        "contextWindow",
        "max_model_len",
        "max_tokens",
        "maxTokens",
        "max_output_tokens",
        "supportsReasoningEffort",
        "reasoningEfforts",
        "reasoning_efforts",
    )
    preserved_keys = {"id", "name", "display_name", "api", "baseUrl", "compat", "cost", "thinkingLevelMap"}
    preserved_keys.update(endpoint_keys)

    entries: list[dict[str, Any]] = []
    for raw in cfg["models"]:
        if not isinstance(raw, dict) or not raw.get("id"):
            continue

        enrichment_raw: dict[str, Any] = {
            "id": raw["id"],
            "display_name": raw.get("display_name") or raw.get("name"),
        }
        enrichment_raw.update({key: raw[key] for key in endpoint_keys if key in raw})
        model_api = raw.get("api") if isinstance(raw.get("api"), str) else provider_api
        entry = to_model_entry(
            enrichment_raw,
            context_window,
            transport_api=model_api,
            provider=provider,
        )

        # Re-enrichment must not erase model-specific transport or user metadata.
        for key in ("name", "api", "baseUrl", "compat", "display_name"):
            if key in raw:
                entry[key] = raw[key]
        configured_cost = normalize_cost(raw.get("cost"), fill_missing_cache_rates=True)
        if configured_cost is not None:
            entry["cost"] = configured_cost
        if isinstance(raw.get("thinkingLevelMap"), dict):
            entry["thinkingLevelMap"] = dict(raw["thinkingLevelMap"])
        for key, value in raw.items():
            if key not in preserved_keys:
                entry[key] = value
        entries.append(entry)

    entries.sort(key=lambda m: m["id"].lower())
    return entries


def main() -> int:
    args = parse_args()
    models_json = load_json(args.models_json)

    if args.enrich_only:
        if args.api is not None or args.base_url is not None:
            raise SystemExit("--enrich-only uses the existing provider api/baseUrl; omit --api and --base-url")
        entries = enrich_existing_provider(models_json, args.provider, args.context_window)
        source = "existing models.json"
    else:
        if not args.base_url:
            raise SystemExit("--base-url is required unless --enrich-only")
        api = args.api or "openai-responses"
        api_key = resolve_api_key(args.provider, args.api_key, args.auth_json)
        # For anthropic-messages, allow user to pass either host or host/v1 for fetch.
        raw_models = fetch_models(args.base_url, api_key, args.timeout, api)
        entries = [
            to_model_entry(m, args.context_window, transport_api=api, provider=args.provider)
            for m in raw_models
        ]
        entries.sort(key=lambda m: m["id"].lower())
        source = f"{normalize_base_url(args.base_url)}/models"

    catalog_size = sum(len(models) for models in _load_official_catalog().values())
    print(f"Fetched/built {len(entries)} models from {source}")
    print(f"Official pi-ai catalog entries loaded: {catalog_size}")
    for m in entries:
        flag = "reasoning" if m["reasoning"] else "plain"
        cost_flag = "cost" if m.get("cost") else "no-cost"
        print(f"  - {m['id']}  [{flag}, {cost_flag}]")
    summarize_entries(entries)

    if args.dry_run:
        print("dry-run: no files written")
        return 0

    bak = backup_file(args.models_json)
    if bak:
        print(f"Backup: {bak}")

    if args.enrich_only:
        providers = models_json.setdefault("providers", {})
        cfg = providers[args.provider]
        cfg["models"] = entries
        providers[args.provider] = cfg
        models_json["providers"] = providers
        save_json(args.models_json, models_json)
        print(f"Re-enriched provider '{args.provider}' -> {args.models_json}")
    else:
        merged = merge_provider(
            models_json,
            provider=args.provider,
            base_url=args.base_url,
            api=api,
            model_entries=entries,
            provider_name=args.provider_name,
        )
        save_json(args.models_json, merged)
        print(f"Wrote provider '{args.provider}' -> {args.models_json}")
        written_base = normalize_provider_base_url(args.base_url, api)
        if api == "anthropic-messages" and normalize_base_url(args.base_url).endswith("/v1"):
            print(
                f"note: anthropic-messages baseUrl normalized to {written_base} "
                "(SDK appends /v1/messages)"
            )

    if args.write_auth:
        if not args.api_key:
            print("write-auth skipped: pass --api-key to store credentials")
        else:
            auth_bak = backup_file(args.auth_json)
            if auth_bak:
                print(f"Auth backup: {auth_bak}")
            upsert_auth(args.auth_json, args.provider, args.api_key)
            print(f"Wrote auth for '{args.provider}' -> {args.auth_json}")

    print("Next: pick a model with /model, or set settings.json defaultModel")
    return 0


if __name__ == "__main__":
    sys.exit(main())
