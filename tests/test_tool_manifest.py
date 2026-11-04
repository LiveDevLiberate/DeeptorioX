import importlib.util
import json
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent


def load_generator():
    spec = importlib.util.spec_from_file_location(
        "generate_tool_manifest", ROOT / "scripts" / "generate-tool-manifest.py"
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class ToolManifestTests(unittest.TestCase):
    def test_checked_in_manifest_matches_generated_source(self):
        generator = load_generator()
        expected = generator.render(generator.build_manifest())
        actual = (ROOT / "public" / "tool-manifest.json").read_text(encoding="utf-8")
        self.assertEqual(
            actual,
            expected,
            "public/tool-manifest.json is stale; run `npm run tools:manifest`",
        )

    def test_manifest_lists_client_cli_and_endpoints(self):
        manifest = json.loads((ROOT / "public" / "tool-manifest.json").read_text(encoding="utf-8"))
        methods = {item["name"]: item for item in manifest["client_methods"]}
        self.assertIn("build_mining_outpost", methods)
        self.assertIn("write_state", methods)
        self.assertTrue(methods["build_mining_outpost"]["description"])
        self.assertIn("build_mining_outpost", methods["build_mining_outpost"]["signature"])
        cli = {item["command"] for item in manifest["cli_commands"]}
        self.assertIn("build-mining-outpost", cli)
        self.assertIn("tools", cli)
        endpoints = {(item["method"], item["path"]) for item in manifest["manager_endpoints"]}
        self.assertIn(("GET", "/api/agent/tools"), endpoints)
        self.assertIn(("POST", "/api/agent/act/build"), endpoints)


if __name__ == "__main__":
    unittest.main()
