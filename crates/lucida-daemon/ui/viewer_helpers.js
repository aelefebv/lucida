(function attachViewerHelpers(globalScope) {
  function clampZoom(value) {
    if (!Number.isFinite(value)) {
      return 1.0;
    }
    return Math.max(0.02, Math.min(4096, value));
  }

  function screenDeltaToWorld(dxPx, dyPx, zoom, pixelRatio, rotationDeg) {
    const scale = 1.0 / (zoom * pixelRatio);
    const theta = (rotationDeg * Math.PI) / 180;
    const cosTheta = Math.cos(theta);
    const sinTheta = Math.sin(theta);
    const worldU = (dxPx * cosTheta + dyPx * sinTheta) * scale;
    const worldV = (-dxPx * sinTheta + dyPx * cosTheta) * scale;
    return [worldU, worldV];
  }

  function selectorIndex(selectors, axis) {
    if (!Array.isArray(selectors) || typeof axis !== "string") {
      return null;
    }
    for (const selector of selectors) {
      if (!selector || selector.axis !== axis) {
        continue;
      }
      if (selector.kind === "index" && Number.isInteger(selector.index)) {
        return Number(selector.index);
      }
      if (selector.kind === "range" && Number.isInteger(selector.start)) {
        return Number(selector.start);
      }
      if (selector.kind === "set" && Array.isArray(selector.indices) && selector.indices.length > 0) {
        const first = selector.indices[0];
        if (Number.isInteger(first)) {
          return Number(first);
        }
      }
    }
    return null;
  }

  function selectorsWithReplacement(currentSelectors, axis, nextIndex) {
    const selectors = Array.isArray(currentSelectors)
      ? currentSelectors.filter((selector) => selector && selector.axis !== axis)
      : [];
    selectors.push({
      axis,
      kind: "index",
      index: nextIndex,
      clamp: true,
    });
    return selectors;
  }

  function computePlanePatch(viewState, nextPlane, planeRoles) {
    const roles = planeRoles || {
      xy: ["x", "y", "z"],
      xz: ["x", "z", "y"],
      yz: ["y", "z", "x"],
    };
    const view2d = viewState && viewState.view_2d ? viewState.view_2d : null;
    if (!view2d) {
      throw new Error("view has no 2d state");
    }
    if (!Object.prototype.hasOwnProperty.call(roles, nextPlane)) {
      throw new Error(`unsupported plane: ${nextPlane}`);
    }

    const currentPlane = Object.prototype.hasOwnProperty.call(roles, view2d.plane)
      ? view2d.plane
      : "xy";
    const [currentURole, currentVRole, currentOrthRole] = roles[currentPlane];
    const [targetURole, targetVRole, targetOrthRole] = roles[nextPlane];

    const centerWorld = Array.isArray(view2d.camera?.center_world)
      ? [...view2d.camera.center_world]
      : [0, 0];
    if (centerWorld.length !== 2) {
      centerWorld.splice(0, centerWorld.length, 0, 0);
    }

    const slicePayload = view2d.slice ? JSON.parse(JSON.stringify(view2d.slice)) : {};
    const sliceAxis =
      view2d.slice && typeof view2d.slice.axis === "string" ? view2d.slice.axis : null;
    const currentSliceIndex = Number.isInteger(view2d.slice?.index)
      ? Number(view2d.slice.index)
      : selectorIndex(viewState?.selectors, sliceAxis) ?? 0;

    const roleValues = {
      [currentURole]: Number(centerWorld[0]),
      [currentVRole]: Number(centerWorld[1]),
      [currentOrthRole]: Number(currentSliceIndex),
    };

    const newCenter = [
      Number(roleValues[targetURole] ?? centerWorld[0]),
      Number(roleValues[targetVRole] ?? centerWorld[1]),
    ];

    const nextSlice = {
      ...slicePayload,
      index: Math.round(Number(roleValues[targetOrthRole] ?? 0)),
    };

    return [
      { op: "replace", path: "/view_2d/plane", value: nextPlane },
      { op: "replace", path: "/view_2d/camera/center_world", value: newCenter },
      { op: "replace", path: "/view_2d/slice", value: nextSlice },
    ];
  }

  const api = {
    clampZoom,
    screenDeltaToWorld,
    selectorIndex,
    selectorsWithReplacement,
    computePlanePatch,
  };

  globalScope.LucidaViewerHelpers = api;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
