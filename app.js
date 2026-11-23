(() => {
  'use strict';

  /*
   * EMBASSY OF BURGERS — tiny dependency-free WebGL 2 viewer for the supplied GLB.
   * The supplied asset is a single KHR_mesh_quantization mesh with embedded
   * WebP textures. This viewer reads its actual glTF buffers and material.
   * No Three.js, build step, third-party WebGL service, or external JS needed.
   */
  const $ = (s) => document.querySelector(s);
  const canvas = $('#modelCanvas');
  const loader = $('#loader');
  const loaderProgress = $('#loaderProgress');
  const loaderText = $('#loaderText');
  const loaderError = $('#loaderError');
  const progressFill = $('#pageProgress > div');
  const glow = $('#backgroundGlow');
  const shadow = $('#floorShadow');
  const tags = $('#modelTags');
  const spinButton = $('#toggleSpin');
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const NAV = ['intro', 'craft', 'details', 'explore'];
  document.body.dataset.scene = 'intro';

  // All targets are in model-normalized units, and framing is viewport-adjusted.
  const SCENES = {
    intro:   { yaw: -0.12, pitch: 0.17, radius: 3.55, shiftX: 0.55, shiftY: -0.02, lookY: -0.08 },
    craft:   { yaw: 0.22, pitch: 0.12, radius: 3.28, shiftX: 0.50, shiftY: -0.01, lookY: -0.08 },
    details: { yaw: -0.37, pitch: 0.28, radius: 3.80, shiftX: 0.68, shiftY: -0.04, lookY: -0.08 },
    explore: { yaw: 0.05, pitch: 0.16, radius: 3.60, shiftX: 0.52, shiftY: -0.02, lookY: -0.08 },
  };
  const PRESETS = {
    front: { yaw: -0.12, pitch: 0.17, radius: 3.65 },
    side:  { yaw: 1.46, pitch: 0.12, radius: 3.65 },
    top:   { yaw: 0.32, pitch: 1.15, radius: 3.84 },
    back:  { yaw: 3.08, pitch: 0.16, radius: 3.65 },
  };
  const TAGS = {
    top:    { point: [0.07, 0.37, 0.65], index: '01 / 03', title: 'ВЕРХ БУРГЕРА', text: 'Рассмотрите форму и текстуру верхней булочки.' },
    middle: { point: [0.21, -0.13, 0.75], index: '02 / 03', title: 'В ЦЕНТРЕ', text: 'Поверните модель, чтобы увидеть начинку с разных сторон.' },
    bottom: { point: [-0.10, -0.49, 0.62], index: '03 / 03', title: 'ОСНОВАНИЕ', text: 'Изучите нижнюю часть и детали бургера.' },
  };

  let gl, program, vao, indexCount, textures = [], modelReady = false;
  let activeScene = 'intro';
  let selectedPreset = 'front';
  let autoSpin = false;
  let spinPhase = 0;
  let manualYaw = 0;
  let manualPitch = 0;
  let zoomDelta = 0;
  let lastFrame = 0;
  let rafId = 0;
  let lastPointer = null;
  let pointerMoved = false;
  let prevWidth = 0;
  let prevHeight = 0;
  const camera = { ...SCENES.intro };
  const uniform = {};
  let screen = { width: 1, height: 1, ratio: 1 };
  let loadAttempt = 0;

  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const mix = (a, b, t) => a + (b - a) * t;
  const vecSub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const vecCross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
  const vecDot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
  const vecNorm = (v) => { const len = Math.hypot(...v) || 1; return v.map((x) => x / len); };

  const VERTEX = `#version 300 es
    precision highp float;
    layout(location=0) in vec3 aPosition;
    layout(location=1) in vec3 aNormal;
    layout(location=2) in vec2 aUv;
    uniform vec3 uNodeScale;
    uniform vec3 uNodeOffset;
    uniform vec3 uCamera;
    uniform vec3 uRight;
    uniform vec3 uUp;
    uniform vec3 uForward;
    uniform float uFocal;
    uniform float uAspect;
    uniform vec2 uLensShift;
    out vec3 vNormal;
    out vec3 vWorld;
    out vec2 vUv;
    out vec3 vView;
    void main() {
      vWorld = aPosition * uNodeScale + uNodeOffset;
      vNormal = normalize(aNormal / uNodeScale);
      vUv = aUv;
      vec3 relative = vWorld - uCamera;
      vec3 viewPoint = vec3(dot(relative, uRight), dot(relative, uUp), -dot(relative, uForward));
      vView = viewPoint;
      float near = 0.04;
      float far = 100.0;
      float z = viewPoint.z;
      gl_Position = vec4(
        (uFocal / uAspect) * viewPoint.x - uLensShift.x * z,
        uFocal * viewPoint.y - uLensShift.y * z,
        (far + near) / (near - far) * z + (2.0 * far * near) / (near - far),
        -z
      );
    }
  `;
  const FRAGMENT = `#version 300 es
    precision highp float;
    in vec3 vNormal;
    in vec3 vWorld;
    in vec2 vUv;
    in vec3 vView;
    uniform sampler2D uColorTexture;
    uniform sampler2D uMaterialTexture;
    uniform sampler2D uNormalTexture;
    uniform vec2 uUVScale;
    uniform vec2 uUVOffset;
    uniform vec3 uEye;
    out vec4 outColor;
    void main() {
      vec2 uv = vUv * uUVScale + uUVOffset;
      vec3 normal = normalize(gl_FrontFacing ? vNormal : -vNormal);
      // Reconstruct a tangent frame from derivatives (GLB has no TANGENT channel).
      vec3 dp1 = dFdx(vWorld);
      vec3 dp2 = dFdy(vWorld);
      vec2 duv1 = dFdx(uv);
      vec2 duv2 = dFdy(uv);
      vec3 tangent = dp1 * duv2.y - dp2 * duv1.y;
      float tangentLength = length(tangent);
      if (tangentLength > 0.000001) {
        tangent /= tangentLength;
        tangent = normalize(tangent - normal * dot(normal, tangent));
        vec3 bitangent = normalize(cross(normal, tangent));
        vec3 mapNormal = texture(uNormalTexture, uv).xyz * 2.0 - 1.0;
        normal = normalize(mat3(tangent, bitangent, normal) * vec3(mapNormal.xy * 0.58, max(mapNormal.z, 0.08)));
      }
      vec3 albedo = pow(texture(uColorTexture, uv).rgb, vec3(2.2));
      float roughness = clamp(texture(uMaterialTexture, uv).g, 0.22, 1.0);
      vec3 keyDir = normalize(vec3(-0.46, 0.89, 0.66));
      vec3 fillDir = normalize(vec3(0.82, 0.25, -0.24));
      vec3 rimDir = normalize(vec3(0.38, 0.45, -0.80));
      float key = max(0.0, dot(normal, keyDir));
      float fill = max(0.0, dot(normal, fillDir));
      float rim = max(0.0, dot(normal, rimDir));
      vec3 light = vec3(0.59, 0.57, 0.54) + key*vec3(0.69,0.62,0.51) + fill*vec3(0.24,0.27,0.27) + rim*vec3(0.23,0.16,0.10);
      vec3 viewDirection = normalize(uEye - vWorld);
      vec3 halfVec = normalize(keyDir + viewDirection);
      float specular = pow(max(0.0, dot(normal, halfVec)), mix(66.0, 7.0, roughness));
      vec3 color = albedo * light + vec3(1.0, 0.79, 0.58) * specular * (1.0 - roughness) * 0.52;
      color = pow(max(color, vec3(0.0)), vec3(1.0 / 2.2));
      outColor = vec4(color, 1.0);
    }
  `;

  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const error = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error('WebGL shader compile error: ' + error);
    }
    return shader;
  }

  function createProgram(gl) {
    const vert = compileShader(gl, gl.VERTEX_SHADER, VERTEX);
    const frag = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    const result = gl.createProgram();
    gl.attachShader(result, vert);
    gl.attachShader(result, frag);
    gl.linkProgram(result);
    gl.deleteShader(vert);
    gl.deleteShader(frag);
    if (!gl.getProgramParameter(result, gl.LINK_STATUS)) throw new Error('WebGL link error: ' + gl.getProgramInfoLog(result));
    return result;
  }

  function parseGLB(arrayBuffer) {
    const view = new DataView(arrayBuffer);
    if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2) throw new Error('Expected a version 2 binary glTF (.glb) model.');
    let offset = 12, gltf = null, binOffset = null;
    while (offset + 8 <= arrayBuffer.byteLength) {
      const length = view.getUint32(offset, true);
      const type = view.getUint32(offset + 4, true);
      offset += 8;
      if (type === 0x4e4f534a) gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(arrayBuffer, offset, length)).replace(/\u0000+$/g, '').trim());
      if (type === 0x004e4942) binOffset = offset;
      offset += length;
    }
    if (!gltf || binOffset === null) throw new Error('GLB JSON or binary chunk is missing.');
    return { gltf, arrayBuffer, binOffset };
  }

  function makeGLBuffer(parsed, target, bufferViewIndex) {
    const { gltf, arrayBuffer, binOffset } = parsed;
    const bufferView = gltf.bufferViews[bufferViewIndex];
    const data = new Uint8Array(arrayBuffer, binOffset + (bufferView.byteOffset || 0), bufferView.byteLength);
    const buffer = gl.createBuffer();
    gl.bindBuffer(target, buffer);
    gl.bufferData(target, data, gl.STATIC_DRAW);
    return { buffer, stride: bufferView.byteStride || 0 };
  }

  function configureAttribute(parsed, semantic, location) {
    const primitive = parsed.gltf.meshes[0].primitives[0];
    const accessor = parsed.gltf.accessors[primitive.attributes[semantic]];
    const { buffer, stride } = makeGLBuffer(parsed, gl.ARRAY_BUFFER, accessor.bufferView);
    const sizes = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, sizes[accessor.type], accessor.componentType, !!accessor.normalized, stride, accessor.byteOffset || 0);
    return buffer;
  }

  async function makeTexture(parsed, textureIndex, unit) {
    const { gltf, arrayBuffer, binOffset } = parsed;
    const textureDef = gltf.textures[textureIndex];
    const sourceIndex = textureDef.extensions?.EXT_texture_webp?.source ?? textureDef.source;
    const image = gltf.images[sourceIndex];
    if (image.bufferView === undefined) throw new Error('This viewer expects embedded GLB images.');
    const view = gltf.bufferViews[image.bufferView];
    const bytes = arrayBuffer.slice(binOffset + (view.byteOffset || 0), binOffset + (view.byteOffset || 0) + view.byteLength);
    const blob = new Blob([bytes], { type: image.mimeType || 'image/webp' });
    const bitmap = await createImageBitmap(blob);
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); // glTF texture coordinate convention.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    gl.generateMipmap(gl.TEXTURE_2D);
    bitmap.close();
    return tex;
  }

  async function uploadModel(parsed) {
    const gltf = parsed.gltf;
    const primitive = gltf.meshes[0].primitives[0];
    if (!primitive || !primitive.attributes.NORMAL || !primitive.attributes.TEXCOORD_0) {
      // accessor indices of zero are valid, so use explicit key presence.
      if (!primitive || !('NORMAL' in primitive.attributes) || !('TEXCOORD_0' in primitive.attributes))
        throw new Error('This GLB is missing the expected geometry attributes.');
    }
    gl.useProgram(program);
    vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    configureAttribute(parsed, 'POSITION', 0);
    configureAttribute(parsed, 'NORMAL', 1);
    configureAttribute(parsed, 'TEXCOORD_0', 2);
    const indices = gltf.accessors[primitive.indices];
    if (indices.componentType !== gl.UNSIGNED_INT) throw new Error('Expected uint32 triangle indices.');
    makeGLBuffer(parsed, gl.ELEMENT_ARRAY_BUFFER, indices.bufferView);
    indexCount = indices.count;
    gl.bindVertexArray(null);
    const material = gltf.materials[primitive.material || 0];
    const pbr = material.pbrMetallicRoughness;
    const colorInfo = pbr.baseColorTexture;
    const transform = colorInfo.extensions?.KHR_texture_transform;
    const uvScale = transform?.scale || [1, 1];
    const uvOffset = transform?.offset || [0, 0];
    const node = gltf.nodes.find((n) => n.mesh === 0);
    const nodeScale = node?.scale || [1, 1, 1];
    const nodeOffset = node?.translation || [0, 0, 0];
    const textureInfo = [colorInfo.index, pbr.metallicRoughnessTexture.index, material.normalTexture.index];
    textures = await Promise.all(textureInfo.map((idx, i) => makeTexture(parsed, idx, i)));
    gl.useProgram(program);
    function uni(n) { return gl.getUniformLocation(program, n); }
    for (const name of ['uNodeScale', 'uNodeOffset', 'uCamera', 'uRight', 'uUp', 'uForward', 'uFocal', 'uAspect', 'uLensShift', 'uUVScale', 'uUVOffset', 'uEye']) uniform[name] = uni(name);
    gl.uniform3fv(uniform.uNodeScale, nodeScale);
    gl.uniform3fv(uniform.uNodeOffset, nodeOffset);
    gl.uniform2fv(uniform.uUVScale, uvScale);
    gl.uniform2fv(uniform.uUVOffset, uvOffset);
    gl.uniform1i(uni('uColorTexture'), 0);
    gl.uniform1i(uni('uMaterialTexture'), 1);
    gl.uniform1i(uni('uNormalTexture'), 2);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE); // Original material is double-sided.
    gl.clearColor(0, 0, 0, 0);
  }

  function downloadGLB(onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', './assets/burger.glb', true);
      xhr.responseType = 'arraybuffer';
      xhr.onprogress = (e) => { if (e.lengthComputable) onProgress(clamp((e.loaded / e.total) * 94, 0, 94)); };
      xhr.onload = () => (xhr.status === 200 || xhr.status === 0) && xhr.response ? resolve(xhr.response) : reject(new Error('Could not load burger.glb (HTTP ' + xhr.status + ').'));
      xhr.onerror = () => reject(new Error('The 3D model could not be fetched.'));
      xhr.send();
    });
  }

  function updateLoader(percentage, message = '') {
    loaderProgress.style.width = percentage + '%';
    loaderText.textContent = message || `ЗАГРУЖАЕМ МОДЕЛЬ — ${Math.round(percentage)}%`;
  }

  async function load() {
    const attempt = ++loadAttempt;
    loader.classList.remove('is-hidden');
    loaderError.hidden = true;
    updateLoader(2);
    try {
      if (!window.WebGL2RenderingContext) throw new Error('This browser does not support WebGL 2.');
      gl = canvas.getContext('webgl2', { alpha: true, antialias: true, depth: true, powerPreference: 'high-performance', premultipliedAlpha: false });
      if (!gl) throw new Error('WebGL 2 could not start. Enable hardware acceleration in your browser.');
      program = createProgram(gl);
      const bytes = await downloadGLB((percent) => { if (loadAttempt === attempt) updateLoader(percent); });
      if (loadAttempt !== attempt) return;
      updateLoader(95, 'НАСТРАИВАЕМ 3D-ПРОСМОТР — 95%');
      await uploadModel(parseGLB(bytes));
      updateLoader(100, 'ГОТОВО — 100%');
      modelReady = true;
      document.body.classList.add('model-loaded');
      resize();
      renderFrame(performance.now());
      requestAnimationFrame(() => requestAnimationFrame(() => loader.classList.add('is-hidden')));
    } catch (err) {
      console.error('[EMBASSY OF BURGERS]', err);
      // The promotional page stays usable without hardware WebGL.
      document.body.classList.add('is-static');
      document.body.classList.remove('model-loaded');
      const status = document.getElementById('controlsStatus');
      status.textContent = 'ПРЕВЬЮ';
      const note = document.getElementById('viewerNote');
      note.textContent = '3D недоступен в этом браузере. Показан кадр из оригинальной модели бургера.';
      document.querySelectorAll('#exploreControls button').forEach((btn) => { btn.disabled = true; btn.setAttribute('title', 'Для управления моделью требуется WebGL 2'); });
      loaderError.hidden = false;
      loaderError.querySelector('span').textContent = 'Показан кадр из оригинальной модели. Для 3D используйте браузер с WebGL 2 и аппаратным ускорением.';
      updateLoader(0, 'ДОСТУПЕН РЕЖИМ ПРЕВЬЮ');
      // Show the message briefly; avoid blocking a functional campaign page.
      window.setTimeout(() => loader.classList.add('is-hidden'), 1800);
    }
  }

  function targetCamera() {
    const base = { ...SCENES[activeScene] };
    if (activeScene === 'explore') Object.assign(base, PRESETS[selectedPreset]);
    if (screen.width < 780) {
      base.shiftX = 0.01;
      base.shiftY = activeScene === 'explore' ? 0.22 : -0.35;
      base.radius += screen.width < 500 ? 0.60 : 0.30;
      if (activeScene === 'details') { base.pitch = 0.4; base.shiftY = -0.32; }
      if (activeScene === 'explore') base.radius += 0.05;
    }
    base.yaw += manualYaw;
    base.pitch = clamp(base.pitch + manualPitch, -1.30, 1.35);
    base.radius = clamp(base.radius + zoomDelta, 2.20, 7.10);
    if (autoSpin) base.yaw += spinPhase;
    else if (!prefersReducedMotion && !lastPointer && activeScene === 'intro' && Math.abs(manualYaw) < .001) base.yaw += Math.sin(performance.now() * .00032) * .042;
    return base;
  }

  function resize() {
    if (!gl) return;
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    const ratio = Math.min(window.devicePixelRatio || 1, width < 780 ? 1.35 : 1.8);
    if (width === prevWidth && height === prevHeight && ratio === screen.ratio) return;
    screen = { width, height, ratio };
    prevWidth = width; prevHeight = height;
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  function getCameraBasis() {
    const eye = [
      Math.sin(camera.yaw) * Math.cos(camera.pitch) * camera.radius,
      Math.sin(camera.pitch) * camera.radius + camera.lookY,
      Math.cos(camera.yaw) * Math.cos(camera.pitch) * camera.radius,
    ];
    const target = [0, camera.lookY, 0];
    const forward = vecNorm(vecSub(target, eye));
    const right = vecNorm(vecCross(forward, [0, 1, 0]));
    const up = vecNorm(vecCross(right, forward));
    return { eye, forward, right, up };
  }

  function project(world, basis, focal) {
    const delta = vecSub(world, basis.eye);
    const depth = vecDot(delta, basis.forward);
    if (depth <= 0.05) return null;
    const ndcX = (vecDot(delta, basis.right) * focal / (screen.width/screen.height)) / depth + camera.shiftX;
    const ndcY = (vecDot(delta, basis.up) * focal) / depth + camera.shiftY;
    return { x: (ndcX*.5+.5)*screen.width, y: (-ndcY*.5+.5)*screen.height };
  }

  function positionTags(basis, focal) {
    if (activeScene !== 'craft') return;
    Object.entries(TAGS).forEach(([key, item]) => {
      const point = project(item.point, basis, focal);
      const node = document.querySelector(`[data-tag="${key}"]`);
      if (!node) return;
      node.style.display = point && point.x < screen.width - 160 && point.x > screen.width*.35 ? 'flex' : 'none';
      if (point) { node.style.left = point.x + 'px'; node.style.top = point.y + 'px'; }
    });
  }

  function renderFrame(now) {
    if (!modelReady || !gl) return;
    const dt = lastFrame ? Math.min((now - lastFrame) / 1000, 0.06) : 0.016;
    lastFrame = now;
    resize();
    if (autoSpin) spinPhase += dt * 0.30;
    const target = targetCamera();
    const ease = prefersReducedMotion ? 1 : 1 - Math.exp(-dt * 5.0);
    ['yaw', 'pitch', 'radius', 'shiftX', 'shiftY', 'lookY'].forEach((key) => { camera[key] = mix(camera[key], target[key], ease); });
    const basis = getCameraBasis();
    const focal = 1 / Math.tan((38 * Math.PI / 180) / 2);
    gl.useProgram(program);
    gl.uniform3fv(uniform.uCamera, basis.eye);
    gl.uniform3fv(uniform.uRight, basis.right);
    gl.uniform3fv(uniform.uUp, basis.up);
    gl.uniform3fv(uniform.uForward, basis.forward);
    gl.uniform3fv(uniform.uEye, basis.eye);
    gl.uniform1f(uniform.uFocal, focal);
    gl.uniform1f(uniform.uAspect, screen.width / screen.height);
    gl.uniform2f(uniform.uLensShift, camera.shiftX, camera.shiftY);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.bindVertexArray(vao);
    for (let i = 0; i < textures.length; ++i) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, textures[i]);
    }
    gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
    if (activeScene === 'craft') positionTags(basis, focal);
    rafId = requestAnimationFrame(renderFrame);
  }

  function updateScroll() {
    const total = document.documentElement.scrollHeight - window.innerHeight;
    progressFill.style.width = clamp((window.scrollY / Math.max(1, total)) * 100, 0, 100) + '%';
    const half = window.innerHeight * .48;
    let nearest = activeScene, distance = Infinity;
    NAV.forEach((name) => {
      const r = document.getElementById(name).getBoundingClientRect();
      const d = Math.abs((r.top + r.bottom) / 2 - half);
      if (d < distance) { distance = d; nearest = name; }
    });
    document.body.dataset.scene = nearest;
    if (nearest === activeScene) return;
    activeScene = nearest;
    manualYaw = 0; manualPitch = 0; zoomDelta = 0; spinPhase = 0;
    autoSpin = false;
    spinButton.classList.remove('is-active');
    spinButton.setAttribute('aria-label', 'Включить автовращение');
    document.querySelectorAll('[data-nav]').forEach((el) => el.classList.toggle('is-active', el.dataset.nav === nearest));
    document.querySelectorAll('[data-rail]').forEach((el) => el.classList.toggle('active', el.dataset.rail === nearest));
    $('#railCurrent').textContent = String(NAV.indexOf(nearest)+1).padStart(2,'0');
    tags.classList.toggle('is-visible', nearest === 'craft');
    $('#detailTooltip').classList.remove('is-open');
    $('#dragIndicator').style.opacity = nearest === 'intro' ? '1' : '0';
    glow.style.left = nearest === 'details' ? '78%' : nearest === 'explore' ? '69%' : '69%';
    shadow.style.left = nearest === 'details' ? '78%' : nearest === 'explore' ? '69%' : '69%';
    glow.style.opacity = nearest === 'explore' ? '.78' : '1';
    shadow.style.opacity = nearest === 'explore' ? '.30' : '.65';
  }

  function choosePreset(name) {
    if (!PRESETS[name]) return;
    selectedPreset = name;
    manualYaw = manualPitch = zoomDelta = spinPhase = 0;
    autoSpin = false;
    spinButton.classList.remove('is-active');
    spinButton.setAttribute('aria-label', 'Включить автовращение');
    document.querySelectorAll('[data-preset]').forEach((b) => b.classList.toggle('is-current', b.dataset.preset === name));
  }

  function setupInteraction() {
    let pointerId = null;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || pointerId !== null || !modelReady) return;
      pointerId = e.pointerId;
      lastPointer = { x: e.clientX, y: e.clientY };
      pointerMoved = false;
      canvas.setPointerCapture(e.pointerId);
      canvas.classList.add('dragging');
    });
    canvas.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pointerId || !lastPointer) return;
      const dx = e.clientX - lastPointer.x;
      const dy = e.clientY - lastPointer.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) pointerMoved = true;
      if (e.pointerType === 'touch' && Math.abs(dy) > Math.abs(dx) * 1.6) {
        lastPointer = { x: e.clientX, y: e.clientY };
        return; // Keep vertical touch-scrolling natural.
      }
      manualYaw -= dx * .006;
      manualPitch = clamp(manualPitch + dy * .004, -1.3, 1.3);
      lastPointer = { x: e.clientX, y: e.clientY };
      if (pointerMoved) $('#dragIndicator').style.opacity = '0';
    });
    const endPointer = (e) => {
      if (e.pointerId !== pointerId) return;
      pointerId = null;
      lastPointer = null;
      canvas.classList.remove('dragging');
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    };
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);
    canvas.addEventListener('wheel', (e) => {
      if (!e.altKey && !e.ctrlKey) return; // Normal scrolling remains a page interaction.
      e.preventDefault();
      zoomDelta = clamp(zoomDelta + Math.sign(e.deltaY) * .16, -1.5, 3.5);
    }, { passive: false });
    canvas.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') manualYaw += .2;
      else if (e.key === 'ArrowRight') manualYaw -= .2;
      else if (e.key === 'ArrowUp') manualPitch -= .12;
      else if (e.key === 'ArrowDown') manualPitch += .12;
      else if (e.key === '+' || e.key === '=') zoomDelta = clamp(zoomDelta - .25, -1.5, 3.5);
      else if (e.key === '-') zoomDelta = clamp(zoomDelta + .25, -1.5, 3.5);
      else return;
      e.preventDefault();
    });
    document.querySelectorAll('[data-preset]').forEach((button) => button.addEventListener('click', () => choosePreset(button.dataset.preset)));
    $('#zoomIn').addEventListener('click', () => { zoomDelta = clamp(zoomDelta - .35, -1.5, 3.5); });
    $('#zoomOut').addEventListener('click', () => { zoomDelta = clamp(zoomDelta + .35, -1.5, 3.5); });
    $('#resetView').addEventListener('click', () => choosePreset('front'));
    spinButton.addEventListener('click', () => {
      autoSpin = !autoSpin;
      if (!autoSpin) { manualYaw += spinPhase; spinPhase = 0; }
      spinButton.classList.toggle('is-active', autoSpin);
      spinButton.setAttribute('aria-label', autoSpin ? 'Остановить автовращение' : 'Включить автовращение');
    });
    $('#lookFromAbove')?.addEventListener('click', () => {
      choosePreset('top');
      document.getElementById('explore').scrollIntoView({ behavior: prefersReducedMotion ? 'auto' : 'smooth' });
    });
    document.querySelectorAll('[data-tag]').forEach((button) => {
      button.addEventListener('click', () => {
        const info = TAGS[button.dataset.tag];
        $('#tooltipCount').textContent = info.index;
        $('#tooltipTitle').textContent = info.title;
        $('#tooltipText').textContent = info.text;
        $('#detailTooltip').classList.add('is-open');
      });
    });
    $('#tooltipClose').addEventListener('click', () => $('#detailTooltip').classList.remove('is-open'));
    $('#retryLoad').addEventListener('click', () => window.location.reload());
    window.addEventListener('scroll', updateScroll, { passive: true });
    window.addEventListener('resize', () => { resize(); updateScroll(); }, { passive: true });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) lastFrame = 0; });
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); cancelAnimationFrame(rafId); modelReady = false; console.warn('WebGL context lost'); });
    canvas.addEventListener('webglcontextrestored', () => window.location.reload());
    updateScroll();
  }

  setupInteraction();
  load();
})();
