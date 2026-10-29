import * as THREE from './three.module.min.js';

export function studioEnvironment(renderer) {
  // A small procedural photographic studio: broad softboxes provide readable
  // reflections on leads and connector shells without network/HDR assets.
  const room = new THREE.Scene();
  room.add(new THREE.Mesh(new THREE.BoxGeometry(30, 30, 30),
    new THREE.MeshBasicMaterial({ color: 0x373c45, side: THREE.BackSide })));
  for (const [size, position, power] of [
    [[14, 10], [0, -2, 12], 5], [[7, 12], [-11, -5, 4], 3], [[3, 11], [10, 3, 5], 4],
    [[12, 8], [1, 3, -12], 3],
  ]) {
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(...size),
      new THREE.MeshBasicMaterial({ color: new THREE.Color().setScalar(power), side: THREE.DoubleSide }));
    panel.position.fromArray(position); panel.lookAt(0, 0, 0); room.add(panel);
  }
  const generator = new THREE.PMREMGenerator(renderer);
  const environment = generator.fromScene(room, 0.04);
  generator.dispose();
  room.traverse(object => { object.geometry?.dispose(); object.material?.dispose(); });
  return environment;
}

export function stepFinish(geometry, part, fallback) {
  // STEP carries color, not measured PBR properties. Infer restrained finishes
  // from those colors: dark polymers stay matte, neutral/gold metals reflect.
  const finish = new Float32Array(part.position.length / 3 * 2);
  const base = new THREE.Color(fallback);
  for (let vertex = 0; vertex < finish.length / 2; vertex++) {
    const rgb = part.color ? part.color.subarray(vertex * 3, vertex * 3 + 3) : [base.r, base.g, base.b];
    const high = Math.max(...rgb), low = Math.min(...rgb), brightness = (rgb[0] + rgb[1] + rgb[2]) / 3;
    const neutralMetal = brightness > 0.23 && high - low < 0.14;
    const gold = rgb[0] > 0.35 && rgb[1] > 0.18 && rgb[2] < rgb[1] * 0.65;
    const metal = neutralMetal || gold;
    finish[vertex * 2] = metal ? 0.29 : brightness < 0.08 ? 0.62 : 0.48;
    finish[vertex * 2 + 1] = metal ? 0.85 : 0;
  }
  geometry.setAttribute('physicalFinish', new THREE.BufferAttribute(finish, 2));
}

export function bodyMaterial(parameters) {
  const material = new THREE.MeshStandardMaterial(parameters);
  // A uniform tint stays visible on black plastics and reflective metals,
  // including vertex-colored STEP faces. It does not alter source colors or
  // require coplanar overlay geometry or shader recompilation on selection.
  material.userData.highlight = { value: 0 };
  material.onBeforeCompile = shader => {
    shader.uniforms.bodyHighlight = material.userData.highlight;
    shader.uniforms.bodyHighlightColor = { value: new THREE.Color(0x35c2d8) };
    shader.fragmentShader = 'uniform float bodyHighlight; uniform vec3 bodyHighlightColor;\n' + shader.fragmentShader;
    // Apply after tone mapping so bright metal reflections cannot wash it out.
    shader.fragmentShader = shader.fragmentShader.replace('#include <tonemapping_fragment>',
      '#include <tonemapping_fragment>\ngl_FragColor.rgb = mix(gl_FragColor.rgb, bodyHighlightColor, bodyHighlight * 0.8);');
  };
  material.customProgramCacheKey = () => 'body-highlight-v1';
  return material;
}

export function stepMaterial(parameters) {
  const material = bodyMaterial(parameters), highlight = material.onBeforeCompile;
  material.onBeforeCompile = shader => {
    highlight(shader);
    shader.vertexShader = 'attribute vec2 physicalFinish; varying vec2 vPhysicalFinish;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvPhysicalFinish = physicalFinish;');
    shader.fragmentShader = 'varying vec2 vPhysicalFinish;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = vPhysicalFinish.x;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = vPhysicalFinish.y;');
  };
  material.customProgramCacheKey = () => 'step-physical-finish-highlight-v2';
  return material;
}
