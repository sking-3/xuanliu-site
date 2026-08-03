import{n as e,t}from"./index-DEAytPYe.js";var n=e(),r=t(),i=`#version 300 es
in vec2 aPosition;

void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`,a=`#version 300 es
precision highp float;

uniform vec2 uResolution;
uniform vec2 uPointer;
uniform float uPointerSpeed;
uniform float uPointerDown;
uniform float uTime;
uniform float uProgress;
uniform float uVelocity;

out vec4 outColor;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise2(vec2 p) {
  vec2 cell = floor(p);
  vec2 local = fract(p);
  local = local * local * (3.0 - 2.0 * local);
  float a = hash21(cell);
  float b = hash21(cell + vec2(1.0, 0.0));
  float c = hash21(cell + vec2(0.0, 1.0));
  float d = hash21(cell + vec2(1.0));
  return mix(mix(a, b, local.x), mix(c, d, local.x), local.y);
}

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.53;
  mat2 rotation = mat2(0.80, -0.60, 0.60, 0.80);
  for (int octave = 0; octave < 5; octave++) {
    value += noise2(p) * amplitude;
    p = rotation * p * 2.03 + 19.17;
    amplitude *= 0.49;
  }
  return value;
}

float culturalSpine(float y, float progress) {
  float travel = progress * 7.8;
  return 0.055 * sin(y * 2.85 + travel)
    + 0.026 * sin(y * 7.4 - travel * 0.63)
    + 0.011 * sin(y * 17.0 + travel * 1.7);
}

float particleLayer(vec2 uv, vec2 pointer, float scale, float speed, float seed) {
  vec2 field = uv * scale;
  field.y += uProgress * (3.2 + seed * 0.43) + uTime * speed;
  field.x += sin(field.y * 0.41 + seed * 2.4) * 0.22;

  vec2 cell = floor(field);
  vec2 local = fract(field) - 0.5;
  float random = hash21(cell + seed * 31.7);
  vec2 jitter = vec2(
    hash21(cell + seed * 7.3),
    hash21(cell + seed * 13.1)
  ) - 0.5;

  vec2 cellWorld = (cell + 0.5 + jitter * 0.62) / scale;
  float pointerPull = exp(-dot(cellWorld - pointer, cellWorld - pointer) * 13.0);
  jitter += normalize(pointer - cellWorld + vec2(0.0001))
    * pointerPull * (0.28 + uPointerSpeed * 0.58);

  float radius = mix(0.018, 0.112, random * random);
  float shape = 1.0 - smoothstep(radius * 0.18, radius, length(local - jitter * 0.72));
  float gate = step(0.49, random);
  float flicker = 0.58 + 0.42 * sin(uTime * (0.7 + random * 1.3) + random * 41.0);
  return shape * gate * flicker * (0.62 + pointerPull * 1.8);
}

float softParticleLayer(vec2 uv, vec2 pointer, float scale, float speed, float seed) {
  vec2 field = uv * scale;
  field.y += uProgress * (1.7 + seed * 0.21) + uTime * speed;
  field.x += sin(field.y * 0.72 + seed) * 0.31;
  vec2 cell = floor(field);
  vec2 local = fract(field) - 0.5;
  float random = hash21(cell + seed * 19.1);
  vec2 center = vec2(hash21(cell + seed * 5.7), hash21(cell + seed * 11.9)) - 0.5;
  vec2 cellWorld = (cell + 0.5 + center * 0.66) / scale;
  float pointerPull = exp(-dot(cellWorld - pointer, cellWorld - pointer) * 7.0);
  center += normalize(pointer - cellWorld + vec2(0.0001)) * pointerPull * (0.13 + uPointerSpeed * 0.38);
  float distanceToParticle = length(local - center * 0.7);
  float halo = exp(-distanceToParticle * mix(13.0, 4.5, random));
  float core = exp(-distanceToParticle * mix(82.0, 28.0, random));
  float gate = step(0.58, random);
  float breathing = 0.55 + 0.45 * sin(uTime * (0.34 + random) + random * 63.0);
  return (halo * 0.24 + core * 0.86) * gate * breathing * (0.42 + pointerPull * 1.2);
}

void main() {
  float aspect = uResolution.x / uResolution.y;
  vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution.xy) / uResolution.y;
  vec2 pointer = vec2(uPointer.x * aspect * 0.5, uPointer.y * 0.5);
  float progress = clamp(uProgress, 0.0, 1.0);
  float scrollEnergy = 1.0 - exp(-abs(uVelocity) * 0.72);
  float pointerEnergy = clamp(uPointerSpeed, 0.0, 1.0);

  vec2 toPointer = uv - pointer;
  float pointerDistance2 = dot(toPointer, toPointer);
  float pointerField = exp(-pointerDistance2 * 12.0);
  vec2 world = uv;
  world += normalize(toPointer + vec2(0.0001))
    * pointerField * (0.018 + pointerEnergy * 0.048 + uPointerDown * 0.025);

  float slowTime = uTime * 0.045;
  float cloudLarge = fbm(world * 1.22 + vec2(slowTime, -progress * 1.5));
  float cloudMid = fbm(world * 3.1 + vec2(-slowTime * 1.7, progress * 2.1));
  float cloudFine = fbm(world * 8.2 + vec2(progress * 4.0, slowTime * 4.0));
  float inkMass = smoothstep(0.34, 0.82, cloudLarge * 0.68 + cloudMid * 0.43);
  float inkEdge = smoothstep(0.50, 0.79, abs(cloudLarge - cloudMid) + cloudFine * 0.28);

  vec3 color = vec3(0.0025, 0.0065, 0.0085);
  color += vec3(0.012, 0.034, 0.032) * inkMass;
  color += vec3(0.027, 0.078, 0.066) * inkEdge * (0.46 + scrollEnergy * 0.62);

  // Volumetric light lives behind the particles. Multiple oblique shafts
  // move at different rates so the field reads as depth rather than texture.
  float rayNoise = fbm(vec2(world.x * 2.1 - slowTime * 1.4, world.y * 0.58 + progress * 0.9));
  float rayA = exp(-abs(world.x + world.y * 0.28 + 0.17 + sin(slowTime * 2.0) * 0.05) * 5.6);
  float rayB = exp(-abs(world.x - world.y * 0.19 - 0.29 + cos(slowTime * 1.4) * 0.06) * 7.2);
  float rayGate = smoothstep(0.34, 0.75, rayNoise) * (0.42 + scrollEnergy * 0.58);
  color += vec3(0.13, 0.25, 0.23) * rayA * rayGate * 0.23;
  color += vec3(0.11, 0.18, 0.30) * rayB * rayGate * 0.16;

  // Three light filaments imply a continuous spatial spine without drawing
  // literal square joints. Their depth separation grows with scroll speed.
  float revealSpine = smoothstep(0.11, 0.28, progress) * (1.0 - smoothstep(0.91, 1.0, progress));
  float spineY = world.y + progress * 2.45;
  float center = culturalSpine(spineY, progress);
  float depthWobble = sin(spineY * 4.0 - uTime * 0.28) * 0.008;
  float d0 = abs(world.x - center);
  float d1 = abs(world.x - center - 0.027 - depthWobble);
  float d2 = abs(world.x - center + 0.024 + depthWobble);
  float core = exp(-d0 * 78.0);
  float strandA = exp(-d1 * 92.0);
  float strandB = exp(-d2 * 96.0);
  float aura = exp(-d0 * 8.0);
  float pulse = 0.56 + 0.44 * sin(spineY * 13.0 - progress * 38.0 - uTime * 0.72);
  color += vec3(0.085, 0.25, 0.21) * aura * revealSpine * (0.11 + scrollEnergy * 0.22);
  color += vec3(0.49, 0.77, 0.67) * core * revealSpine * pulse * (0.34 + scrollEnergy * 0.78);
  color += vec3(0.35, 0.52, 0.82) * strandA * revealSpine * (0.13 + scrollEnergy * 0.34);
  color += vec3(0.53, 0.28, 0.66) * strandB * revealSpine * (0.09 + scrollEnergy * 0.26);

  // A visible pointer wake: ink is displaced, then relit along the direction
  // of motion. This makes mouse response readable without watching the cursor.
  float pointerRadius = length(toPointer);
  float pointerHalo = exp(-pointerDistance2 * mix(8.0, 4.0, pointerEnergy));
  float pointerRing = exp(-abs(pointerRadius - (0.085 + pointerEnergy * 0.035)) * 42.0);
  float brokenRing = smoothstep(0.38, 0.78, fbm(uv * 12.0 + pointer * 7.0 + uTime * 0.08));
  color += vec3(0.23, 0.49, 0.41) * pointerHalo * (0.08 + pointerEnergy * 0.34 + uPointerDown * 0.16);
  color += vec3(0.56, 0.76, 0.67) * pointerRing * brokenRing * (0.08 + pointerEnergy * 0.42);

  float wakeLine = exp(-abs(toPointer.y + sin(toPointer.x * 17.0 - uTime) * 0.018) * 36.0)
    * exp(-abs(toPointer.x) * 5.0);
  color += vec3(0.18, 0.40, 0.35) * wakeLine * pointerEnergy * 0.34;

  float particles = particleLayer(world, pointer, 6.2, 0.065, 1.0) * 1.12
    + particleLayer(world + vec2(2.1, 1.7), pointer, 11.0, -0.046, 2.0) * 0.88
    + particleLayer(world - vec2(1.4, 2.8), pointer, 18.0, 0.032, 3.0) * 0.64
    + particleLayer(world + vec2(4.3, -1.6), pointer, 28.0, -0.022, 4.0) * 0.44
    + particleLayer(world - vec2(3.6, 0.8), pointer, 41.0, 0.016, 5.0) * 0.25;
  float bokeh = softParticleLayer(world + vec2(0.7, -0.4), pointer, 3.8, 0.018, 7.0)
    + softParticleLayer(world - vec2(1.6, 2.4), pointer, 6.8, -0.014, 8.0) * 0.72
    + softParticleLayer(world + vec2(3.1, 1.3), pointer, 9.6, 0.011, 9.0) * 0.48;
  float particleMask = 0.24 + 0.76 * smoothstep(0.20, 0.82, cloudLarge + cloudMid * 0.25);
  vec3 jadeBlue = mix(
    vec3(0.31, 0.68, 0.52),
    vec3(0.42, 0.58, 0.96),
    smoothstep(-0.35, 0.42, world.x + sin(world.y * 2.0) * 0.15)
  );
  vec3 mineralColor = mix(jadeBlue, vec3(0.82, 0.66, 0.30), smoothstep(0.56, 0.96, cloudFine) * 0.34);
  color += mineralColor * particles * particleMask
    * (0.34 + revealSpine * 0.31 + scrollEnergy * 0.82 + pointerEnergy * 0.25);
  color += mix(vec3(0.25, 0.52, 0.45), vec3(0.44, 0.53, 0.84), cloudMid)
    * bokeh * (0.18 + scrollEnergy * 0.31 + pointerEnergy * 0.21);

  // Soft hero illumination supports the detailed Taiji image layer above it.
  vec2 heroLightPosition = vec2(0.035 + uPointer.x * 0.025, 0.06 + uPointer.y * 0.018);
  vec2 heroVector = uv - heroLightPosition;
  heroVector.x *= 0.84;
  float heroLight = exp(-dot(heroVector, heroVector) * 5.7) * (1.0 - smoothstep(0.14, 0.39, progress));
  color += vec3(0.20, 0.37, 0.32) * heroLight * (0.13 + pointerEnergy * 0.12);

  float vignetteDistance = length(uv * vec2(0.72, 1.0));
  float vignette = 1.0 - smoothstep(0.43, 1.04, vignetteDistance);
  color *= 0.50 + 0.50 * vignette;
  float grain = hash21(gl_FragCoord.xy + floor(uTime * 19.0));
  color += (grain - 0.5) * (0.010 + scrollEnergy * 0.008);
  color = color / (1.0 + color);
  color = pow(max(color, 0.0), vec3(0.86));

  outColor = vec4(color, 1.0);
}
`;function o(e,t,n){let r=e.createShader(t);if(!r)throw Error(`Unable to create the ink-field shader.`);if(e.shaderSource(r,n),e.compileShader(r),!e.getShaderParameter(r,e.COMPILE_STATUS)){let t=e.getShaderInfoLog(r)??`Unknown shader compilation error.`;throw e.deleteShader(r),Error(t)}return r}function s(e){let t=o(e,e.VERTEX_SHADER,i),n=o(e,e.FRAGMENT_SHADER,a),r=e.createProgram();if(!r)throw Error(`Unable to create the ink-field program.`);if(e.attachShader(r,t),e.attachShader(r,n),e.linkProgram(r),e.deleteShader(t),e.deleteShader(n),!e.getProgramParameter(r,e.LINK_STATUS)){let t=e.getProgramInfoLog(r)??`Unknown shader linking error.`;throw e.deleteProgram(r),Error(t)}return r}function c(e,t,n){let r=e.getUniformLocation(t,n);if(r===null)throw Error(`Missing WebGL uniform: ${n}`);return r}function l(e,t=0){return Number.isFinite(e)?e:t}function u({progressRef:e,velocityRef:t,pointerRef:i,className:a}){let o=(0,n.useRef)(null);return(0,n.useEffect)(()=>{let n=o.current;if(!n)return;let r=n.getContext(`webgl2`,{alpha:!1,antialias:!1,depth:!1,desynchronized:!0,powerPreference:`high-performance`,premultipliedAlpha:!1,preserveDrawingBuffer:!1,stencil:!1});if(!r){n.style.background=`radial-gradient(circle at 50% 45%, #17312c 0%, #071311 36%, #020707 78%)`;return}let a=s(r),u=r.createVertexArray(),d=r.createBuffer();if(!u||!d)throw Error(`Unable to allocate the ink-field geometry.`);r.bindVertexArray(u),r.bindBuffer(r.ARRAY_BUFFER,d),r.bufferData(r.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),r.STATIC_DRAW);let f=r.getAttribLocation(a,`aPosition`);if(f<0)throw Error(`Missing WebGL position attribute.`);r.enableVertexAttribArray(f),r.vertexAttribPointer(f,2,r.FLOAT,!1,0,0),r.bindVertexArray(null);let p={resolution:c(r,a,`uResolution`),pointer:c(r,a,`uPointer`),pointerSpeed:c(r,a,`uPointerSpeed`),pointerDown:c(r,a,`uPointerDown`),time:c(r,a,`uTime`),progress:c(r,a,`uProgress`),velocity:c(r,a,`uVelocity`)},m=window.matchMedia(`(prefers-reduced-motion: reduce)`),h=m.matches,g=0,_=!document.hidden,v=performance.now(),y=0,b=l(e.current),x=0,S=0,C=0,w=0,T=0,E=()=>{let e=Math.min(window.devicePixelRatio||1,window.innerWidth<800?1.2:1.5),t=Math.max(1,Math.round(n.clientWidth*e)),i=Math.max(1,Math.round(n.clientHeight*e));(n.width!==t||n.height!==i)&&(n.width=t,n.height=i),r.viewport(0,0,t,i)},D=o=>{let s=Math.min(Math.max((o-v)/1e3,.001),.1);if(v=o,_){let o=i.current,c=h?1:1-Math.exp(-s*7);b+=(Math.min(1,Math.max(0,l(e.current)))-b)*c,x+=((h?0:Math.min(12,Math.max(-12,l(t.current))))-x)*c,S+=((h?0:Math.min(1,Math.max(-1,l(o.x))))-S)*c,C+=((h?0:Math.min(1,Math.max(-1,l(o.y))))-C)*c,w+=((h?0:Math.min(1,Math.max(0,l(o.speed))))-w)*c,T+=((h?0:Math.min(1,Math.max(0,l(o.down))))-T)*c,h||(y+=s),E(),r.useProgram(a),r.bindVertexArray(u),r.uniform2f(p.resolution,n.width,n.height),r.uniform2f(p.pointer,S,C),r.uniform1f(p.pointerSpeed,w),r.uniform1f(p.pointerDown,T),r.uniform1f(p.time,y),r.uniform1f(p.progress,b),r.uniform1f(p.velocity,x),r.drawArrays(r.TRIANGLES,0,3),r.bindVertexArray(null)}g=window.requestAnimationFrame(D)},O=()=>{_=!document.hidden,v=performance.now()},k=e=>{h=e.matches};return E(),window.addEventListener(`resize`,E,{passive:!0}),document.addEventListener(`visibilitychange`,O,{passive:!0}),m.addEventListener(`change`,k),g=window.requestAnimationFrame(D),()=>{window.cancelAnimationFrame(g),window.removeEventListener(`resize`,E),document.removeEventListener(`visibilitychange`,O),m.removeEventListener(`change`,k),r.deleteBuffer(d),r.deleteVertexArray(u),r.deleteProgram(a)}},[i,e,t]),(0,r.jsx)(`canvas`,{ref:o,className:a,"aria-hidden":`true`})}export{u as default};