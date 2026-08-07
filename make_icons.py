"""Regenerate the Addendum.md icon set into public/icons/.

    python make_icons.py          # needs Pillow; not required to run the app

Everything is drawn from the unit-square spec below at high supersampling and
downscaled with LANCZOS, so each raster size is rendered rather than resized
from one master. Small sizes swap to COMPACT geometry and drop text lines,
which turn to mush below 24px. public/icons/icon.svg is the hand-kept vector
twin of FULL - edit both together.
"""
import io, os, struct
from PIL import Image, ImageChops, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public", "icons")
os.makedirs(OUT, exist_ok=True)

SS = 8  # supersample factor

# --- palette (from public/style.css) -------------------------------------
BLUE_TOP    = (61, 124, 247)
BLUE_BOT    = (32, 78, 194)
PAPER       = (255, 255, 255)
FOLD        = (200, 216, 243)
LINE        = (167, 190, 234)
BADGE_TOP   = (247, 163, 61)
BADGE_BOT   = (214, 112, 20)

# --- geometry (unit square, y down) --------------------------------------
# Two sets: the full one, and a compact one for <=24px where thin features and
# the fold shading collapse into mush. Compact grows every element and drops
# the fold highlight, keeping only the silhouette cut.
FULL = dict(
    tile_r=0.215,
    page=(0.230, 0.170, 0.730, 0.828), page_r=0.055,
    fold=0.190, fold_shade=True,
    badge=(0.742, 0.748), badge_r=0.200, gap=0.038,
    arm=0.060, half=0.098,
    line_h=0.054, lines=[(0.400, 0.660), (0.520, 0.660), (0.640, 0.545)],
)
# centre of the page+badge bounding box in FULL, used to re-centre the
# artwork when it is shrunk into a maskable safe zone
CONTENT_CENTRE = (0.586, 0.559)

COMPACT = dict(
    tile_r=0.195,
    page=(0.175, 0.145, 0.700, 0.855), page_r=0.045,
    fold=0.215, fold_shade=False,
    badge=(0.735, 0.735), badge_r=0.258, gap=0.045,
    arm=0.090, half=0.132,
    line_h=0.075, lines=[(0.360, 0.600), (0.520, 0.600)],
)


def vgrad(size, top, bot):
    g = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / max(1, size - 1)
        g.putpixel((0, y), tuple(round(a + (b - a) * t) for a, b in zip(top, bot)))
    return g.resize((size, size), Image.BILINEAR)


def render(px, lines=None, bleed=True, g=None):
    """Draw one icon at `px` logical pixels.

    lines  - how many text lines to draw (None = all in the geometry)
    bleed  - False insets the tile, leaving a maskable safe zone
    """
    g = g or (COMPACT if px <= 24 else FULL)
    S = px * SS
    u = lambda v: v * S

    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    # --- tile ------------------------------------------------------------
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, S - 1, S - 1], radius=u(g["tile_r"]), fill=255)
    img.paste(vgrad(S, BLUE_TOP, BLUE_BOT), (0, 0), mask)

    # --- content: page + badge, on their own layer so it can be scaled
    # into a maskable safe zone independently of the tile ------------------
    page = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(page)
    x0, y0, x1, y1 = [u(v) for v in g["page"]]
    d.rounded_rectangle([x0, y0, x1, y1], radius=u(g["page_r"]), fill=PAPER + (255,))

    f = u(g["fold"])
    d.polygon([(x1 - f, y0 - 1), (x1 + 1, y0 - 1), (x1 + 1, y0 + f)], fill=(0, 0, 0, 0))
    if g["fold_shade"]:
        d.polygon([(x1 - f, y0), (x1 - f, y0 + f), (x1, y0 + f)], fill=FOLD + (255,))

    n = len(g["lines"]) if lines is None else int(lines)
    h = u(g["line_h"])
    for cy, xe in g["lines"][:n]:
        d.rounded_rectangle([x0 + u(0.088), u(cy) - h / 2, u(xe), u(cy) + h / 2],
                            radius=h / 2, fill=LINE + (255,))

    # moat: erase page pixels under the badge plus a ring of clearance
    bx, by = u(g["badge"][0]), u(g["badge"][1])
    mr = u(g["badge_r"] + g["gap"])
    d.ellipse([bx - mr, by - mr, bx + mr, by + mr], fill=(0, 0, 0, 0))

    # --- badge (same layer, so it scales with the page) -------------------
    br = u(g["badge_r"])
    bmask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(bmask).ellipse([bx - br, by - br, bx + br, by + br], fill=255)
    page.paste(vgrad(S, BADGE_TOP, BADGE_BOT), (0, 0), bmask)

    d.rounded_rectangle([bx - u(g["half"]), by - u(g["arm"]) / 2,
                         bx + u(g["half"]), by + u(g["arm"]) / 2],
                        radius=u(g["arm"]) / 2, fill=PAPER + (255,))
    d.rounded_rectangle([bx - u(g["arm"]) / 2, by - u(g["half"]),
                         bx + u(g["arm"]) / 2, by + u(g["half"])],
                        radius=u(g["arm"]) / 2, fill=PAPER + (255,))

    if bleed:
        img.alpha_composite(page)
        # the page and badge both overhang the tile's rounded corners, so the
        # composite gets clipped back to the tile silhouette
        img.putalpha(ImageChops.multiply(img.getchannel("A"), mask))
    else:
        # Maskable: the platform crops to an arbitrary shape inside the middle
        # 80%, so the tile becomes a full-bleed wash and the content shrinks to
        # fit the safe circle, re-centred on the artwork's own bounding box.
        img = vgrad(S, BLUE_TOP, BLUE_BOT).convert("RGBA")
        k = 0.70
        small = page.resize((round(S * k), round(S * k)), Image.LANCZOS)
        cx, cy = CONTENT_CENTRE
        img.alpha_composite(small, (round(S * (0.5 - cx * k)),
                                    round(S * (0.5 - cy * k))))

    return img.resize((px, px), Image.LANCZOS)


def detail_for(px):
    """Lines that survive at this size: none <20, one at 20, two at 24."""
    if px < 20:
        return 0
    if px < 24:
        return 1
    return None


# --- ICO container --------------------------------------------------------
def bmp_frame(im):
    """32bpp bottom-up DIB + empty AND mask, as ICO wants it."""
    w, h = im.size
    px = im.load()
    rows = bytearray()
    for y in range(h - 1, -1, -1):
        for x in range(w):
            r, g, b, a = px[x, y]
            rows += bytes((b, g, r, a))
    stride = ((w + 31) // 32) * 4
    mask = bytes(stride * h)
    hdr = struct.pack("<IiiHHIIiiII", 40, w, h * 2, 1, 32, 0, len(rows) + len(mask),
                      0, 0, 0, 0)
    return hdr + bytes(rows) + mask


def png_frame(im):
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def write_ico(path, images):
    frames = [(im, bmp_frame(im) if im.size[0] <= 48 else png_frame(im))
              for im in images]
    out = struct.pack("<HHH", 0, 1, len(frames))
    offset = 6 + 16 * len(frames)
    for im, data in frames:
        w, h = im.size
        out += struct.pack("<BBBBHHII", w % 256, h % 256, 0, 0, 1, 32,
                           len(data), offset)
        offset += len(data)
    for _, data in frames:
        out += data
    with open(path, "wb") as fh:
        fh.write(out)


ICO_SIZES = [16, 20, 24, 32, 48, 64, 128, 256]
write_ico(os.path.join(OUT, "favicon.ico"),
          [render(s, detail_for(s)) for s in ICO_SIZES])

for s in (16, 32, 48, 192, 512):
    render(s, detail_for(s)).save(os.path.join(OUT, f"icon-{s}.png"), optimize=True)

# apple-touch-icon: iOS rounds it itself and ignores alpha, so the rounded
# corners are flattened onto the tile gradient rather than onto black
_at = vgrad(180, BLUE_TOP, BLUE_BOT).convert("RGBA")
_at.alpha_composite(render(180))
_at.convert("RGB").save(os.path.join(OUT, "apple-touch-icon.png"), optimize=True)

# maskable: safe zone is the inner 80%, so pull the artwork in
render(512, bleed=False).save(os.path.join(OUT, "icon-maskable-512.png"),
                              optimize=True)

print("wrote", sorted(f for f in os.listdir(OUT) if not f.endswith(".py")))
