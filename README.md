# Weihao Cheng — portfolio

A static, single-page portfolio with interactive demos of my LiDAR perception work.
Everything is plain HTML/CSS/JS (three.js from a CDN), so it is ready to host on GitHub Pages.

| Page | What it shows |
|---|---|
| `index.html` | Hero, research summary, and a grid of project cards |
| `negative-obstacles.html` | The problem → scan-line geometry (interactive d = H·W/R + traffic cone vs range) → multi-frame ICP fusion → 6-stage cost-map detector with labelled 3D cloud → results |
| `ground-segmentation.html` | SqueezeSegV3 vs GndNet + disagreement, Patchwork/Patchwork++ figures, live in-browser concentric-zone segmenter, Patchwork on the R-Gator |
| `sensing-stack.html` | Tilted mount, LiDAR–stereo calibration/fusion, EKF odometry (results in progress) |
| `terrain-mapping.html` | 2.5D / 3D / GPU multi-layer elevation maps (results in progress) |
| `pothole-detection.html` | YOLOv8 pothole segmentation (results in progress) |
| `ugv-platform.html` | The R-Gator and the robot fleet (results in progress) |

The four "results in progress" pages are plain HTML (no data build step), so edit them directly.
When you change CSS/JS, bump the `?v=` query on the `<link>`/`<script>` tags in every page so browsers refetch.

## Run locally

```bash
python -m http.server 8000
```

Open http://localhost:8000. A local server is needed because the page fetches binary point clouds.

## Publish on GitHub Pages

1. Create an empty public repo named `wc466.github.io` on GitHub.
2. Push this folder:
   ```bash
   git remote add origin https://github.com/wc466/wc466.github.io.git
   git push -u origin master
   ```
3. In the repo: **Settings → Pages → Build and deployment → Deploy from a branch → `master` / root**.

## Personalise

- `assets/js/main.js` → `CONFIG`: add your LinkedIn URL. An empty value hides the button.
- `index.html`: hero tagline; add a GitHub button to your own profile if you want one.

## Rebuilding the demo data

```bash
python tools/build_assets.py
```

Needs `open3d numpy scipy matplotlib` and the original repos at `C:/Pointcloud_ICP` and `C:/CS_543_repo`.
The script re-runs the registration and cost-map pipelines (a CPU port: the CUDA nearest-neighbour fill is
replaced by a KD-tree query, same result) and writes:

- `assets/data/*.bin` — point clouds as int16 xyz at 1 cm resolution, optionally followed by uint8 labels
- `assets/data/manifest.json` — counts, ICP poses, per-window stats
- `assets/img/costmap/wNN_<stage>.png` — 5 cm/pixel bird's-eye stage images

- `tools/patchwork_port.py` — Python port of Patchwork's `estimate_ground()` with the vehicle's Ouster config
- `tools/cone_track.py` — cone tracking (Patchwork ground removal → DBSCAN → size filter)
- `tools/build_project_figs.py <report.pdf>` — pulls the figures from the project report PDF (needs PyMuPDF)

Total payload is about 15 MB.

## License

All rights reserved, see [LICENSE](LICENSE). Viewing only; please cite if you reference the work.
