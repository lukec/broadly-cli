#!/usr/bin/env python3

import json
import sys


def main() -> int:
    if len(sys.argv) != 3:
        print("Usage: pacmap_reduce.py <input.json> <output.json>", file=sys.stderr)
        return 2

    input_path = sys.argv[1]
    output_path = sys.argv[2]

    try:
        import numpy as np
    except ModuleNotFoundError:
        print("MISSING_MODULE:numpy", file=sys.stderr)
        return 1

    try:
        from pacmap import PaCMAP
    except ModuleNotFoundError:
        print("MISSING_MODULE:pacmap", file=sys.stderr)
        return 1

    with open(input_path, "r", encoding="utf-8") as handle:
        payload = json.load(handle)

    opinion_ids = payload.get("opinionIds", [])
    vectors = payload.get("vectors", [])

    if not isinstance(opinion_ids, list) or not isinstance(vectors, list):
        print("Invalid input payload: opinionIds and vectors are required arrays.", file=sys.stderr)
        return 1

    matrix = np.asarray(vectors, dtype=np.float32)
    if matrix.ndim != 2:
        print("Invalid input payload: vectors must be a 2D matrix.", file=sys.stderr)
        return 1

    if len(opinion_ids) <= 3:
        if len(opinion_ids) == 0:
            points = []
        elif len(opinion_ids) == 1:
            points = [{"opinionId": opinion_ids[0], "x": 0.0, "y": 0.0}]
        elif len(opinion_ids) == 2:
            points = [
                {"opinionId": opinion_ids[0], "x": -0.5, "y": 0.0},
                {"opinionId": opinion_ids[1], "x": 0.5, "y": 0.0},
            ]
        else:
            points = [
                {"opinionId": opinion_ids[0], "x": -0.6, "y": -0.25},
                {"opinionId": opinion_ids[1], "x": 0.6, "y": -0.25},
                {"opinionId": opinion_ids[2], "x": 0.0, "y": 0.55},
            ]

        with open(output_path, "w", encoding="utf-8") as handle:
            json.dump({"points": points}, handle, indent=2)
            handle.write("\n")
        return 0

    reducer = PaCMAP(
        n_components=2,
        n_neighbors=int(payload.get("nNeighbors", 10)),
        MN_ratio=float(payload.get("mnRatio", 0.5)),
        FP_ratio=float(payload.get("fpRatio", 2.0)),
        distance=str(payload.get("distance", "angular")),
        random_state=int(payload.get("randomState", 0)),
        apply_pca=bool(payload.get("applyPca", True)),
        verbose=False,
    )

    coordinates = reducer.fit_transform(matrix)
    points = []
    for opinion_id, coordinate in zip(opinion_ids, coordinates.tolist()):
        points.append(
            {
                "opinionId": opinion_id,
                "x": float(coordinate[0]),
                "y": float(coordinate[1]),
            }
        )

    with open(output_path, "w", encoding="utf-8") as handle:
        json.dump({"points": points}, handle, indent=2)
        handle.write("\n")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
