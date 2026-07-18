#!/usr/bin/env python3
"""Fetch OpenAI-compatible /models and merge into pi models.json."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DEFAULT_MODELS_JSON = Path.home() / ".pi" / "agent" / "models.json"
DEFAULT_AUTH_JSON = Path.home() / ".pi" / "agent" / "auth.json"
DEFAULT_MODELS_STORE = Path.home() / ".pi" / "agent" / "models-store.json"
# Fallback only when no store/family match; prefer real windows over inflated 500k.
DEFAULT_CONTEXT = 256000

# Official xAI metadata from pi-ai xai.models (not always present in models-store).
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
# Official thinking maps from pi-ai where they differ from the generic map.
KNOWN_THINKING_LEVEL_MAP: dict[str, dict[str, Any]] = {
    "grok-4.5": {"off": None, "minimal": None},
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


def load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise SystemExit(f"Expected object in {path}")
    return data


def save_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
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


def fetch_models(base_url: str, api_key: str, timeout: float) -> list[dict[str, Any]]:
    url = f"{normalize_base_url(base_url)}/models"
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Accept": "application/json",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise SystemExit(f"GET {url} failed: HTTP {e.code}\n{body}") from e
    except urllib.error.URLError as e:
        raise SystemExit(f"GET {url} failed: {e}") from e

    data = payload.get("data", payload) if isinstance(payload, dict) else payload
    if not isinstance(data, list):
        raise SystemExit(f"Unexpected /models payload shape: {type(data).__name__}")

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
        raise SystemExit("No models found in /models response")
    return models


def model_id_variants(model_id: str) -> list[str]:
    variants = [model_id]
    base = re.sub(r"-\d{4}-\d{2}-\d{2}$", "", model_id)
    if base not in variants:
        variants.append(base)
    if model_id.endswith("-latest"):
        root = model_id[: -len("-latest")]
        if root not in variants:
            variants.append(root)
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
    # Common chat/reasoning families; false positives are safer than missing thinking map.
    markers = (
        "grok-4",
        "grok-build",
        "gpt-5",
        "o1",
        "o3",
        "o4",
        "claude-opus",
        "claude-sonnet",
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
    # Image gen/edit endpoints still benefit from image attachments.
    if "imagine" in mid or "image" in mid:
        return True
    if mid.startswith(("gpt-", "o1", "o3", "o4")) or "codex" in mid:
        return True
    if mid.startswith("grok") or "composer" in mid or "build" in mid:
        return True
    if mid.startswith(("claude", "gemini", "gemma")):
        return True
    return False


def _iter_store_models() -> list[dict[str, Any]]:
    store = load_json(DEFAULT_MODELS_STORE)
    roots: list[Any] = []
    providers = store.get("providers") if isinstance(store, dict) else None
    if isinstance(providers, dict):
        roots.extend(providers.values())
    if isinstance(store, dict):
        roots.extend(v for k, v in store.items() if k != "providers" and isinstance(v, dict))
    out: list[dict[str, Any]] = []
    for prov in roots:
        models = prov.get("models") if isinstance(prov, dict) else None
        if not isinstance(models, list):
            continue
        for m in models:
            if isinstance(m, dict) and m.get("id"):
                out.append(m)
    return out


def _load_store_index() -> dict[str, dict[str, Any]]:
    index: dict[str, dict[str, Any]] = {}
    for m in _iter_store_models():
        index[str(m["id"])] = m
    return index


def lookup_store_model(model_id: str) -> dict[str, Any] | None:
    index = _load_store_index()
    for candidate in model_id_variants(model_id):
        if candidate in index:
            return index[candidate]
    return None


def _load_store_context() -> dict[str, int]:
    out: dict[str, int] = dict(KNOWN_CONTEXT)
    for m in _iter_store_models():
        mid = m.get("id")
        ctx = m.get("contextWindow") or m.get("context_window")
        if mid and ctx:
            out[str(mid)] = int(ctx)
    return out


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
    # Keep only levels the endpoint advertises; hide the rest.
    for level in list(mapping):
        if level in ("off", "minimal"):
            continue
        if level not in values and mapping[level] not in values:
            mapping[level] = None
    for value in values:
        if value in mapping:
            mapping[value] = value
    return mapping


def resolve_context_window(model_id: str, raw: dict[str, Any], fallback: int) -> int:
    for key in ("context_window", "contextWindow", "max_model_len"):
        if raw.get(key):
            return int(raw[key])

    store = _load_store_context()
    for candidate in model_id_variants(model_id):
        if candidate in store:
            return store[candidate]

    low = model_id.lower()
    if any(x in low for x in ("imagine", "image", "video")):
        return 32_000
    if "audio" in low or "realtime" in low:
        return 128_000
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


def resolve_max_tokens(model_id: str, raw: dict[str, Any], store_model: dict[str, Any] | None) -> int | None:
    for key in ("max_tokens", "maxTokens", "max_output_tokens"):
        if raw.get(key):
            return int(raw[key])
    if store_model and store_model.get("maxTokens"):
        return int(store_model["maxTokens"])
    for candidate in model_id_variants(model_id):
        if candidate in KNOWN_MAX_TOKENS:
            return KNOWN_MAX_TOKENS[candidate]
    low = model_id.lower()
    if any(x in low for x in ("imagine", "image", "video", "audio", "realtime")):
        return 16_384
    if low.startswith("grok-4.5"):
        return 500_000
    if low.startswith("grok-4.3"):
        return 30_000
    if "build" in low or "composer" in low or low.startswith("grok-4") or low in ("grok", "grok-latest"):
        return 256_000
    if low.startswith("gpt-5") or "codex" in low:
        return 128_000
    return None


def resolve_input(model_id: str, store_model: dict[str, Any] | None) -> list[str]:
    if store_model and isinstance(store_model.get("input"), list) and store_model["input"]:
        return list(store_model["input"])
    for candidate in model_id_variants(model_id):
        if candidate in KNOWN_INPUT:
            return list(KNOWN_INPUT[candidate])
    return ["text", "image"] if is_vision_model(model_id) else ["text"]


def to_model_entry(raw: dict[str, Any], context_window: int) -> dict[str, Any]:
    mid = str(raw["id"])
    name = str(raw.get("display_name") or raw.get("name") or mid)
    store_model = lookup_store_model(mid)
    reasoning = is_reasoning_model(mid, raw)
    if store_model and isinstance(store_model.get("reasoning"), bool):
        # Prefer official store when id matches a known built-in catalog entry.
        reasoning = bool(store_model["reasoning"])

    entry: dict[str, Any] = {
        "id": mid,
        "name": name,
        "reasoning": reasoning,
        "input": resolve_input(mid, store_model),
        "contextWindow": resolve_context_window(mid, raw, context_window),
    }

    max_tokens = resolve_max_tokens(mid, raw, store_model)
    if max_tokens is not None:
        entry["maxTokens"] = max_tokens

    if reasoning:
        thinking = None
        for candidate in model_id_variants(mid):
            if candidate in KNOWN_THINKING_LEVEL_MAP:
                thinking = dict(KNOWN_THINKING_LEVEL_MAP[candidate])
                break
        if thinking is None and store_model and isinstance(store_model.get("thinkingLevelMap"), dict):
            thinking = dict(store_model["thinkingLevelMap"])
        if thinking is None:
            thinking = thinking_map_from_raw(raw)
        if thinking is None:
            thinking = dict(THINKING_LEVEL_MAP)
        entry["thinkingLevelMap"] = thinking

    # Copy known official pricing when available; never invent rates.
    if store_model and isinstance(store_model.get("cost"), dict):
        entry["cost"] = store_model["cost"]

    return entry


def backup_file(path: Path) -> Path | None:
    if not path.exists():
        return None
    # Include microseconds so multi-provider refreshes in the same second keep distinct backups.
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

    entry: dict[str, Any] = {
        "name": provider_name or existing.get("name") or provider,
        "baseUrl": normalize_base_url(base_url),
        "api": api,
        "models": model_entries,
    }
    # Preserve optional provider-level fields when present.
    for key in ("headers", "compat", "authHeader", "apiKey"):
        if key in existing and key not in entry:
            entry[key] = existing[key]

    providers[provider] = entry
    models_json["providers"] = providers
    return models_json


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--provider", required=True, help="Provider key, e.g. grok")
    p.add_argument("--base-url", required=True, help="API base URL ending with /v1")
    p.add_argument(
        "--api",
        default="openai-responses",
        choices=["openai-responses", "openai-completions", "anthropic-messages", "google-generative-ai"],
        help="pi API type",
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
    return p.parse_args()


def main() -> int:
    args = parse_args()
    api_key = resolve_api_key(args.provider, args.api_key, args.auth_json)
    raw_models = fetch_models(args.base_url, api_key, args.timeout)
    entries = [to_model_entry(m, args.context_window) for m in raw_models]
    entries.sort(key=lambda m: m["id"].lower())

    print(f"Fetched {len(entries)} models from {normalize_base_url(args.base_url)}/models")
    for m in entries:
        flag = "reasoning" if m["reasoning"] else "plain"
        print(f"  - {m['id']}  [{flag}]")

    if args.dry_run:
        print("dry-run: no files written")
        return 0

    models_json = load_json(args.models_json)
    bak = backup_file(args.models_json)
    if bak:
        print(f"Backup: {bak}")

    merged = merge_provider(
        models_json,
        provider=args.provider,
        base_url=args.base_url,
        api=args.api,
        model_entries=entries,
        provider_name=args.provider_name,
    )
    save_json(args.models_json, merged)
    print(f"Wrote provider '{args.provider}' -> {args.models_json}")

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
