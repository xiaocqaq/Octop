"""Regenerate mxiao SVG and 2x PNG artwork with CairoSVG, Cairo and Pillow.

Run from any directory: python3 dashboard/scripts/generate-brand-assets.py
Optional design proof: add --proof /tmp/mxiao-brand-proof.png
"""

import argparse
from io import BytesIO
from pathlib import Path
from xml.etree import ElementTree

import cairocffi as cairo
import cairosvg
from PIL import Image, ImageDraw, ImageFont, PngImagePlugin

ROOT = Path(__file__).resolve().parents[1] / "public"
DEFS = """<defs>
  <linearGradient id="brand-red" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#ff0004"/><stop offset=".55" stop-color="#ff2639"/><stop offset="1" stop-color="#ff6976"/></linearGradient>
  <linearGradient id="brand-fold" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#940018" stop-opacity="0"/><stop offset="1" stop-color="#b40022" stop-opacity=".32"/></linearGradient>
  <linearGradient id="brand-trail" x1="0" y1="0" x2="1" y2="0"><stop stop-color="#ff3949"/><stop offset="1" stop-color="#ff8a94" stop-opacity=".08"/></linearGradient>
</defs>"""


def monogram(trails=True):
    # Two broad, rounded ribbons meet at the inset chevron of an uppercase M.
    shape = "M24 124Q18 124 18 118V36Q18 22 29 22Q36 22 43 31L80 75L117 31Q124 22 131 22Q142 22 142 36V118Q142 124 136 124H121Q115 124 115 118V70L86 105Q80 112 74 105L45 70V118Q45 124 39 124Z"
    folds = '<path d="M43 31L80 75L74 105L45 70Z" fill="url(#brand-fold)"/>'
    bars = ""
    if trails:
        bars = '<g fill="url(#brand-trail)">' + "".join(
            f'<rect x="{x}" y="{y}" width="{w}" height="8" rx="4"/>'
            for x, y, w in [(151, 43, 26), (155, 72, 37), (151, 101, 23)]
        ) + "</g>"
    return f'<g data-brand-mark="mxiao-m" data-brand-style="folded-M" fill="url(#brand-red)"><path d="{shape}"/>{folds}{bars}</g>'


def aligned_monogram():
    # Center the visible M on the lowercase x/a/o bodies; the i dot is an ascender.
    # The standalone icon keeps its original proportions.
    scale_y = (128 - 15.6875) / (124 - 22)
    wordmark_center_y = (46.5 + 129) / 2
    mark_center_y = (22 + 124) / 2
    offset_y = wordmark_center_y - mark_center_y * scale_y
    return f'<g data-brand-alignment="visual-center" transform="matrix(1 0 0 {scale_y:.9f} 0 {offset_y:.9f})">{monogram()}</g>'


def outline_wordmark(color):
    # Outline every glyph so phones and servers render the same wordmark.
    ctx = cairo.Context(cairo.ImageSurface(cairo.FORMAT_ARGB32, 1, 1))
    ctx.select_font_face("Lato", cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
    ctx.set_font_size(156)
    cursor, paths = 202.0, []
    for letter in "xiao":
        ctx.new_path()
        ctx.move_to(cursor, 128)
        ctx.text_path(letter)
        commands = []
        for kind, points in ctx.copy_path():
            token = {cairo.PATH_MOVE_TO: "M", cairo.PATH_LINE_TO: "L", cairo.PATH_CURVE_TO: "C", cairo.PATH_CLOSE_PATH: "Z"}[kind]
            commands.append(token + " ".join(f"{n:.3f}".rstrip("0").rstrip(".") for n in points))
        paths.append(f'<path data-letter="{letter}" d="{" ".join(commands)}"/>')
        cursor += ctx.text_extents(letter)[4] - 1.5
    return f'<g data-brand-wordmark="xiao" fill="{color}">{"".join(paths)}</g>'


def svg(width, height, body, title="mxiao"):
    value = f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-labelledby="title"><title id="title">{title}</title>{DEFS}{body}</svg>\n'
    ElementTree.fromstring(value)
    return value


def raster(source, size):
    return Image.open(BytesIO(cairosvg.svg2png(bytestring=source.encode(), output_width=size[0], output_height=size[1]))).convert("RGBA")


def save_png(image, path):
    info = PngImagePlugin.PngInfo()
    info.add_text("Title", "mxiao — folded M monogram")
    image.save(path, pnginfo=info)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--proof", type=Path)
    args = parser.parse_args()
    variants = {}
    for name, color in [("dark", "#1a1c28"), ("white", "#ffffff")]:
        body = aligned_monogram() + outline_wordmark(color)
        source = svg(500, 152, body)
        variants[name] = source
        (ROOT / f"logo_horizontal_{name}.svg").write_text(source)
        (ROOT / f"logo_vertical_{name}.svg").write_text(svg(500, 500, f'<g transform="translate(0 174)">{body}</g>'))
        image = raster(source, (1000, 304))
        save_png(image, ROOT / f"logo_horizontal_{name}.png")
        print(name, image.size, "visible bounds", image.getbbox())
    standalone_body = f'<g transform="translate(-16 -5) scale(1.5)">{monogram(False)}</g>'
    standalone = svg(208, 208, standalone_body, "mxiao folded M monogram")
    (ROOT / "logo_mark.svg").write_text(standalone)
    icon = svg(512, 512, f'<rect width="512" height="512" rx="112" fill="#fffafa"/><g transform="translate(79.2 79.2) scale(1.7)">{standalone_body}</g>', "mxiao folded M app icon")
    (ROOT / "favico.svg").write_text(icon)
    for name, size in [("pwa-192.png", 192), ("pwa-512.png", 512), ("apple-touch-icon.png", 180)]:
        save_png(raster(icon, (size, size)), ROOT / name)
    for name, size in [("octop-mascot-empty.png", (2048, 2048)), ("octop-mascot-peek.webp", (352, 320)), ("octop-mascot-type.webp", (856, 812))]:
        image = raster(standalone, size)
        if name.endswith(".webp"):
            image.save(ROOT / name, lossless=True, quality=100, method=6)
        else:
            save_png(image, ROOT / name)
    if args.proof:
        proof = Image.new("RGBA", (1200, 780), "#f4f5f7")
        draw = ImageDraw.Draw(proof)
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 20)
        draw.rounded_rectangle((32, 32, 1168, 315), radius=24, fill="white")
        proof.alpha_composite(raster(variants["dark"], (850, 258)), (175, 42))
        draw.rounded_rectangle((32, 335, 810, 620), radius=24, fill="#151823")
        proof.alpha_composite(raster(variants["white"], (660, 201)), (90, 378))
        proof.alpha_composite(raster(icon, (244, 244)), (874, 354))
        draw.text((46, 664), "UI sizes / 26 px wordmark + 22 px compact mark", font=font, fill="#616574")
        proof.alpha_composite(raster(variants["dark"], (112, 34)), (46, 710))
        proof.alpha_composite(raster(standalone, (28, 28)), (200, 713))
        proof.convert("RGB").save(args.proof)
        print("proof", args.proof)


if __name__ == "__main__":
    main()
