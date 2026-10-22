import * as THREE from './three.module.min.js';
import { OrbitControls } from './OrbitControls.js';

// One WebGL context is shared by all tabs. Geometry is released on every switch.
export class Board3D {
  constructor(host, onError) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x1b1d21);
    this.renderer.domElement.setAttribute('aria-label', '3D PCB view');
    this.renderer.domElement.setAttribute('role', 'img');
    this.renderer.domElement.addEventListener('webglcontextlost', event => {
      event.preventDefault(); onError('The 3D graphics context was lost. Switch to 2D or reload to try again.');
    });
    host.append(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 10000);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.addEventListener('change', () => this.render());
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(host);
  }

  clear() {
    this.controls.enabled = false;
    this.scene?.traverse(object => {
      object.geometry?.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach(material => material?.dispose());
    });
    this.scene = null;
    this.renderer.clear();
  }

  show(model, state) {
    this.clear();
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.8));
    const light = new THREE.DirectionalLight(0xffffff, 3);
    light.position.set(-30, -50, 100); this.scene.add(light);
    const bottomLight = new THREE.DirectionalLight(0xc5dfff, 2);
    bottomLight.position.set(30, 50, -100); this.scene.add(bottomLight);
    const addSolid = (data, z, height, color, opacity = 1, edgeColor = 0x182323) => {
      const shape = new THREE.Shape(data.outline.map(p => new THREE.Vector2(...p)));
      shape.holes = (data.holes || []).map(points => new THREE.Path(points.map(p => new THREE.Vector2(...p))));
      const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, steps: 1 });
      const material = new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.05,
        opacity, transparent: opacity < 1 });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.z = z; mesh.name = data.name || 'Board'; this.scene.add(mesh);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 25),
        new THREE.LineBasicMaterial({ color: edgeColor, transparent: true, opacity: 0.45 * opacity }));
      edges.position.z = z; this.scene.add(edges);
    };
    model.board.forEach(part => addSolid(part, -model.thickness / 2, model.thickness, 0x16764f, 1, 0xbcc28a));
    model.bodies.forEach(body => addSolid(body, body.z, body.height, body.color, body.opacity));
    const bounds = new THREE.Box3().setFromObject(this.scene);
    this.center = bounds.getCenter(new THREE.Vector3());
    this.radius = Math.max(bounds.getSize(new THREE.Vector3()).length() / 2, 0.1);
    this.camera.near = Math.max(this.radius / 10000, 0.0001);
    this.camera.far = this.radius * 1000;
    this.controls.minDistance = this.radius * 0.01;
    this.controls.maxDistance = this.radius * 100;
    this.controls.enabled = true;
    this.resize();
    if (state) {
      this.camera.position.fromArray(state.position); this.camera.up.fromArray(state.up);
      this.controls.target.fromArray(state.target); this.controls.update();
    } else this.fit();
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
