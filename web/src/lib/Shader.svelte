<script>
  // Ambient atmosphere as a real fragment shader: domain-warped fbm flowing through the Ink
  // mercury palette (gunmetal -> steel -> silver) over a near-black base. Raw WebGL — no three.js
  // for one quad. `alive` drives motion: frozen liquid metal at rest, flowing while an agent is
  // actually running. Degrades to the CSS background if WebGL is unavailable; always still under
  // reduced-motion.
  let { alive = false } = $props();
  let canvas;

  const FRAG = `precision highp float;
  uniform vec2 u_res; uniform float u_time;
  // gradient (Perlin) noise — value is 0 at every lattice point, so there are no axis-aligned
  // "boxes" the way cheap value noise has. Hash returns a random gradient vector per lattice cell.
  vec2 hash2(vec2 p){ p = vec2(dot(p, vec2(127.1,311.7)), dot(p, vec2(269.5,183.3)));
    return -1.0 + 2.0*fract(sin(p)*43758.5453123); }
  float gnoise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
    return mix(mix(dot(hash2(i+vec2(0.,0.)), f-vec2(0.,0.)),
                   dot(hash2(i+vec2(1.,0.)), f-vec2(1.,0.)), u.x),
               mix(dot(hash2(i+vec2(0.,1.)), f-vec2(0.,1.)),
                   dot(hash2(i+vec2(1.,1.)), f-vec2(1.,1.)), u.x), u.y); }
  // rotate+scale each octave (IQ's trick) so successive octaves never line up on the same axis
  float fbm(vec2 p){ float v=0.,a=.5; mat2 m=mat2(1.6,1.2,-1.2,1.6);
    for(int i=0;i<6;i++){ v+=a*gnoise(p); p=m*p; a*=.5; } return v*0.5+0.5; }
  void main(){
    vec2 uv = gl_FragCoord.xy/u_res.xy;
    vec2 p = (uv-0.5)*vec2(u_res.x/u_res.y,1.0)*3.0;   // higher frequency => fluid, not blocky
    float t = u_time*0.05;
    vec2 q = vec2(fbm(p+vec2(0.0,t)), fbm(p+vec2(5.2,1.3)-t*0.7));
    vec2 r = vec2(fbm(p+2.0*q+vec2(1.7,9.2)+t*0.4), fbm(p+2.0*q+vec2(8.3,2.8)));
    float f = fbm(p+2.0*r);
    vec3 gunmetal=vec3(0.33,0.35,0.40), steel=vec3(0.62,0.65,0.71), silver=vec3(0.93,0.95,0.98);
    vec3 col = mix(gunmetal, steel, smoothstep(0.25,0.7,f));
    col = mix(col, silver, smoothstep(0.6,0.97,r.x));
    float glow = smoothstep(0.05,1.15, uv.x*0.9+uv.y*0.25) * (0.45+0.6*f);
    col *= glow;
    col = vec3(0.016) + col*0.85;
    float vig = smoothstep(1.4,0.3,length(uv-vec2(0.5)));
    col *= mix(0.6,1.0,vig);
    // 1-LSB ordered dither — breaks 8-bit banding in the dark gradient (the "hard lines")
    float d = (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898,78.233)))*43758.545)-0.5)/255.0;
    gl_FragColor = vec4(col+d,1.0);
  }`;
  const VERT = `attribute vec2 a; void main(){ gl_Position = vec4(a,0.0,1.0); }`;

  $effect(() => {
    const run = alive;                          // reactive dep — re-arms the loop on state flips
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false });
    if (!gl) return;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return; // fall back to CSS bg
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const uRes = gl.getUniformLocation(prog, 'u_res');
    const uTime = gl.getUniformLocation(prog, 'u_time');

    const dpr = Math.min(devicePixelRatio || 1, 2);
    const resize = () => {
      const w = canvas.clientWidth * dpr, h = canvas.clientHeight * dpr;
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); }
      gl.uniform2f(uRes, w, h);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const still = reduced || !run;              // one static frame: frozen liquid metal
    let raf, start = null;
    const frame = (ts) => {
      if (start === null) start = ts;
      resize();
      gl.uniform1f(uTime, still ? 8 : (ts - start) / 1000);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (!still) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  });
</script>

<canvas bind:this={canvas} class="shader"></canvas>

<style>.shader { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }</style>
