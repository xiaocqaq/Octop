"""Protect visible branding while keeping authentication identifiers stable."""

from __future__ import annotations

import ast
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class ProductBrandingTests(unittest.TestCase):
    def test_passkey_display_name_keeps_existing_user_handle_namespace(self) -> None:
        tree = ast.parse((ROOT / "src/octop/infra/auth/mfa/webauthn.py").read_text())
        values = {
            target.id: ast.literal_eval(node.value)
            for node in tree.body
            if isinstance(node, ast.Assign)
            for target in node.targets
            if isinstance(target, ast.Name) and target.id in {"RP_NAME", "_USER_HANDLE_NAMESPACE"}
        }
        self.assertEqual(values["RP_NAME"], "mxiao")
        self.assertEqual(values["_USER_HANDLE_NAMESPACE"], b"octop.webauthn.user_handle.v1:")

    def test_api_title_uses_xiao(self) -> None:
        tree = ast.parse((ROOT / "src/octop/api/app.py").read_text())
        titles = [
            ast.literal_eval(keyword.value)
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            for keyword in node.keywords
            if keyword.arg == "title"
        ]
        self.assertEqual(titles, ["mxiao API", "mxiao API"])

    def test_api_description_preserves_protocol_header(self) -> None:
        source = (ROOT / "src/octop/api/openapi_meta.py").read_text()
        self.assertIn("**mxiao**", source)
        self.assertIn("X-Octop-Access-Token", source)
        self.assertNotIn("**Octop**", source)


if __name__ == "__main__":
    unittest.main()
