"""Extracts selected figures from the project report PDF into assets/img/project (needs PyMuPDF + Pillow).
Usage: python tools/build_project_figs.py <report.pdf>"""
import io, os
import fitz
from PIL import Image

import sys
PDF = sys.argv[1]
DST = os.path.join(os.path.dirname(__file__), "..", "assets", "img", "project")
os.makedirs(DST, exist_ok=True)
# (page, image index on page) -> output name   (page numbers are 1-based PDF pages)
PICKS = {
    (19, 0): "platforms", (27, 0): "rgator", (24, 0): "sensor_mount", (26, 0): "fusion_rgator",
    (25, 1): "husky_tf", (30, 0): "test_course", (35, 0): "patchwork_patches", (35, 1): "patchwork",
    (36, 0): "patchworkpp", (37, 0): "gndnet", (37, 1): "squeezesegv3",
    (41, 0): "pothole_small", (41, 1): "pothole_large", (44, 0): "scanline_model",
    (49, 0): "neg_obstacle_photo", (57, 0): "raw_cloud", (57, 1): "fused_cloud",
    (62, 0): "elevation_jackal", (63, 0): "voxel_rgator", (64, 0): "multilayer_map", (65, 0): "elevation_husky",
    (59, 0): "costmap_1", (59, 1): "costmap_2", (59, 2): "costmap_3",
}
doc = fitz.open(PDF)
for (page, k), name in PICKS.items():
    xref = doc[page - 1].get_images(full=True)[k][0]
    pix = fitz.Pixmap(doc, xref)
    if pix.n - pix.alpha > 3:
        pix = fitz.Pixmap(fitz.csRGB, pix)
    im = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
    im.thumbnail((1400, 1100))
    im.save(os.path.join(DST, name + ".jpg"), quality=84)
    print(name, im.size)
