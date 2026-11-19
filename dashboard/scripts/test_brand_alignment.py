"""Check rendered logo baselines, including transforms and outlined glyphs."""
import unittest
from io import BytesIO
from pathlib import Path
from xml.etree import ElementTree as ET

import cairosvg
from PIL import Image

PUBLIC = Path(__file__).resolve().parents[1] / "public"
VARIANTS = [f"logo_{layout}_{tone}.svg" for layout in ("horizontal", "vertical") for tone in ("dark", "white")]


def rendered_bounds(name, part):
    root = ET.parse(PUBLIC / name).getroot()
    for parent in list(root.iter()):
        for child in list(parent):
            if child.get("data-brand-mark") and part != "mark":
                parent.remove(child)
            elif child.get("data-brand-wordmark") and part == "mark":
                parent.remove(child)
            elif child.get("data-letter") and (
                (part == "body" and child.get("data-letter") not in {"x", "a", "o"})
                or (part != "body" and child.get("data-letter") != part)
            ):
                parent.remove(child)
    data = cairosvg.svg2png(bytestring=ET.tostring(root), scale=2)
    alpha = Image.open(BytesIO(data)).convert("RGBA").getchannel("A")
    return alpha.point(lambda value: 255 if value >= 32 else 0).getbbox()


class BrandAlignmentTest(unittest.TestCase):
    def test_monogram_and_lowercase_wordmark_body_share_a_visual_center(self):
        for name in VARIANTS:
            with self.subTest(name=name):
                mark, word_body = rendered_bounds(name, "mark"), rendered_bounds(name, "body")
                mark_center = (mark[1] + mark[3]) / 2
                word_center = (word_body[1] + word_body[3]) / 2
                self.assertLessEqual(abs(mark_center - word_center), 1, (mark, word_body))
                self.assertGreaterEqual(mark[1], 0, mark)
                self.assertLessEqual(mark[3], (500 if "vertical" in name else 152) * 2, mark)


if __name__ == "__main__":
    unittest.main()
