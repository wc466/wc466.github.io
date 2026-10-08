"""
Builds the web assets (point clouds + cost-map stage images) for the portfolio site
from the original research data.

The negative-obstacle pipeline below is a faithful CPU port of
Pointcloud_ICP/negative_obstacle_2D_cost_map_optimized.py (the original fills empty
elevation cells with a numba CUDA nearest-neighbour kernel; here a KD-tree does the same).
The registration step mirrors Pointcloud_ICP/ICP_open3d_multiple_frames.py.

Usage:  python tools/build_assets.py
"""
import glob
import json
import os
import re

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import open3d as o3d
from scipy.interpolate import griddata
from scipy.ndimage import binary_dilation, binary_erosion
from scipy.spatial import cKDTree

ICP_ROOT = "C:/Pointcloud_ICP"
CS543_ROOT = "C:/CS_543_repo"
SITE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(SITE, "assets", "data")
IMG = os.path.join(SITE, "assets", "img")
os.makedirs(OUT, exist_ok=True)
os.makedirs(IMG, exist_ok=True)

o3d.utility.set_verbosity_level(o3d.utility.VerbosityLevel.Error)
rng = np.random.default_rng(0)


# ---------------------------------------------------------------- helpers
def save_cloud(name, pts, labels=None, max_pts=None):
    """Quantised (1 cm, int16) xyz + optional uint8 labels -> <name>.bin, returns meta."""
    pts = np.asarray(pts, dtype=np.float64)
    if max_pts and len(pts) > max_pts:
        idx = rng.choice(len(pts), max_pts, replace=False)
        idx.sort()
        pts = pts[idx]
        labels = None if labels is None else np.asarray(labels)[idx]
    q = np.clip(np.round(pts * 100), -32767, 32767).astype("<i2")
    with open(os.path.join(OUT, name + ".bin"), "wb") as f:
        f.write(q.tobytes())
        if labels is not None:
            f.write(np.asarray(labels, dtype=np.uint8).tobytes())
    return {"file": f"assets/data/{name}.bin", "count": int(len(pts)),
            "labels": labels is not None}


def read(path):
    return np.asarray(o3d.io.read_point_cloud(path).points)


def sensor_rotation():
    # Same mounting-tilt correction as load_point_clouds() in ICP_open3d_multiple_frames.py
    ay, ax = np.deg2rad(15), np.deg2rad(-0.5)
    ry = np.array([[np.cos(ay), 0, np.sin(ay)], [0, 1, 0], [-np.sin(ay), 0, np.cos(ay)]])
    rx = np.array([[1, 0, 0], [0, np.cos(ax), -np.sin(ax)], [0, np.sin(ax), np.cos(ax)]])
    return rx @ ry


# ---------------------------------------------------------------- 1. multi-frame ICP
ICP_RUNS = [  # 5-scan windows, as in the original sliding-window stacker
    {"start": 66, "title": "Holes in view"},
    {"start": 74, "title": "Fastest motion"},
    {"start": 58, "title": "Approach"},
]


def wall_x(p):
    """Median range to the building wall straight ahead: an independent check on ICP's motion."""
    w = p[(np.abs(p[:, 1]) < 2) & (p[:, 2] > -1) & (p[:, 2] < 1) & (p[:, 0] > 3) & (p[:, 0] < 25)]
    return float(np.median(w[:, 0]))


def register_window(ids):
    """Pose-graph registration exactly as in ICP_open3d_multiple_frames.py; returns raw clouds +
    poses expressed in the frame of the NEWEST scan (how a vehicle stacks its recent history)."""
    frames_dir = f"{ICP_ROOT}/R_gator_3_neg_obs_2m_s_pcd/0_118"
    R = sensor_rotation()
    voxel = 1.0
    coarse, fine = voxel * 15, voxel * 1.5
    full, down = [], []
    for i in ids:
        p = read(f"{frames_dir}/pcd_out_{i:06d}.pcd")
        p = p[np.linalg.norm(p, axis=1) > 0.5]          # drop zero returns
        p = p @ R.T
        pc = o3d.geometry.PointCloud(o3d.utility.Vector3dVector(p))
        d = pc.voxel_down_sample(voxel)
        d.estimate_normals()
        full.append(p)
        down.append(d)

    reg = o3d.pipelines.registration
    pg = reg.PoseGraph()
    odom = np.eye(4)
    pg.nodes.append(reg.PoseGraphNode(odom))
    for s in range(len(down)):
        for t in range(s + 1, len(down)):
            c = reg.registration_icp(down[s], down[t], coarse, np.eye(4),
                                     reg.TransformationEstimationPointToPlane())
            f_ = reg.registration_icp(down[s], down[t], fine, c.transformation,
                                      reg.TransformationEstimationPointToPlane())
            info = reg.get_information_matrix_from_point_clouds(down[s], down[t], fine,
                                                                 f_.transformation)
            if t == s + 1:
                odom = f_.transformation @ odom
                pg.nodes.append(reg.PoseGraphNode(np.linalg.inv(odom)))
                pg.edges.append(reg.PoseGraphEdge(s, t, f_.transformation, info, uncertain=False))
            else:
                pg.edges.append(reg.PoseGraphEdge(s, t, f_.transformation, info, uncertain=True))
    reg.global_optimization(pg, reg.GlobalOptimizationLevenbergMarquardt(),
                            reg.GlobalOptimizationConvergenceCriteria(),
                            reg.GlobalOptimizationOption(max_correspondence_distance=fine,
                                                         edge_prune_threshold=0.25,
                                                         reference_node=0))
    poses = [np.asarray(n.pose) for n in pg.nodes]
    last_inv = np.linalg.inv(poses[-1])
    return full, [last_inv @ T for T in poses]


def build_icp(manifest):
    runs = []
    for ri, run in enumerate(ICP_RUNS):
        ids = list(range(run["start"], run["start"] + 5))
        full, poses = register_window(ids)
        frames, roi_counts = [], []
        for k, (p, T) in enumerate(zip(full, poses)):
            aligned = p @ T[:3, :3].T + T[:3, 3]
            keep = (aligned[:, 0] > -20) & (aligned[:, 0] < 30) & (np.abs(aligned[:, 1]) < 20) & (aligned[:, 2] < 4)
            roi = ((aligned[:, 2] >= -2.5) & (aligned[:, 2] <= -1.8) & (aligned[:, 0] >= 2.75) &
                   (aligned[:, 0] <= 9) & (np.abs(aligned[:, 1]) <= 5))
            roi_counts.append(int(roi.sum()))
            meta = save_cloud(f"icp_r{ri}_{k}", p[keep], max_pts=35000)
            meta["pose"] = T.flatten().tolist()  # row-major 4x4, scan k -> newest scan
            meta["frame"] = ids[k]
            frames.append(meta)
        # independent check: per-step forward motion from ICP vs from the wall range
        icp_dx = np.diff([T[0, 3] for T in poses])
        wall_dx = -np.diff([wall_x(p) for p in full])
        err = float(np.mean(np.abs(icp_dx - wall_dx)))
        travel = float(np.linalg.norm(poses[0][:3, 3]))
        print(f"ICP run {ids[0]}-{ids[-1]}: travel {travel:.3f} m, |icp - wall| = {err*100:.1f} cm, "
              f"roi {roi_counts}")
        runs.append({**run, "frames": frames, "roi_counts": roi_counts, "travel": travel,
                     "wall_err": err})
    manifest["icp"] = {"runs": runs, "roi": [2.75, 9, -5, 5, -2.5, -1.8]}


# ---------------------------------------------------------------- 2. negative obstacle cost map
def load_filtered(path):
    pc = o3d.io.read_point_cloud(path, remove_nan_points=True, remove_infinite_points=True)
    _, ind = pc.remove_statistical_outlier(nb_neighbors=15, std_ratio=2.0)
    return np.asarray(pc.select_by_index(ind).points).copy()


def cost_map_pipeline(points, grid=0.05, z_shift=1.9, contour_res=2.0, thr=0.12,
                      below_region=8):
    pts = points.copy()
    # raw density histogram (occlusion source)
    xe = np.arange(pts[:, 0].min(), pts[:, 0].max(), grid)
    ye = np.arange(pts[:, 1].min(), pts[:, 1].max(), grid)
    hist, xe, ye = np.histogram2d(pts[:, 0], pts[:, 1], bins=[xe, ye])

    # ---- low elevation map
    pts[:, 2] += z_shift
    xb = np.arange(pts[:, 0].min(), pts[:, 0].max() + grid, grid)
    yb = np.arange(pts[:, 1].min(), pts[:, 1].max() + grid, grid)
    xbc = np.arange(pts[:, 0].min(), pts[:, 0].max() + contour_res, contour_res)
    ybc = np.arange(pts[:, 1].min(), pts[:, 1].max() + contour_res, contour_res)

    cnt, _, _ = np.histogram2d(pts[:, 0], pts[:, 1], bins=[xb, yb])
    sz, _, _ = np.histogram2d(pts[:, 0], pts[:, 1], bins=[xb, yb], weights=pts[:, 2])
    avg = np.divide(sz, cnt, out=np.zeros_like(sz), where=cnt != 0).T
    cntc, _, _ = np.histogram2d(pts[:, 0], pts[:, 1], bins=[xbc, ybc])
    szc, _, _ = np.histogram2d(pts[:, 0], pts[:, 1], bins=[xbc, ybc], weights=pts[:, 2])
    avgc = np.divide(szc, cntc, out=np.zeros_like(szc), where=cntc != 0).T

    xc = (xb[:-1] + xb[1:]) / 2
    yc = (yb[:-1] + yb[1:]) / 2
    X, Y = np.meshgrid(xc, yc)
    xy = np.vstack([X.ravel(), Y.ravel()]).T
    z = avg.ravel().copy()
    nonempty = z != 0
    # nearest-neighbour fill (CPU equivalent of linear_interpolation_gpu)
    _, nn = cKDTree(xy[nonempty]).query(xy[~nonempty])
    z[~nonempty] = z[nonempty][nn]
    fine_elev = z.reshape(avg.shape)

    Xh, Yh = np.meshgrid(xb[1:], yb[1:])
    Xc, Yc = np.meshgrid(xbc[:-1], ybc[:-1])
    coarse = griddata(np.vstack([Xc.ravel(), Yc.ravel()]).T, avgc.ravel(), (Xh, Yh),
                      method="cubic")
    disc = fine_elev - coarse
    with np.errstate(invalid="ignore"):
        low_mask = np.abs(disc) > thr

    cost = np.full(low_mask.shape, 1)
    cost[low_mask] = 1500
    cost = np.rot90(cost, k=1, axes=(1, 0))[1:, 1:]

    # ---- occlusion (empty cells) behind the far wall
    occl = np.rot90(hist.T, k=1, axes=(1, 0)).copy()
    occl[occl != 0] = -1
    h = min(cost.shape[0], occl.shape[0])
    w = min(cost.shape[1], occl.shape[1])
    cost, occl = cost[:h, :w].copy(), occl[:h, :w]
    wall = np.argwhere(cost >= 150)
    shadow = np.zeros_like(cost, dtype=bool)
    if len(wall):
        ii, jj = wall.T
        for off in range(1, below_region + 1):
            bi = ii - off
            ok = (bi >= 0) & (bi < h)
            vb, vj = bi[ok], jj[ok]
            m = occl[vb, vj] == 0
            cost[vb[m], vj[m]] += 100
            occl[vb[m], vj[m]] = 100
            shadow[vb[m], vj[m]] = True

    hv = 200
    cost[cost >= 100] = hv
    cost[cost < 100] = 1
    hmask = cost == hv
    isolated = hmask & ~binary_erosion(hmask, structure=np.ones((2, 2)))
    filt = cost.copy()
    filt[isolated] = 0
    expanded = filt.copy()
    expanded[binary_dilation(filt >= hv, iterations=2)] = hv
    final = expanded == hv

    def disp(a):  # array rows=x ascending -> image (top = far, left = +y)
        return np.flipud(a)

    stages = {
        "density": disp(np.rot90(hist.T, k=1, axes=(1, 0))[:h, :w]),
        "fine": disp(np.rot90(fine_elev, k=1, axes=(1, 0))[1:, 1:][:h, :w]),
        "coarse": disp(np.rot90(coarse, k=1, axes=(1, 0))[1:, 1:][:h, :w]),
        "disc": disp(np.rot90(disc, k=1, axes=(1, 0))[1:, 1:][:h, :w]),
        "occl": disp(np.where(occl[:h, :w] == 0, 0, 1) + 2 * shadow),
        "final": disp(final.astype(np.uint8)),
    }
    extent = {"xmin": float(points[:, 0].min()), "xmax": float(points[:, 0].min() + h * grid),
              "ymin": float(points[:, 1].min()), "ymax": float(points[:, 1].min() + w * grid),
              "ny": int(len(yb) - 1)}
    return stages, extent, final


def save_stage_png(path, key, a):
    if key == "density":
        img = plt.cm.inferno(np.clip(np.log1p(a) / np.log1p(60), 0, 1))
        img[a == 0] = (0.04, 0.05, 0.08, 1)
    elif key in ("fine", "coarse"):
        a2 = np.nan_to_num(a, nan=0.0)
        img = plt.cm.viridis(np.clip((a2 + 0.25) / 0.4, 0, 1))
        if key == "coarse":
            img[np.isnan(a)] = (0.04, 0.05, 0.08, 1)
    elif key == "disc":
        a2 = np.nan_to_num(a, nan=0.0)
        img = plt.cm.RdBu_r(np.clip((a2 + 0.3) / 0.6, 0, 1))
        img[np.isnan(a)] = (0.04, 0.05, 0.08, 1)
        hot = np.abs(a2) > 0.12
        img[hot] = (1.0, 0.82, 0.2, 1)
    elif key == "occl":
        pal = np.array([[0.04, 0.05, 0.08, 1],      # empty (no returns)
                        [0.25, 0.30, 0.38, 1],      # observed ground
                        [1.0, 0.55, 0.1, 1],        # (unused)
                        [1.0, 0.55, 0.1, 1]])       # empty cell in shadow of a far wall
        img = pal[a.astype(int)]
    else:
        img = np.zeros(a.shape + (4,))
        img[...] = (0.10, 0.13, 0.17, 1)
        img[a.astype(bool)] = (1.0, 0.27, 0.33, 1)
    plt.imsave(path, img)


def build_cost_maps(manifest):
    files = glob.glob(f"{ICP_ROOT}/R_gator_3_neg_obs_2m_s_pcd/42_stacked/*.pcd")
    files.sort(key=lambda f: int(re.findall(r"stacked_fine_(\d+)_", f)[0]))
    os.makedirs(os.path.join(IMG, "costmap"), exist_ok=True)
    windows = []
    best = (-1, None)
    for wi, f in enumerate(files):
        a, b = map(int, re.findall(r"stacked_fine_(\d+)_(\d+)", f)[0])
        pts = load_filtered(f)
        stages, extent, final = cost_map_pipeline(pts)
        for k, arr in stages.items():
            save_stage_png(os.path.join(IMG, "costmap", f"w{wi:02d}_{k}.png"), k, arr)
        flagged = int(final.sum())
        windows.append({"frames": [a, b], "flagged_cells": flagged,
                        "points": int(len(pts)), **extent,
                        "shape": list(stages["final"].shape)})
        print(f"window {a}-{b}: {len(pts)} pts, flagged {flagged} cells")
        if flagged > best[0]:
            best = (flagged, wi)

    # 3D view of the window with the most flagged area, points labelled by cost map
    wi = best[1]
    pts = load_filtered(files[wi])
    _, extent, final = cost_map_pipeline(pts)
    # final[i, j] = elevation cell (x index i + 1, y index ny - 2 - j): rot90 clockwise, then [1:, 1:]
    h, w = final.shape
    ix = ((pts[:, 0] - extent["xmin"]) / 0.05).astype(int)
    iy = ((pts[:, 1] - extent["ymin"]) / 0.05).astype(int)
    row, col = ix - 1, extent["ny"] - 2 - iy
    ok = (row >= 0) & (row < h) & (col >= 0) & (col < w)
    lab = np.zeros(len(pts), np.uint8)
    lab[ok] = final[row[ok], col[ok]]
    meta = save_cloud("negobs_stacked", pts, lab, max_pts=90000)
    manifest["costmap"] = {"windows": windows, "best": wi, "cloud": meta}


def build_negobs_scene(manifest):
    """Single raw frame + the 5-frame stacked/segmented crop for scene context."""
    p = read(f"{ICP_ROOT}/R_gator_3_neg_obs_2m_s_pcd/0_118/pcd_out_000066.pcd")
    p = p[np.linalg.norm(p, axis=1) > 0.5] @ sensor_rotation().T
    keep = (np.abs(p[:, 0]) < 40) & (np.abs(p[:, 1]) < 40) & (p[:, 2] < 6)
    manifest["scene"] = save_cloud("raw_frame_66", p[keep], max_pts=80000)
    # full-range copy for the in-browser Patchwork-style demo (segmentation runs client-side)
    manifest["patchwork"] = save_cloud("pw_frame_66", p[np.hypot(p[:, 0], p[:, 1]) < 80])


# ---------------------------------------------------------------- 3. ground segmentation
def align_to(src, dst):
    """Rigid transform taking src into dst's frame: yaw grid search + point-to-point ICP.
    (GndNet writes its output in a different sensor convention than my pipeline.)"""
    def pc(p):
        return o3d.geometry.PointCloud(o3d.utility.Vector3dVector(p)).voxel_down_sample(0.3)
    S, D = pc(src), pc(dst)
    dz = np.median(dst[:, 2]) - np.median(src[:, 2])
    best = None
    for yaw in np.deg2rad(np.arange(0, 360, 5)):
        T = np.eye(4)
        T[:2, :2] = [[np.cos(yaw), -np.sin(yaw)], [np.sin(yaw), np.cos(yaw)]]
        T[2, 3] = dz
        r = o3d.pipelines.registration.registration_icp(
            S, D, 1.5, T, o3d.pipelines.registration.TransformationEstimationPointToPoint())
        if best is None or r.fitness > best.fitness or (
                r.fitness == best.fitness and r.inlier_rmse < best.inlier_rmse):
            best = r
    r = o3d.pipelines.registration.registration_icp(
        S, D, 0.4, best.transformation,
        o3d.pipelines.registration.TransformationEstimationPointToPoint())
    print(f"GndNet -> v3 alignment: fitness {r.fitness:.3f}, rmse {r.inlier_rmse:.3f}")
    return r.transformation


def build_ground(manifest):
    out, clouds = {}, {}
    v3_all = np.vstack([read(f"{CS543_ROOT}/V3_ground_points_800.pcd"),
                        read(f"{CS543_ROOT}/V3_non_ground_points_800.pcd")])
    for name, g, ng in [("v3", "V3_ground_points_800.pcd", "V3_non_ground_points_800.pcd"),
                        ("gndnet", "GndNet_ground_indices_800.pcd",
                         "GndNet_nonground_indices_800.pcd")]:
        G, N = read(f"{CS543_ROOT}/{g}"), read(f"{CS543_ROOT}/{ng}")
        pts = np.vstack([G, N])
        lab = np.r_[np.ones(len(G)), np.zeros(len(N))]
        if name == "gndnet":
            T = align_to(pts, v3_all)
            pts = pts @ T[:3, :3].T + T[:3, 3]
        keep = (np.abs(pts[:, 0]) < 50) & (np.abs(pts[:, 1]) < 50)
        meta = save_cloud(f"ground_{name}", pts[keep], lab[keep], max_pts=110000)
        meta["ground"] = int(len(G))
        meta["nonground"] = int(len(N))
        out[name] = meta
        print(name, meta)
        clouds[name] = (pts[keep], lab[keep])

    # Per-point disagreement on the v3 cloud (nearest GndNet point within 0.3 m):
    # 0 both non-ground, 1 both ground, 2 only v3 says ground, 3 only GndNet says ground, 4 no match
    (vp, vl), (gp, gl) = clouds["v3"], clouds["gndnet"]
    dist, nn = cKDTree(gp).query(vp)
    gl_v = gl[nn]
    diff = np.where(vl == gl_v, vl, np.where(vl == 1, 2, 3)).astype(np.uint8)
    diff[dist > 0.3] = 4
    meta = save_cloud("ground_diff", vp, diff, max_pts=110000)
    matched = diff < 4
    meta["agree"] = float(np.mean(diff[matched] < 2))
    meta["only_v3"] = int(np.sum(diff == 2))
    meta["only_gndnet"] = int(np.sum(diff == 3))
    print("diff", meta)
    manifest["ground_diff"] = meta
    manifest["ground"] = out


# ---------------------------------------------------------------- 4. Patchwork (catkin_ws) on the Gator
def build_patchwork_seq(manifest):
    from patchwork_port import P, estimate_ground, node_input_transform, zone_geometry
    frames_dir = f"{ICP_ROOT}/R_gator_3_neg_obs_2m_s_pcd/0_118"
    seq = []
    for k, f in enumerate(range(60, 97, 3)):
        p = read(f"{frames_dir}/pcd_out_{f:06d}.pcd")
        p = node_input_transform(p[np.linalg.norm(p, axis=1) > 0.5])
        lab, status = estimate_ground(p)
        proc = lab != 255
        keep = np.hypot(p[:, 0], p[:, 1]) < 45
        meta = save_cloud(f"pwseq_{k}", p[keep], lab[keep], max_pts=32000)
        meta.update(frame=f, status=status.tolist(),
                    ground_share=float(np.mean(lab[proc] == 1)))
        seq.append(meta)
        print(f"patchwork frame {f}: ground {meta['ground_share']:.2f}")
    mins, ring_sizes, sector_sizes = zone_geometry()
    manifest["pwseq"] = {"frames": seq, "mins": mins, "ring_sizes": ring_sizes,
                         "rings": P["num_rings_each_zone"], "sectors": P["num_sectors_each_zone"],
                         "sensor_height": P["sensor_height"]}


# ---------------------------------------------------------------- 5. traffic cone vs range
def build_cone(manifest):
    from cone_track import track
    files = sorted(glob.glob(f"{ICP_ROOT}/90_fov_cones_fast/pcd_out_*.pcd"))
    out, last = [], None
    for r, n, q in track(files):
        if last is not None and abs(r - last) < 0.05:     # vehicle stopped: skip repeats
            continue
        last = r
        c = q.mean(0)
        rel = np.round((q - [c[0], c[1], q[:, 2].min()]) * 100).astype(int)  # cm, cone base at z=0
        out.append({"range": round(r, 2), "n": n, "pts": rel.flatten().tolist()})
    print(f"cone: {len(out)} distinct ranges, {out[0]['range']} m -> {out[-1]['range']} m")
    manifest["cone"] = out


if __name__ == "__main__":
    manifest = {}
    build_icp(manifest)
    build_negobs_scene(manifest)
    build_cost_maps(manifest)
    build_ground(manifest)
    build_patchwork_seq(manifest)
    build_cone(manifest)
    with open(os.path.join(OUT, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    print("done")
