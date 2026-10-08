"""
Python port of PatchWork<PointT>::estimate_ground() (catkin_ws/src/patchwork/include/patchwork/patchwork.hpp)
with the parameters from the Gator's config/params_ouster128.yaml and the input transform added in
nodes/offline_own_data.cpp (15 deg pitch about y). ATAT is off in that config, so it is not ported.
"""
import numpy as np

# config/params_ouster128.yaml
P = dict(
    sensor_height=1.8, num_iter=3, num_lpr=20, num_min_pts=10, th_seeds=0.3, th_dist=0.125,
    max_r=80.0, min_r=2.7, uprightness_thr=0.707, adaptive_seed_selection_margin=-1.1,
    using_global_elevation=False, global_elevation_threshold=-0.5,
    num_sectors_each_zone=[16, 32, 54, 32], num_rings_each_zone=[2, 4, 4, 4],
    min_ranges_each_zone=[2.7, 12.3625, 22.025, 41.35],
    elevation_thresholds=[0.5, 0.8, 1.0, 1.1], flatness_thresholds=[0.0, 0.000125, 0.000185, 0.000185],
)

NOT_ASSIGNED, FEW_POINTS, UPRIGHT_ENOUGH, FLAT_ENOUGH, TOO_HIGH_ELEVATION, TOO_TILTED, GLOBALLY_TOO_HIGH = -2, -1, 0, 1, 2, 3, 4


def node_input_transform(p):
    """offline_own_data.cpp: rotation about y by +15 deg applied before estimate_ground()."""
    t = np.deg2rad(15)
    R = np.array([[np.cos(t), 0, np.sin(t)], [0, 1, 0], [-np.sin(t), 0, np.cos(t)]])
    return p @ R.T


def zone_geometry(p=P):
    mins = p["min_ranges_each_zone"]
    edges = mins[1:] + [p["max_r"]]
    ring_sizes = [(edges[z] - mins[z]) / p["num_rings_each_zone"][z] for z in range(4)]
    sector_sizes = [2 * np.pi / s for s in p["num_sectors_each_zone"]]
    return mins, ring_sizes, sector_sizes


def estimate_plane(g):
    mean = g.mean(0)
    cov = np.cov((g - mean).T, bias=True)
    U, S, _ = np.linalg.svd(cov)
    n = U[:, 2]
    if n[2] < 0:
        n = -n
    return n, mean, S


def estimate_ground(cloud, p=P):
    """Returns (label per input point: 1 ground / 0 non-ground / 255 not processed,
                status per patch in concentric order)."""
    h = p["sensor_height"]
    label = np.full(len(cloud), 255, np.uint8)
    valid = cloud[:, 2] >= -h - 2.0                                   # error point removal
    r = np.hypot(cloud[:, 0], cloud[:, 1])
    theta = np.arctan2(cloud[:, 1], cloud[:, 0])
    theta = np.where(theta > 0, theta, theta + 2 * np.pi)
    inside = valid & (r <= p["max_r"]) & (r > p["min_r"])

    mins, ring_sizes, sector_sizes = zone_geometry(p)
    zone = np.searchsorted(np.array(mins[1:]), r, side="right")      # r < z2 -> 0, ...
    nr, ns = np.array(p["num_rings_each_zone"]), np.array(p["num_sectors_each_zone"])
    ring = np.minimum(((r - np.array(mins)[zone]) / np.array(ring_sizes)[zone]).astype(int), nr[zone] - 1)
    sector = np.minimum((theta / np.array(sector_sizes)[zone]).astype(int), ns[zone] - 1)

    # patch ids in the same order as patch_indices_ (zone, ring, sector)
    offs = np.concatenate([[0], np.cumsum(nr * ns)])
    pid = offs[zone] + ring * ns[zone] + sector
    pid[~inside] = -1
    n_patches = int(offs[-1])
    status = np.full(n_patches, NOT_ASSIGNED, np.int8)
    ring_offs = np.concatenate([[0], np.cumsum(nr)])
    num_rings_of_interest = len(p["elevation_thresholds"])
    low_margin = -0.1 if h == 0 else p["adaptive_seed_selection_margin"] * h

    order = np.argsort(pid, kind="stable")
    bounds = np.searchsorted(pid[order], np.arange(-1, n_patches + 1))
    for k in range(n_patches):
        idx = order[bounds[k + 1]:bounds[k + 2]]
        if len(idx) == 0:
            continue
        zi = int(np.searchsorted(offs, k, side="right") - 1)
        local = k - offs[zi]
        concentric_idx = ring_offs[zi] + local // ns[zi]
        if len(idx) <= p["num_min_pts"]:
            label[idx] = 1                                             # FEW_POINTS -> ground
            status[k] = FEW_POINTS
            continue
        idx = idx[np.argsort(cloud[idx, 2], kind="stable")]           # region-wise z sort
        pts = cloud[idx]
        # extract_initial_seeds_ (adaptive seed selection only in zone 0)
        init = int(np.sum(pts[:, 2] < low_margin)) if zi == 0 else 0
        # note: the C++ loop breaks at the first point above the margin; z-sorted, so a count is identical
        lpr = pts[init:init + p["num_lpr"], 2]
        lpr_h = lpr.mean() if len(lpr) else 0.0
        ground = pts[pts[:, 2] < lpr_h + p["th_seeds"]]
        # extract_piecewiseground
        for it in range(p["num_iter"]):
            n, mean, S = estimate_plane(ground)
            d = -n @ mean
            res = pts @ n
            mask = res < p["th_dist"] - d
            if it < p["num_iter"] - 1:
                ground = pts[mask]
        # determine_ground_likelihood_estimation_status
        z_vec, z_elev = abs(n[2]), mean[2]
        surface = S.min() / S.sum()
        if z_vec < p["uprightness_thr"]:
            st = TOO_TILTED
        elif concentric_idx < num_rings_of_interest:
            if z_elev > -h + p["elevation_thresholds"][concentric_idx]:
                st = FLAT_ENOUGH if p["flatness_thresholds"][concentric_idx] > surface else TOO_HIGH_ELEVATION
            else:
                st = UPRIGHT_ENOUGH
        else:
            st = GLOBALLY_TOO_HIGH if (p["using_global_elevation"] and z_elev > p["global_elevation_threshold"]) \
                else UPRIGHT_ENOUGH
        status[k] = st
        if st in (UPRIGHT_ENOUGH, FLAT_ENOUGH):
            label[idx] = mask.astype(np.uint8)
        else:
            label[idx] = 0
    return label, status
