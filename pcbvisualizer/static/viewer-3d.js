import * as THREE from './three.module.min.js';
import { OrbitControls } from './OrbitControls.js';
import { StepLoader } from './step-loader.js';

// One WebGL context is shared by all tabs. Geometry is released on every switch.
export class Board3D {
  constructor(host, onError, onPick, onModels) {
    this.host = host;
    this.onModels = onModels;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x1b1d21);
    this.renderer.domElement.setAttribute('aria-label', '3D PCB view');
    this.renderer.domElement.setAttribute('role', 'region');
    this.renderer.domElement.tabIndex = 0;
    this.renderer.domElement.addEventListener('webglcontextlost', event => {
      event.preventDefault(); onError('The 3D graphics context was lost. Switch to 2D or reload to try again.');
    });
    host.append(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 10000);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.addEventListener('change', () => this.render());
    this.raycaster = new THREE.Raycaster();
    const canvas = this.renderer.domElement;
    const pointers = new Set();
    let click = null;
    this.cancelPick = () => { pointers.clear(); click = null; };
    window.addEventListener('blur', this.cancelPick);
    canvas.addEventListener('pointerdown', event => {
      pointers.add(event.pointerId);
      click = pointers.size === 1 && event.button === 0 ?
        { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false } : null;
    });
    canvas.addEventListener('pointermove', event => {
      if (click?.id === event.pointerId && Math.hypot(event.clientX - click.x, event.clientY - click.y) > 4) click.moved = true;
    });
    canvas.addEventListener('pointerup', event => {
      const selected = click; click = null; pointers.delete(event.pointerId);
      if (!this.scene || selected?.id !== event.pointerId || selected.moved) return;
      canvas.focus({ preventScroll: true });
      const rect = canvas.getBoundingClientRect();
      const point = new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1,
        -(event.clientY - rect.top) / rect.height * 2 + 1);
      this.scene.updateMatrixWorld(true);
      this.raycaster.setFromCamera(point, this.camera);
      // Include board surfaces so an occluded body cannot be picked through it.
      const hit = this.raycaster.intersectObjects(this.pickMeshes.filter(mesh => mesh.visible), false)[0];
      onPick?.(hit?.object.userData.bodyId ?? null, event.shiftKey);
    });
    canvas.addEventListener('pointercancel', event => { pointers.delete(event.pointerId); click = null; });
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(host);
  }

  clear() {
    this.generation = (this.generation || 0) + 1;
    this.stepLoader?.close(); this.stepLoader = null;
    this.cancelPick();
    this.controls.enabled = false;
    const geometries = new Set();
    this.scene?.traverse(object => {
      if (object.geometry) geometries.add(object.geometry);
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach(material => material?.dispose());
    });
    geometries.forEach(geometry => geometry.dispose());
    this.scene = null;
    this.pickMeshes = [];
    this.bodyMeshes = [];
    this.renderer.clear();
  }

  show(model, state, bodies) {
    this.clear();
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.8));
    const light = new THREE.DirectionalLight(0xffffff, 3);
    light.position.set(-30, -50, 100); this.scene.add(light);
    const bottomLight = new THREE.DirectionalLight(0xc5dfff, 2);
    bottomLight.position.set(30, 50, -100); this.scene.add(bottomLight);
    const addSolid = (data, z, height, color, opacity = 1, edgeColor = 0x182323, bodyId = null) => {
      if (!data.outline?.length) return;
      const shape = new THREE.Shape(data.outline.map(p => new THREE.Vector2(...p)));
      shape.holes = (data.holes || []).map(points => new THREE.Path(points.map(p => new THREE.Vector2(...p))));
      const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, steps: 1 });
      const material = new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.05,
        opacity, transparent: opacity < 1 });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.visible = bodyId === null || !bodies?.deleted.has(bodyId);
      mesh.position.z = z; mesh.name = data.name || 'Board'; this.scene.add(mesh);
      mesh.userData.bodyId = bodyId;
      if (opacity > 0) this.pickMeshes.push(mesh);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 25),
        new THREE.LineBasicMaterial({ color: edgeColor, transparent: true, opacity: 0.45 * opacity }));
      edges.position.z = z; this.scene.add(edges);
      edges.visible = mesh.visible;
      if (bodyId !== null) this.bodyMeshes.push({ id: bodyId, mesh, edges, edgeColor, edgeOpacity: 0.45 * opacity });
    };
    model.board.forEach(part => addSolid(part, -model.thickness / 2, model.thickness, 0x16764f, 1, 0xbcc28a));
    model.bodies.forEach((body, index) => addSolid(body, body.z, body.height, body.color, body.opacity,
      0x182323, body.id ?? `body-${index}`));
    this.updateBounds();
    this.controls.enabled = true;
    this.resize();
    if (state) {
      this.camera.position.fromArray(state.position); this.camera.up.fromArray(state.up);
      this.controls.target.fromArray(state.target); this.controls.update();
    } else this.fit();
    this.updateBodies(bodies);
    this.loadSteps(model, this.generation);
  }

  async loadSteps(model, generation) {
    const assets = model.step_models || {};
    const requests = new Map();
    for (const body of model.bodies) if (body.model) {
      if (!requests.has(body.model)) requests.set(body.model, new Map());
      requests.get(body.model).set(body.id, body);
    }
    let loaded = 0; const failed = [];
    const progress = () => this.onModels?.({ loaded, total: requests.size, failed: [...failed] });
    progress();
    if (!requests.size) return;
    this.stepLoader = new StepLoader();
    for (const [key, bodies] of requests) {
      try {
        const parts = await this.stepLoader.load(key, assets[key]);
        if (generation !== this.generation) return;
        this.addStepBodies([...bodies.values()], parts);
        loaded++;
      } catch (error) {
        if (generation !== this.generation) return;
        failed.push(`${assets[key]?.name || 'Model'}: ${error.message}`);
      }
      progress();
      // Give orbit/pan and tab controls a turn between converted assets.
      await new Promise(resolve => setTimeout(resolve, 0));
      if (generation !== this.generation) return;
    }
  }

  addStepBodies(bodies, parts) {
    const ids = new Set(bodies.map(body => body.id));
    const replaced = this.bodyMeshes.filter(entry => ids.has(entry.id));
    const removed = new Set(replaced.map(entry => entry.mesh));
    for (const { mesh, edges } of replaced) {
      this.scene.remove(mesh, edges);
      mesh.geometry.dispose(); mesh.material.dispose();
      edges?.geometry.dispose(); edges?.material.dispose();
    }
    this.pickMeshes = this.pickMeshes.filter(mesh => !removed.has(mesh));
    this.bodyMeshes = this.bodyMeshes.filter(entry => !ids.has(entry.id));
    const geometries = parts.map(part => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(part.position, 3));
      geometry.setIndex(new THREE.BufferAttribute(part.index, 1));
      if (part.normal) geometry.setAttribute('normal', new THREE.BufferAttribute(part.normal, 3));
      else geometry.computeVertexNormals();
      if (part.color) geometry.setAttribute('color', new THREE.BufferAttribute(part.color, 3));
      geometry.computeBoundingBox(); geometry.computeBoundingSphere();
      return geometry;
    });
    for (const body of bodies) for (const [index, geometry] of geometries.entries()) {
      const material = new THREE.MeshStandardMaterial({ color: parts[index].color ? 0xffffff : body.color,
        vertexColors: Boolean(parts[index].color), roughness: 0.65, metalness: 0.12,
        opacity: body.opacity, transparent: body.opacity < 1, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = body.name; mesh.userData.bodyId = body.id; mesh.userData.step = true;
      mesh.matrixAutoUpdate = false; mesh.matrix.fromArray(body.matrix);
      this.scene.add(mesh);
      if (body.opacity > 0) this.pickMeshes.push(mesh);
      this.bodyMeshes.push({ id: body.id, mesh });
    }
    this.updateBodies(this.bodyState);
  }

  updateBounds() {
    const bounds = new THREE.Box3();
    this.pickMeshes.filter(mesh => mesh.visible).forEach(mesh => bounds.expandByObject(mesh));
    this.center = bounds.getCenter(new THREE.Vector3());
    this.radius = Math.max(bounds.getSize(new THREE.Vector3()).length() / 2, 0.1);
    this.camera.near = Math.max(this.radius / 10000, 0.0001);
    this.camera.far = this.radius * 1000;
    this.controls.minDistance = this.radius * 0.01;
    this.controls.maxDistance = this.radius * 100;
    this.camera.updateProjectionMatrix();
  }

  updateBodies(state) {
    this.bodyState = state;
    for (const { id, mesh, edges, edgeColor, edgeOpacity } of this.bodyMeshes) {
      mesh.visible = !state?.deleted.has(id);
      if (edges) edges.visible = mesh.visible;
      const selected = Boolean(state?.selected.has(id));
      mesh.material.emissive.setHex(selected ? 0x147b8a : 0);
      if (edges) {
        edges.material.color.setHex(selected ? 0x35c2d8 : edgeColor);
        edges.material.opacity = selected ? 1 : edgeOpacity;
      }
    }
    this.updateBounds();
    this.render();
  }

  state() {
    return this.scene ? { position: this.camera.position.toArray(), up: this.camera.up.toArray(),
      target: this.controls.target.toArray() } : null;
  }

  fit(preset = 'iso') {
    if (!this.scene) return;
    const angle = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const distance = this.radius / Math.sin(Math.min(angle, Math.atan(Math.tan(angle) * this.camera.aspect))) * 1.12;
    const direction = preset === 'top' ? new THREE.Vector3(0, 0, 1) :
      preset === 'bottom' ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(1, -1.3, 1.4).normalize();
    this.camera.up.set(0, preset === 'bottom' ? -1 : 1, 0);
    this.camera.position.copy(this.center).addScaledVector(direction, distance);
    this.controls.target.copy(this.center); this.controls.update(); this.render();
  }

  zoom(factor) {
    if (!this.scene) return;
    const offset = this.camera.position.clone().sub(this.controls.target);
    offset.setLength(THREE.MathUtils.clamp(offset.length() * factor,
      this.controls.minDistance, this.controls.maxDistance));
    this.camera.position.copy(this.controls.target).add(offset); this.controls.update(); this.render();
  }

  resize() {
    const { clientWidth: width, clientHeight: height } = this.host;
    if (!width || !height) return;
    this.renderer.setSize(width, height);
    this.camera.aspect = width / height; this.camera.updateProjectionMatrix(); this.render();
  }

  render() {
    if (this.scene && !this.host.hidden) this.renderer.render(this.scene, this.camera);
  }
}
