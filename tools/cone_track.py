"""Tracks the single traffic cone in the 90-deg-FOV 'cones_fast' drive: Patchwork ground removal ->
DBSCAN on non-ground points -> cone-sized cluster nearest the vehicle path. Outputs points-on-cone vs range."""
import glob
import numpy as np
from sklearn.cluster import DBSCAN
from build_assets import read
from patchwork_port import estimate_ground, node_input_transform


def find_cone(p):
    lab, _ = estimate_ground(p)
    sel = (lab == 0) & (np.abs(p[:, 1]) < 3) & (p[:, 0] > 2) & (p[:, 0] < 40)
    ng = p[sel]
    if len(ng) < 5:
        return None
    cl = DBSCAN(eps=0.3, min_samples=3).fit_predict(ng)
    best = None
    for c in set(cl) - {-1}:
        q = ng[cl == c]
        ext = q.max(0) - q.min(0)
        if ext[0] < 0.6 and ext[1] < 0.6 and 0.1 < ext[2] < 1.0 and abs(q[:, 1].mean() + 0.2) < 0.8:
            if best is None or len(q) > len(best):
                best = q
    return best


def track(files):
    out = []
    for f in files:
        p = read(f)
        p = node_input_transform(p[np.linalg.norm(p, axis=1) > 0.5])
        q = find_cone(p)
        if q is not None:
            out.append((float(np.hypot(*q[:, :2].mean(0))), len(q), q))
    return out


if __name__ == "__main__":
    files = sorted(glob.glob("C:/Pointcloud_ICP/90_fov_cones_fast/pcd_out_*.pcd"))
    res = track(files)
    for r, n, _ in res[::10]:
        print(f"{r:6.2f} m  {n:4d} pts")
    print(len(res), "of", len(files), "frames with a cone")
