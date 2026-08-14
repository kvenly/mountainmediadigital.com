// viewer.js — draws a G hole in the browser from the real course math.
import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import { HoleTerrain } from './terrain.js?v=1786743714';

const SURFACE_KEYS = ['fairway', 'green', 'fringe', 'rough', 'sand', 'water'];

// Course seed matches the game: courses are seeded by id.
const seedFor = (courseId, holeNumber) => BigInt(courseId) * 1000n + BigInt(holeNumber);

function hexToRGB(hex) {
  const c = new THREE.Color(hex);
  return c;
}

export class CourseViewer {
  constructor(canvas, courses, palettes) {
    this.canvas = canvas;
    this.courses = courses;
    this.palettes = palettes;
    this.spin = true;

    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, alpha: false, powerPreference: 'low-power',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 1, 1, 4000);

    this.sun = new THREE.DirectionalLight(0xffffff, 2.1);
    this.sun.position.set(-160, 220, -120);
    this.scene.add(this.sun);
    this.ambient = new THREE.HemisphereLight(0xffffff, 0x4a6b52, 1.25);
    this.scene.add(this.ambient);

    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.theta = -0.5;
    this.phi = 0.62;
    this.dist = 1;
    this.drag = null;
    this._bindInput();

    this.onResize();
    window.addEventListener('resize', () => this.onResize());
  }

  _bindInput() {
    const c = this.canvas;
    const down = (x, y) => { this.drag = { x, y }; this.spin = false; c.style.cursor = 'grabbing'; };
    const move = (x, y) => {
      if (!this.drag) return;
      this.theta -= (x - this.drag.x) * 0.006;
      this.phi = Math.max(0.16, Math.min(1.32, this.phi - (y - this.drag.y) * 0.004));
      this.drag = { x, y };
    };
    const up = () => { this.drag = null; c.style.cursor = 'grab'; };

    c.addEventListener('pointerdown', e => { c.setPointerCapture(e.pointerId); down(e.clientX, e.clientY); });
    c.addEventListener('pointermove', e => move(e.clientX, e.clientY));
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', e => {
      e.preventDefault();
      this.dist = Math.max(0.55, Math.min(1.7, this.dist + e.deltaY * 0.0012));
    }, { passive: false });
    c.style.cursor = 'grab';
  }

  onResize() {
    const w = this.canvas.clientWidth || 800;
    const h = this.canvas.clientHeight || 500;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Build one hole: terrain mesh, water plane, pin, tee. */
  show(courseIndex, holeIndex) {
    const course = this.courses[courseIndex];
    const hole = course.holes[holeIndex];
    const palette = this.palettes.palettes[
      this.palettes.order[course.paletteRotation[holeIndex % course.paletteRotation.length]]
    ];

    // Clear previous geometry.
    this.root.clear();
    this.disposeCache?.forEach(o => o.dispose?.());
    this.disposeCache = [];

    const terrain = new HoleTerrain(hole, seedFor(course.id, hole.number));
    this.terrain = terrain;

    // --- Bounds: the corridor plus generous shoulders.
    const zs = hole.corridor.map(p => p.y);
    const xs = hole.corridor.map(p => p.x);
    const minZ = -40, maxZ = Math.max(...zs) + 70;
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const halfW = Math.max(96, (Math.max(...xs) - Math.min(...xs)) / 2 + 78);
    const minX = cx - halfW, maxX = cx + halfW;

    // --- Terrain mesh, vertex-coloured by surface.
    const NX = 150, NZ = 240;
    const geo = new THREE.PlaneGeometry(maxX - minX, maxZ - minZ, NX, NZ);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);

    const tint = {
      fairway: hexToRGB(palette.bands?.[2] ?? '#3FAE6B'),
      green:   hexToRGB(palette.green ?? '#A8E88F'),
      fringe:  hexToRGB(palette.bands?.[1] ?? '#4DA95E'),
      rough:   hexToRGB(palette.bands?.[0] ?? '#2E7A4A'),
      sand:    hexToRGB(palette.bands?.[3] ?? '#EFE0B8'),
      water:   hexToRGB(palette.water ?? '#27B8C4'),
    };
    const shade = new THREE.Color();

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + (minX + maxX) / 2;
      const z = pos.getZ(i) + (minZ + maxZ) / 2;
      const h = terrain.heightAt(x, z);
      pos.setY(i, h);
      pos.setX(i, x);
      pos.setZ(i, z);

      const s = terrain.surface(x, z);
      shade.copy(tint[s] ?? tint.rough);
      // A whisper of height shading so the land reads without textures.
      const k = 1 + Math.max(-0.16, Math.min(0.16, h * 0.02));
      shade.multiplyScalar(k);
      colors[i * 3] = shade.r; colors[i * 3 + 1] = shade.g; colors[i * 3 + 2] = shade.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    const land = new THREE.Mesh(geo, mat);
    this.root.add(land);
    this.disposeCache.push(geo, mat);

    // --- What lies past the mesh edge. On island and coastal holes the
    // hole genuinely sits in open sea, so the water runs to the horizon;
    // inland, the land does. Either way the edge never shows as a cliff.
    const openWater = terrain.islandMode || terrain.oceanSide !== 0;
    const waterCol = hexToRGB(palette.water ?? '#27B8C4');
    const landCol = hexToRGB(palette.bands?.[0] ?? '#2E7A4A');

    const wGeo = new THREE.PlaneGeometry(
      (maxX - minX) * (openWater ? 6 : 1), (maxZ - minZ) * (openWater ? 6 : 1));
    wGeo.rotateX(-Math.PI / 2);
    const wMat = new THREE.MeshLambertMaterial({ color: waterCol });
    const water = new THREE.Mesh(wGeo, wMat);
    water.position.set((minX + maxX) / 2, terrain.waterLevel, (minZ + maxZ) / 2);
    this.root.add(water);
    this.disposeCache.push(wGeo, wMat);

    if (!openWater) {
      const sGeo = new THREE.PlaneGeometry((maxX - minX) * 6, (maxZ - minZ) * 6);
      sGeo.rotateX(-Math.PI / 2);
      const sMat = new THREE.MeshLambertMaterial({ color: landCol });
      const skirt = new THREE.Mesh(sGeo, sMat);
      skirt.position.set((minX + maxX) / 2, -2.6, (minZ + maxZ) / 2);
      this.root.add(skirt);
      this.disposeCache.push(sGeo, sMat);
    }

    // --- Pin.
    const gx = hole.greenCenter.x, gz = hole.greenCenter.y;
    const gy = terrain.heightAt(gx, gz);
    const poleGeo = new THREE.CylinderGeometry(0.16, 0.16, 8, 6);
    const poleMat = new THREE.MeshLambertMaterial({ color: 0xf6efd8 });
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.set(gx, gy + 4, gz);
    this.root.add(pole);
    const flagGeo = new THREE.PlaneGeometry(3.4, 2.1);
    const flagMat = new THREE.MeshBasicMaterial({
      color: hexToRGB(palette.flag ?? '#F2A9C4'), side: THREE.DoubleSide,
    });
    const flag = new THREE.Mesh(flagGeo, flagMat);
    flag.position.set(gx + 1.7, gy + 7, gz);
    this.root.add(flag);
    this.disposeCache.push(poleGeo, poleMat, flagGeo, flagMat);

    // --- Tee markers.
    const teeMat = new THREE.MeshLambertMaterial({ color: 0xf4f1e4 });
    for (const side of [-1, 1]) {
      const g = new THREE.SphereGeometry(0.7, 8, 6);
      const m = new THREE.Mesh(g, teeMat);
      m.position.set(side * 2.2, terrain.heightAt(side * 2.2, 0) + 0.5, 0);
      this.root.add(m);
      this.disposeCache.push(g);
    }
    this.disposeCache.push(teeMat);

    // --- Sky + fog to the horizon colour.
    const sky = hexToRGB(palette.skyBottom ?? '#6FA0EC');
    this.scene.background = sky;
    // Fog eats the mesh edge before the eye finds it.
    this.scene.fog = new THREE.Fog(sky, (maxZ - minZ) * 0.42, (maxZ - minZ) * 1.15);

    // Frame the hole.
    this.center = new THREE.Vector3((minX + maxX) / 2, 0, (minZ + maxZ) / 2 - 26);
    this.radius = Math.max(maxZ - minZ, halfW * 2) * 0.5;

    return { course, hole, palette };
  }

  frame(dt) {
    if (this.spin) this.theta += dt * 0.055;
    const r = this.radius * this.dist;
    const y = Math.sin(this.phi) * r;
    const h = Math.cos(this.phi) * r;
    this.camera.position.set(
      this.center.x + Math.sin(this.theta) * h,
      y + 30,
      this.center.z + Math.cos(this.theta) * h
    );
    this.camera.lookAt(this.center.x, 0, this.center.z);
    this.renderer.render(this.scene, this.camera);
  }
}
