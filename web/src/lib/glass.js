// Liquid-glass refraction as a Svelte action: `<button class="glass" use:glass>`.
//
// Ports the technique from samasante/liquid-glass: generate a per-size rounded-rect LENS displacement
// map — clear/identity in the centre, refraction ramping smoothly across a ring at the rounded rim —
// encode the X/Y bend in the red/green channels, then aim the element's backdrop-filter at an
// feDisplacementMap that reads it. A light 3-pass RGB split adds the subtle chromatic fringe at the
// rim. The bend direction is RADIAL (toward the lens centre), not the SDF normal — radial stays smooth
// across rounded corners, where per-pixel normals tear into rainbow noise.
//
// Only Chromium/WebView2 refracts the LIVE backdrop via url() in backdrop-filter — which is what this
// app runs in (Tauri). Other engines drop the url() and keep the plain CSS .glass frost as fallback.

let uid = 0;

const smoothstep = (a, b, t) => { t = Math.max(0, Math.min(1, (t - a) / (b - a))); return t * t * (3 - 2 * t); };
// signed distance to a rounded rect centred at origin, half-size (hw,hh), corner radius r. <0 inside.
const sdf = (x, y, hw, hh, r) => {
  const qx = Math.abs(x) - hw + r, qy = Math.abs(y) - hh + r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
};

const DEFAULTS = {
  radius: null,        // corner radius px; null = pill (full corner)
  depth: 0.4,          // width of the refraction ring as a fraction of the short side
  strength: 0.55,      // peak inward bend at the rim as a fraction of the ring width (~0.3–0.8)
  curvature: 0.45,     // convex dome: gentle magnification across the whole interior (0 = flat lens)
  dispersion: 3,       // chromatic aberration: extra px of bend on red vs blue at the rim (0 = off)
  blur: 0.5, saturate: 1.2, brightness: 1.02,  // frost applied to the refracted backdrop (keep light = clear glass)
};

export function glass(node, opts = {}) {
  let o = { ...DEFAULTS, ...opts };
  const id = 'glass-' + uid++;
  let svgEl = null;

  const mount = (passes) => {
    const tmp = document.createElement('div');
    tmp.innerHTML = `<svg aria-hidden="true" style="position:absolute;width:0;height:0;pointer-events:none">` +
      `<filter id="${id}" color-interpolation-filters="sRGB" x="-30%" y="-30%" width="160%" height="160%">${passes}</filter></svg>`;
    const next = tmp.firstElementChild;
    if (svgEl) svgEl.replaceWith(next); else document.body.appendChild(next);
    svgEl = next;
  };

  const build = () => {
    const w = node.clientWidth | 0, h = node.clientHeight | 0;
    if (!w || !h) return;
    const hw = w / 2, hh = h / 2, short = Math.min(w, h);
    const r = o.radius == null ? short / 2 : o.radius;
    const band = short * o.depth;          // the refraction ring reaches this far in from the rim
    const rimPx = band * o.strength;       // peak bend at the rim (kept small => no smear)
    const peak = rimPx * (1 + o.curvature) || 1;  // total max bend (rim + dome), used to normalise
    if (peak < 0.5) return;

    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(w, h), data = img.data;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const px = x - hw + 0.5, py = y - hh + 0.5;
      const dist = sdf(px, py, hw, hh, r);
      const t = smoothstep(-band, 0, dist);    // 0 in the clear centre -> 1 at the rim
      const rim = t * t * rimPx;               // edge refraction ring
      // convex dome: magnify the interior, fading out into the rim ring so they don't stack
      const dome = o.curvature * Math.min(1, Math.hypot(px, py) / (short / 2)) * (1 - t) * rimPx;
      const m = rim + dome;
      const L = Math.hypot(px, py) || 1;       // radial direction (toward centre) — smooth at corners
      const dx = -(px / L) * m, dy = -(py / L) * m;
      const i = (y * w + x) * 4;
      data[i]     = 128 + Math.max(-127, Math.min(127, (dx / peak) * 127)); // R = X bend
      data[i + 1] = 128 + Math.max(-127, Math.min(127, (dy / peak) * 127)); // G = Y bend
      data[i + 2] = 128;                                                    // B = neutral
      data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const url = cv.toDataURL();
    const S = peak * 2;                       // feDisplacementMap scale: shift = S*(C/255-0.5)

    // blur the map a touch -> smooth transitions, no 8-bit banding in the fringe
    const head = `<feImage href="${url}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" result="raw"/>` +
      `<feGaussianBlur in="raw" stdDeviation="0.8" result="map"/>`;
    let passes;
    if (o.dispersion > 0) {
      const pass = (scale, mat, res) =>
        `<feDisplacementMap in="SourceGraphic" in2="map" scale="${scale}" xChannelSelector="R" yChannelSelector="G" result="${res}d"/>` +
        `<feColorMatrix in="${res}d" type="matrix" values="${mat}" result="${res}"/>`;
      passes = head +
        pass(S + o.dispersion, '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0', 'r') +
        pass(S,                '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0', 'g') +
        pass(S - o.dispersion, '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0', 'b') +
        `<feBlend in="r" in2="g" mode="screen" result="rg"/>` +
        `<feBlend in="rg" in2="b" mode="screen"/>`;
    } else {
      passes = head +
        `<feDisplacementMap in="SourceGraphic" in2="map" scale="${S}" xChannelSelector="R" yChannelSelector="G"/>`;
    }
    mount(passes);
    node.style.backdropFilter = `url(#${id}) blur(${o.blur}px) saturate(${o.saturate}) brightness(${o.brightness})`;
  };

  build();
  const ro = new ResizeObserver(build);
  ro.observe(node);

  return {
    update(next = {}) { o = { ...DEFAULTS, ...next }; build(); },
    destroy() { ro.disconnect(); svgEl?.remove(); node.style.backdropFilter = ''; },
  };
}

// ponytail: lens map regenerates on every resize, fine for a handful of glass elements. If you ever
// glass dozens of live-resizing nodes, debounce build() or cache maps by `${w}x${h}x${r}`.
