import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("sync_provider_models.py")
SPEC = importlib.util.spec_from_file_location("sync_provider_models_under_test", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class ProviderSyncTests(unittest.TestCase):
    def tearDown(self):
        MODULE._load_official_catalog.cache_clear()
        MODULE._load_store_index.cache_clear()

    def test_active_pi_catalog_is_preferred_over_workspace_dependency(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            active = root / "pi-coding-agent"
            cli = active / "dist" / "cli.js"
            providers = active / "node_modules" / "@earendil-works" / "pi-ai" / "dist" / "providers"
            workspace = root / "workspace"
            workspace_providers = workspace / "node_modules" / "pi-ai" / "dist" / "providers"
            cli.parent.mkdir(parents=True)
            providers.mkdir(parents=True)
            workspace_providers.mkdir(parents=True)
            cli.write_text("", encoding="utf-8")
            (active / "package.json").write_text(
                json.dumps({"name": "@earendil-works/pi-coding-agent"}), encoding="utf-8"
            )
            (workspace / ".git").mkdir()
            (workspace_providers / "openai.models.js").write_text(
                "export const OPENAI_MODELS = {};\n", encoding="utf-8"
            )

            with patch.object(MODULE.shutil, "which", return_value=str(cli)), patch.object(
                Path, "cwd", return_value=workspace
            ):
                self.assertEqual(MODULE._find_pi_ai_provider_dir(), providers)

    def test_official_catalog_reads_current_json_data_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            providers = Path(tmp) / "providers"
            data = providers / "data"
            data.mkdir(parents=True)
            (data / "openai.json").write_text(
                json.dumps(
                    {
                        "gpt-5.4": {
                            "id": "gpt-5.4",
                            "provider": "openai",
                            "thinkingLevelMap": {"off": "none"},
                        }
                    }
                ),
                encoding="utf-8",
            )
            with patch.object(MODULE, "_find_pi_ai_provider_dir", return_value=providers):
                catalog = MODULE._load_official_catalog()

            self.assertEqual(catalog["openai"]["gpt-5.4"]["thinkingLevelMap"], {"off": "none"})

    def test_official_lookup_keeps_same_model_ids_in_separate_provider_catalogs(self):
        catalog = {
            "openai": {"gpt-5.4": {"id": "gpt-5.4", "thinkingLevelMap": {"off": "none"}}},
            "openai-codex": {
                "gpt-5.4": {"id": "gpt-5.4", "thinkingLevelMap": {"minimal": "low"}}
            },
        }
        with patch.object(MODULE, "_load_official_catalog", return_value=catalog):
            entry = MODULE.lookup_official_model("gpt-5.4", catalog_provider="openai")

        self.assertEqual(entry["thinkingLevelMap"], {"off": "none"})

    def test_stale_models_store_entry_is_ignored_for_matching_provider(self):
        with tempfile.TemporaryDirectory() as tmp:
            store_path = Path(tmp) / "models-store.json"
            store_path.write_text(
                json.dumps(
                    {
                        "openai": {
                            "lastModified": 100,
                            "models": [{"id": "gpt-proxy-only", "contextWindow": 999999}],
                        }
                    }
                ),
                encoding="utf-8",
            )
            with patch.object(MODULE, "DEFAULT_MODELS_STORE", store_path), patch.object(
                MODULE, "_catalog_mtime_ms", return_value=200
            ):
                self.assertIsNone(MODULE.lookup_store_model("gpt-proxy-only", catalog_provider="openai"))

    def test_newer_models_store_entry_is_used_for_matching_provider(self):
        with tempfile.TemporaryDirectory() as tmp:
            store_path = Path(tmp) / "models-store.json"
            store_path.write_text(
                json.dumps(
                    {
                        "openai": {
                            "lastModified": 300,
                            "models": [{"id": "gpt-proxy-only", "contextWindow": 999999}],
                        }
                    }
                ),
                encoding="utf-8",
            )
            with patch.object(MODULE, "DEFAULT_MODELS_STORE", store_path), patch.object(
                MODULE, "_catalog_mtime_ms", return_value=200
            ):
                entry = MODULE.lookup_store_model("gpt-proxy-only", catalog_provider="openai")

        self.assertEqual(entry["contextWindow"], 999999)

    def test_newer_models_store_overrides_static_catalog_metadata(self):
        static = {
            "name": "Static",
            "reasoning": False,
            "input": ["text"],
            "contextWindow": 1,
            "maxTokens": 2,
            "thinkingLevelMap": {"off": "none"},
            "cost": {"input": 1, "output": 1, "cacheRead": 0.1, "cacheWrite": 0.2},
            "compat": {"forceAdaptiveThinking": True},
        }
        fresh_store = {
            "name": "Remote",
            "reasoning": True,
            "input": ["text", "image"],
            "contextWindow": 3,
            "maxTokens": 4,
            "thinkingLevelMap": {"max": "max"},
            "cost": {"input": 5, "output": 6, "cacheRead": 0.5, "cacheWrite": 0.6},
            "compat": {"supportsEagerToolInputStreaming": False},
        }
        with patch.object(MODULE, "lookup_official_model", return_value=static), patch.object(
            MODULE, "lookup_store_model", return_value=fresh_store
        ):
            entry = MODULE.to_model_entry(
                {"id": "custom-model", "api": "anthropic-messages"},
                MODULE.DEFAULT_CONTEXT,
            )

        self.assertEqual(entry["name"], "Remote")
        self.assertTrue(entry["reasoning"])
        self.assertEqual(entry["input"], ["text", "image"])
        self.assertEqual(entry["contextWindow"], 3)
        self.assertEqual(entry["maxTokens"], 4)
        self.assertEqual(entry["thinkingLevelMap"], {"max": "max"})
        self.assertEqual(entry["cost"], {"input": 5, "output": 6, "cacheRead": 0.5, "cacheWrite": 0.6})
        self.assertEqual(entry["compat"], {"supportsEagerToolInputStreaming": False})

    def test_parse_args_accepts_openai_codex_responses(self):
        argv = [
            str(SCRIPT),
            "--provider",
            "codex-proxy",
            "--base-url",
            "https://proxy.example/v1",
            "--api",
            "openai-codex-responses",
        ]
        with patch.object(sys, "argv", argv):
            args = MODULE.parse_args()

        self.assertEqual(args.api, "openai-codex-responses")

    def test_partial_catalog_cost_is_not_emitted(self):
        with patch.object(MODULE, "lookup_official_model", return_value={"cost": {"input": 1, "output": 2}}), patch.object(
            MODULE, "lookup_store_model", return_value=None
        ):
            entry = MODULE.to_model_entry({"id": "custom-model"}, MODULE.DEFAULT_CONTEXT)

        self.assertNotIn("cost", entry)

    def test_non_finite_catalog_cost_is_not_emitted(self):
        invalid_costs = [
            {"input": float("nan"), "output": 2, "cacheRead": 0, "cacheWrite": 0},
            {
                "input": 1,
                "output": 2,
                "cacheRead": 0,
                "cacheWrite": 0,
                "tiers": [
                    {
                        "inputTokensAbove": float("inf"),
                        "input": 1,
                        "output": 2,
                        "cacheRead": 0,
                        "cacheWrite": 0,
                    }
                ],
            },
        ]
        for cost in invalid_costs:
            with self.subTest(cost=cost), patch.object(
                MODULE, "lookup_official_model", return_value={"cost": cost}
            ), patch.object(MODULE, "lookup_store_model", return_value=None):
                entry = MODULE.to_model_entry({"id": "custom-model"}, MODULE.DEFAULT_CONTEXT)

            self.assertNotIn("cost", entry)

    def test_load_json_accepts_pi_jsonc_comments_and_trailing_commas(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "models.json"
            path.write_text(
                """{
  // pi accepts comments in models.json
  "providers": {
    "proxy": {
      "baseUrl": "https://proxy.example/v1", // preserve URL text
    },
  },
}
""",
                encoding="utf-8",
            )

            data = MODULE.load_json(path)

        self.assertEqual(data["providers"]["proxy"]["baseUrl"], "https://proxy.example/v1")

    def test_load_json_rejects_non_standard_numeric_constants(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "models.json"
            path.write_text('{"providers": NaN}\n', encoding="utf-8")

            with self.assertRaises(ValueError):
                MODULE.load_json(path)

    def test_merge_provider_preserves_unknown_provider_overlay_fields(self):
        merged = MODULE.merge_provider(
            {
                "providers": {
                    "corporate": {
                        "oauth": "radius",
                        "modelOverrides": {"gpt-5.4": {"contextWindow": 1_050_000}},
                        "x-provider-metadata": {"region": "eu"},
                    }
                }
            },
            provider="corporate",
            base_url="https://proxy.example/v1",
            api="openai-responses",
            model_entries=[{"id": "gpt-5.4"}],
            provider_name=None,
        )

        provider = merged["providers"]["corporate"]
        self.assertEqual(provider["oauth"], "radius")
        self.assertEqual(provider["modelOverrides"], {"gpt-5.4": {"contextWindow": 1_050_000}})
        self.assertEqual(provider["x-provider-metadata"], {"region": "eu"})

    def test_native_anthropic_compat_includes_current_supported_flags(self):
        compat = {
            "supportsEagerToolInputStreaming": False,
            "supportsToolReferences": False,
            "supportsTemperature": False,
            "forceAdaptiveThinking": True,
            "allowEmptySignature": True,
        }
        with patch.object(MODULE, "lookup_official_model", return_value={"compat": compat}):
            entry = MODULE.to_model_entry(
                {"id": "claude-proxy", "api": "anthropic-messages"},
                MODULE.DEFAULT_CONTEXT,
            )

        self.assertEqual(entry["compat"], compat)

    def test_enrich_only_keeps_provider_and_model_configuration(self):
        with tempfile.TemporaryDirectory() as tmp:
            models_path = Path(tmp) / "models.json"
            models_path.write_text(
                json.dumps(
                    {
                        "providers": {
                            "claude-proxy": {
                                "name": "Claude proxy",
                                "baseUrl": "https://proxy.example/v1",
                                "api": "anthropic-messages",
                                "headers": {"x-test": "keep"},
                                "models": [
                                    {
                                        "id": "claude-fable-5",
                                        "name": "Fable alias",
                                        "display_name": "Fable display",
                                        "api": "anthropic-messages",
                                        "compat": {"customFlag": True},
                                        "cost": {"input": 99, "output": 100},
                                        "x-custom": "keep",
                                    }
                                ],
                            }
                        }
                    }
                ),
                encoding="utf-8",
            )
            argv = [
                str(SCRIPT),
                "--provider",
                "claude-proxy",
                "--enrich-only",
                "--models-json",
                str(models_path),
            ]
            with patch.object(sys, "argv", argv), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(MODULE.main(), 0)

            provider = json.loads(models_path.read_text(encoding="utf-8"))["providers"]["claude-proxy"]
            model = provider["models"][0]
            self.assertEqual(provider["api"], "anthropic-messages")
            self.assertEqual(provider["baseUrl"], "https://proxy.example/v1")
            self.assertEqual(provider["headers"], {"x-test": "keep"})
            self.assertEqual(model["api"], "anthropic-messages")
            self.assertEqual(model["name"], "Fable alias")
            self.assertEqual(model["display_name"], "Fable display")
            self.assertEqual(model["compat"], {"customFlag": True})
            self.assertEqual(
                model["cost"],
                {"input": 99, "output": 100, "cacheRead": 0, "cacheWrite": 0},
            )
            self.assertEqual(model["x-custom"], "keep")

    def test_endpoint_reasoning_and_efforts_override_official_catalog(self):
        disabled = MODULE.to_model_entry(
            {"id": "claude-fable-5", "reasoning": False},
            MODULE.DEFAULT_CONTEXT,
        )
        entry = MODULE.to_model_entry(
            {"id": "claude-fable-5", "reasoningEfforts": ["low", "high"]},
            MODULE.DEFAULT_CONTEXT,
        )

        self.assertFalse(disabled["reasoning"])
        self.assertEqual(entry["thinkingLevelMap"]["low"], "low")
        self.assertEqual(entry["thinkingLevelMap"]["high"], "high")
        self.assertIsNone(entry["thinkingLevelMap"]["max"])

    def test_endpoint_input_is_limited_to_pi_supported_types(self):
        entry = MODULE.to_model_entry(
            {"id": "custom-chat", "input": ["text", "audio"]},
            MODULE.DEFAULT_CONTEXT,
        )

        self.assertEqual(entry["input"], ["text"])

    def test_official_anthropic_compat_requires_native_transport(self):
        openai_entry = MODULE.to_model_entry(
            {"id": "claude-opus-4-6", "api": "openai-completions"},
            MODULE.DEFAULT_CONTEXT,
        )
        anthropic_entry = MODULE.to_model_entry(
            {"id": "claude-opus-4-6", "api": "anthropic-messages"},
            MODULE.DEFAULT_CONTEXT,
        )

        self.assertNotIn("compat", openai_entry)
        self.assertEqual(anthropic_entry["compat"]["forceAdaptiveThinking"], True)

    def test_catalog_searches_workspace_ancestors_for_any_supported_catalog(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp) / "workspace"
            nested = workspace / "extensions" / "statusline"
            providers = workspace / "node_modules" / "pi-ai" / "dist" / "providers"
            nested.mkdir(parents=True)
            providers.mkdir(parents=True)
            (workspace / ".git").mkdir()
            (providers / "anthropic.models.js").write_text(
                "export const ANTHROPIC_MODELS = {};\n", encoding="utf-8"
            )
            with patch.object(MODULE, "_find_active_pi_ai_provider_dir", return_value=None), patch.object(
                MODULE, "_catalog_search_roots", return_value=[workspace]
            ), patch.object(Path, "cwd", return_value=nested):
                self.assertEqual(MODULE._find_pi_ai_provider_dir(), providers)

    def test_anthropic_models_fetch_falls_back_from_v1_path(self):
        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def read(self):
                return b'{"data":[{"id":"claude-fable-5"}]}'

        class NotFound(Exception):
            code = 404

            def read(self):
                return b""

        first_error = NotFound("not found")
        with patch.object(MODULE.urllib.error, "HTTPError", NotFound), patch.object(
            MODULE.urllib.request,
            "urlopen",
            side_effect=[first_error, Response()],
        ) as urlopen:
            models = MODULE.fetch_models(
                "https://proxy.example/v1", "test-key", 1, "anthropic-messages"
            )

        self.assertEqual(models, [{"id": "claude-fable-5"}])
        self.assertEqual(urlopen.call_args_list[0].args[0].full_url, "https://proxy.example/v1/models")
        self.assertEqual(urlopen.call_args_list[1].args[0].full_url, "https://proxy.example/models")


if __name__ == "__main__":
    unittest.main()
