#!/usr/bin/env python3
"""One-time conversion of brl (github.com/harukaki/brl, Apache-2.0) pre-trained
bridge bidding models from pickled Haiku params to a flat Float32 binary + JSON
manifest consumed by packages/ai/src/model.ts.

Usage:
    python tools/convert_weights.py model-sl.pkl packages/ai/models/sl
    python tools/convert_weights.py model-pretrained-rl-with-fsp.pkl packages/ai/models/rl-fsp

The pickles contain jax Array objects from an older jax; we bypass jax entirely
by intercepting the reconstruction hook and keeping the raw numpy payload.

Output:
    <out>.bin       raw little-endian float32, layers concatenated
    <out>.json      manifest: ordered layers with names, shapes, offsets
"""
import json
import pickle
import sys

import numpy as np


def _reconstruct_array_as_numpy(fun, args, arr_state, aval_state):
    """Stand-in for jax._src.array._reconstruct_array: rebuild the plain
    numpy ndarray and skip jax's aval bookkeeping (which breaks across
    jax versions, e.g. the removed `named_shape` field)."""
    np_value = fun(*args)
    np_value.__setstate__(arr_state)
    return np_value


class NumpyOnlyUnpickler(pickle.Unpickler):
    def find_class(self, module, name):
        if module.startswith("jax") and name == "_reconstruct_array":
            return _reconstruct_array_as_numpy
        return super().find_class(module, name)


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    src, out = sys.argv[1], sys.argv[2]

    with open(src, "rb") as f:
        params = NumpyOnlyUnpickler(f).load()

    # Haiku params: {module_name: {"w": array, "b": array}} — insertion order
    # follows creation order in ActorCritic (linear .. linear_4 for the
    # "DeepMind" model: 4 hidden layers, then actor head, then critic head).
    layers = []
    blobs = []
    offset = 0
    for module, weights in params.items():
        entry = {"name": module}
        for key in ("w", "b"):
            arr = np.asarray(weights[key], dtype=np.float32)
            entry[key] = {"shape": list(arr.shape), "offset": offset, "size": int(arr.size)}
            blobs.append(arr.tobytes(order="C"))
            offset += arr.size
        layers.append(entry)

    with open(out + ".bin", "wb") as f:
        for blob in blobs:
            f.write(blob)

    manifest = {
        "source": src.split("/")[-1],
        "license": "Apache-2.0 (github.com/harukaki/brl)",
        "dtype": "float32",
        "layers": layers,
    }
    with open(out + ".json", "w") as f:
        json.dump(manifest, f, indent=1)

    print(f"wrote {out}.bin ({offset * 4} bytes) and {out}.json")
    for layer in layers:
        print(f"  {layer['name']}: w{layer['w']['shape']} b{layer['b']['shape']}")


if __name__ == "__main__":
    main()
