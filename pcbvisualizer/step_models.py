"""STEP asset inventories and placements; tessellation is deferred to the browser."""

import base64
import hashlib
import math
import os
from pathlib import Path

import numpy as np

MAX_MODEL_BYTES = 32 * 1024 * 1024


def rotation(x=0, y=0, z=0):
    """Column-vector X, then Y, then Z rotation in degrees."""
    x, y, z = map(math.radians, (x, y, z))
    cx, sx, cy, sy, cz, sz = math.cos(x), math.sin(x), math.cos(y), math.sin(y), math.cos(z), math.sin(z)
    return np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]]) @ np.array(
        [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]]) @ np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])


def matrix(linear, position):
    result = np.eye(4)
    result[:3, :3], result[:3, 3] = linear, position
    if not np.isfinite(result).all():
        raise ValueError("Non-finite STEP placement")
    return result.flatten(order="F").tolist()


def asset(data, name, compressed=False):
    if not data or len(data) > MAX_MODEL_BYTES:
        raise ValueError("STEP model exceeds the 32 MB input limit or is empty")
    key = hashlib.sha256(data).hexdigest()
    return key, {"name": name, "data": base64.b64encode(data).decode("ascii"), "compressed": compressed}


def altium_assets(pcb):
    assets, references = {}, {}
    for model, data in pcb.get_embedded_model_entries():
        if not str(model.name).lower().endswith((".step", ".stp")):
            continue
        try:
            key, entry = asset(data, model.name, compressed=True)
        except ValueError:
            continue  # The body retains its fallback and a missing-model notice.
        assets.setdefault(key, entry)
        references.setdefault(str(model.id).upper(), key)
    return assets, references


def altium_placement(body, origin, thickness, bottom):
    unit = 0.0254 / 10000
    linear = rotation(body.model_3d_rotx, body.model_3d_roty, body.model_3d_rotz)
    # Source XY and Z angles are already in board space. Bottom bodies mirror
    # Y (and Z in 3D); applying the component rotation again would double it.
    if bottom:
        linear = np.diag([1, -1, -1]) @ linear
    return matrix(linear, [body.model_2d_x * unit - origin[0], body.model_2d_y * unit - origin[1],
                           (-1 if bottom else 1) * (thickness / 2 + body.model_3d_dz * unit)])


def local_step(reference, directory):
    """Resolve project/environment-relative paths only; never fetch a remote URL."""
    directory = Path(directory) if directory is not None else Path.cwd()
    text = reference.replace("\\", "/").replace("${KIPRJMOD}", str(directory))
    text = os.path.expandvars(text)
    if "$" in text or "://" in text or Path(text).suffix.lower() not in (".step", ".stp"):
        return None
    path = Path(text).expanduser()
    if not path.is_absolute():
        path = directory / path
    try:
        if path.stat().st_size > MAX_MODEL_BYTES:
            return None
        data = path.read_bytes()
        return data if b"ISO-10303-21" in data[:1024] else None
    except OSError:
        return None


def kicad_models(root, directory, origin, thickness):
    from .kicad_common import angle, flag, form, forms, number, point, scalar, value

    def xyz(node, key, default):
        row = form(form(node, key), "xyz")
        return np.array([number(item) for item in row[1:4]]) if len(row) == 4 else np.array(default, dtype=float)

    assets, bodies, missing = {}, [], 0
    for index, footprint in enumerate(forms(root, "footprint") + forms(root, "module")):
        properties = {str(p[1]): str(p[2]) for p in forms(footprint, "property") if len(p) > 2}
        name = properties.get("Reference") or next((str(t[2]) for t in forms(footprint, "fp_text")
                                                    if len(t) > 2 and str(t[1]) == "reference"), "Component")
        x, y = point(footprint)
        bottom = value(footprint, "layer") == "B.Cu"
        fp_rotation = rotation(z=angle(footprint)) @ (np.diag([1, -1, -1]) if bottom else np.eye(3))
        for model_index, model in enumerate(forms(footprint, "model")):
            if len(model) < 2 or flag(model, "hide"):
                continue
            reference = str(model[1])
            if not reference.lower().endswith((".step", ".stp")):
                missing += 1
                continue
            offset = xyz(model, "offset", [0, 0, 0])
            if not form(model, "offset") and form(model, "at"):
                offset = xyz(model, "at", [0, 0, 0]) * 25.4  # KiCad 5 legacy inches.
            position = np.array([x - origin[0], origin[1] - y, (-1 if bottom else 1) * thickness / 2]) + fp_rotation @ offset
            transform = fp_rotation @ rotation(*(-xyz(model, "rotate", [0, 0, 0]))) @ np.diag(xyz(model, "scale", [1, 1, 1]))
            key = "external-" + hashlib.sha256(reference.encode()).hexdigest()
            data = local_step(reference, directory)
            if data:
                key, entry = asset(data, reference)
                assets.setdefault(key, entry)
            else:
                assets.setdefault(key, {"name": reference})
                missing += 1
            bodies.append({"id": f"kc-body-{index}-{model_index}", "name": name, "model": key,
                           "matrix": matrix(transform, position), "color": 0x999999,
                           "opacity": max(0, min(1, scalar(model, "opacity", 1)))})
    return assets, bodies, missing
