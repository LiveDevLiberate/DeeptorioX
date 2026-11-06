/* Lightweight pan/zoom PNG viewer; adapted from the MIT-licensed
 * FactorioPreviewToolkit viewer (AntiElitz) and simplified for autorio. */
(function () {
  "use strict";
  const MIN_SCALE = 0.05;
  const MAX_SCALE = 12;
  const ZOOM_STEP = 1.18;

  function createMapViewer(container, source, options = {}) {
    if (!container) throw new Error("map viewer needs a container");
    container.classList.add("map-viewer");
    container.replaceChildren();
    const image = document.createElement("img");
    image.className = "map-viewer-image";
    image.alt = options.alt || "Factorio map preview";
    image.draggable = false;
    container.append(image);
    let scale = 1;
    let offsetX = 0;
    let offsetY = 0;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let naturalWidth = 0;
    let naturalHeight = 0;

    const apply = () => {
      image.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
    };
    const center = () => {
      const rect = container.getBoundingClientRect();
      offsetX = (rect.width - naturalWidth * scale) / 2;
      offsetY = (rect.height - naturalHeight * scale) / 2;
      apply();
    };
    const reset = () => {
      scale = 1;
      center();
    };
    const fit = () => {
      const rect = container.getBoundingClientRect();
      if (!naturalWidth || !rect.width) return;
      scale = Math.min(1, Math.max(MIN_SCALE, (rect.width - 24) / naturalWidth));
      center();
    };
    const setSource = (url) => {
      image.src = url;
    };
    image.addEventListener("load", () => {
      naturalWidth = image.naturalWidth;
      naturalHeight = image.naturalHeight;
      if (options.fit !== false) fit();
      else reset();
    });
    container.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const rect = container.getBoundingClientRect();
        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;
        const beforeX = (mouseX - offsetX) / scale;
        const beforeY = (mouseY - offsetY) / scale;
        scale = Math.min(
          MAX_SCALE,
          Math.max(MIN_SCALE, scale * (event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP)),
        );
        offsetX = mouseX - beforeX * scale;
        offsetY = mouseY - beforeY * scale;
        apply();
      },
      { passive: false },
    );
    container.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      container.setPointerCapture?.(event.pointerId);
      container.classList.add("is-dragging");
    });
    container.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      offsetX += event.clientX - lastX;
      offsetY += event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      apply();
    });
    const endDrag = () => {
      dragging = false;
      container.classList.remove("is-dragging");
    };
    container.addEventListener("pointerup", endDrag);
    container.addEventListener("pointercancel", endDrag);
    container.addEventListener("dblclick", reset);
    container.tabIndex = 0;
    container.addEventListener("keydown", (event) => {
      const pan = event.shiftKey ? 80 : 30;
      if (event.key === "ArrowLeft" || event.key === "a") offsetX += pan;
      else if (event.key === "ArrowRight" || event.key === "d") offsetX -= pan;
      else if (event.key === "ArrowUp" || event.key === "w") offsetY += pan;
      else if (event.key === "ArrowDown" || event.key === "s") offsetY -= pan;
      else if (event.key === "0") reset();
      else return;
      event.preventDefault();
      apply();
    });
    if (source) image.src = source;
    return {
      image,
      setSource,
      reset,
      fit,
      get scale() {
        return scale;
      },
    };
  }

  globalThis.createMapViewer = createMapViewer;
})();
