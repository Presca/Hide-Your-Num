// Three.js scene: arena, other players (with the number plate on their forehead), smoke and effects.
import * as THREE from 'three';
import { CFG } from '../shared/constants.js';

const TONES = [['#5b6a9c', '#7383b8', '#3a4468'], ['#9a7a72', '#b3928a', '#5e4a44'], ['#5f8f84', '#78aa9e', '#3b5e56'], ['#7f6fa3', '#978ac0', '#4e4466'], ['#9a9166', '#b5ac80', '#5e5840'], ['#5e7ea6', '#7797c2', '#3a5070']];

export class World {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#1a2340');
    this.scene.fog = new THREE.Fog('#1a2340', 50, 120);
    this.camera = new THREE.PerspectiveCamera(78, 1, 0.05, 200);
    this.camera.rotation.order = 'YXZ';

    const hemi = new THREE.HemisphereLight('#e8efff', '#3a3f55', 1.8);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight('#fff1d6', 2.6);
    sun.position.set(28, 42, 18);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -42; sun.shadow.camera.right = 42; sun.shadow.camera.top = 42; sun.shadow.camera.bottom = -42;
    sun.shadow.camera.near = 5; sun.shadow.camera.far = 120; sun.shadow.bias = -0.0008;
    this.scene.add(sun);

    this.mapGroup = new THREE.Group(); this.scene.add(this.mapGroup);
    this.players = new Map();
    this.smokes = new Map();
    this.fx = [];
    this.smokeGeo = new THREE.SphereGeometry(1, 24, 16);
    this.smokeMat = new THREE.MeshStandardMaterial({ color: '#b9bfcc', transparent: true, opacity: 0.88, roughness: 1, depthWrite: false });
    this.bodyGeo = new THREE.CapsuleGeometry(0.38, 0.62, 4, 14);
    this.headGeo = new THREE.SphereGeometry(0.28, 20, 14);
    this.eyeGeo = new THREE.SphereGeometry(0.04, 8, 6);
    this.plateGeo = new THREE.PlaneGeometry(0.66, 0.27);
    this.fxGeo = new THREE.BoxGeometry(0.12, 0.12, 0.12);
    this.skinMat = new THREE.MeshStandardMaterial({ color: '#f1d7c0', roughness: 0.8 });
    this.eyeMat = new THREE.MeshBasicMaterial({ color: '#111' });
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }

  // ---- arena -----------------------------------------------------------------------------------
  setMap(map) {
    this.mapGroup.clear();
    const tones = TONES[map.palette % TONES.length];
    const size = CFG.ARENA + 4;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshStandardMaterial({ map: floorTexture('#3a4160'), roughness: 0.95 }));
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
    this.mapGroup.add(floor);
    for (const b of map.blocks) {
      const color = b.wall ? tones[2] : b.landmark ? '#ffd166' : tones[b.tone ?? 0];
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.05 });
      const m = new THREE.Mesh(new THREE.BoxGeometry(b.hw * 2, b.h, b.hd * 2), mat);
      m.position.set(b.x, b.h / 2, b.z);
      m.castShadow = !b.wall; m.receiveShadow = true;
      this.mapGroup.add(m);
      if (!b.wall) {                       // light edge strip so cover reads from a distance
        const edge = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry), new THREE.LineBasicMaterial({ color: '#aab4d8', transparent: true, opacity: 0.35 }));
        edge.position.copy(m.position); this.mapGroup.add(edge);
      }
    }
    // Faint lane markings towards the centre.
    const ring = new THREE.Mesh(new THREE.RingGeometry(5.5, 5.8, 48), new THREE.MeshBasicMaterial({ color: '#ffd166', transparent: true, opacity: 0.25 }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.01; this.mapGroup.add(ring);
  }

  // ---- players ---------------------------------------------------------------------------------
  addPlayer(id, info) {
    if (this.players.has(id)) { this.players.get(id).info = info; return; }
    const g = new THREE.Group();
    const body = new THREE.Mesh(this.bodyGeo, new THREE.MeshStandardMaterial({ color: info.color || '#8899ff', roughness: 0.6 }));
    body.position.y = 0.69; body.castShadow = true; g.add(body);
    const head = new THREE.Group(); head.position.y = 1.56; g.add(head);
    const skull = new THREE.Mesh(this.headGeo, this.skinMat); skull.castShadow = true; head.add(skull);
    for (const sx of [-0.1, 0.1]) { const e = new THREE.Mesh(this.eyeGeo, this.eyeMat); e.position.set(sx, -0.03, -0.26); head.add(e); }
    const canvas = document.createElement('canvas'); canvas.width = 352; canvas.height = 144;
    const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
    const plate = new THREE.Mesh(this.plateGeo, new THREE.MeshBasicMaterial({ map: tex }));
    plate.position.set(0, 0.12, -0.275); plate.rotation.y = Math.PI; head.add(plate);
    const tag = makeTag(info.name, info.color); tag.position.y = 2.15; g.add(tag);
    g.visible = false;
    this.scene.add(g);
    const rp = { g, head, body, plate, canvas, tex, info, target: null, shown: null, hidden: false, scramble: 0 };
    this.players.set(id, rp);
    drawPlate(rp, null, false);
  }
  removePlayer(id) {
    const rp = this.players.get(id); if (!rp) return;
    this.scene.remove(rp.g); rp.tex.dispose(); rp.body.material.dispose(); this.players.delete(id);
  }
  applyState(players, selfId) {
    for (const s of players) {
      if (s.id === selfId) continue;
      const rp = this.players.get(s.id); if (!rp) continue;
      const wasVisible = rp.g.visible;
      rp.g.visible = !!s.a;
      rp.target = s;
      if (!wasVisible && s.a) { rp.g.position.set(s.p[0], s.p[1], s.p[2]); rp.g.rotation.y = s.yaw; rp.head.rotation.x = s.pitch; }
      const code = s.n ?? null, hidden = !!s.h;
      if (code !== rp.shown || hidden !== rp.hidden) { drawPlate(rp, code, hidden); rp.shown = code; rp.hidden = hidden; }
    }
  }
  setSmokes(list) {
    const seen = new Set();
    for (const s of list) {
      seen.add(s.id);
      if (!this.smokes.has(s.id)) {
        const m = new THREE.Mesh(this.smokeGeo, this.smokeMat.clone());
        m.position.set(s.p[0], s.p[1], s.p[2]); m.scale.setScalar(CFG.GADGETS.smoke.radius * 0.3);
        m.userData = { until: s.until, born: performance.now() };
        this.scene.add(m); this.smokes.set(s.id, m);
      }
    }
    for (const [id, m] of this.smokes) if (!seen.has(id)) { this.scene.remove(m); m.material.dispose(); this.smokes.delete(id); }
  }
  cameraInSmoke() {
    const c = this.camera.position;
    for (const m of this.smokes.values()) if (c.distanceTo(m.position) < m.scale.x) return true;
    return false;
  }
  burst(p, color = '#ffffff') {
    for (let i = 0; i < 16; i++) {
      const m = new THREE.Mesh(this.fxGeo, new THREE.MeshBasicMaterial({ color, transparent: true }));
      m.position.set(p[0], p[1] + 1.4, p[2]);
      const a = Math.random() * Math.PI * 2, s = 2 + Math.random() * 4;
      m.userData = { v: new THREE.Vector3(Math.cos(a) * s, 2 + Math.random() * 4, Math.sin(a) * s), life: 0.9 };
      this.scene.add(m); this.fx.push(m);
    }
  }

  // ---- frame -----------------------------------------------------------------------------------
  update(dt, eye, yaw, pitch) {
    this.camera.position.set(eye.x, eye.y, eye.z);
    this.camera.rotation.set(pitch, yaw, 0);
    const k = 1 - Math.exp(-dt * 14);
    for (const rp of this.players.values()) {
      const t = rp.target; if (!t || !rp.g.visible) continue;
      rp.g.position.x += (t.p[0] - rp.g.position.x) * k;
      rp.g.position.y += (t.p[1] - rp.g.position.y) * k;
      rp.g.position.z += (t.p[2] - rp.g.position.z) * k;
      rp.g.rotation.y += angleDelta(rp.g.rotation.y, t.yaw) * k;
      rp.head.rotation.x += (t.pitch - rp.head.rotation.x) * k;
      if (rp.hidden) { rp.scramble += dt; if (rp.scramble > 0.08) { rp.scramble = 0; drawPlate(rp, null, true); } }
    }
    const now = performance.now();
    for (const m of this.smokes.values()) {
      const grow = Math.min(1, (now - m.userData.born) / 700);
      m.scale.setScalar(CFG.GADGETS.smoke.radius * (0.3 + 0.7 * grow));
      const left = (m.userData.until - now);
      m.material.opacity = Math.min(0.88, Math.max(0.1, left / 1200));
      m.rotation.y += dt * 0.15;
    }
    for (let i = this.fx.length - 1; i >= 0; i--) {
      const m = this.fx[i]; const u = m.userData;
      u.life -= dt; u.v.y -= 12 * dt;
      m.position.addScaledVector(u.v, dt); m.rotation.x += dt * 6; m.rotation.z += dt * 4;
      m.material.opacity = Math.max(0, u.life / 0.9);
      if (u.life <= 0 || m.position.y < 0) { this.scene.remove(m); m.material.dispose(); this.fx.splice(i, 1); }
    }
    this.renderer.render(this.scene, this.camera);
  }
}

function drawPlate(rp, code, hidden) {
  const c = rp.canvas, ctx = c.getContext('2d');
  ctx.fillStyle = hidden ? '#3a3a3a' : '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.strokeStyle = '#111'; ctx.lineWidth = 8; ctx.strokeRect(4, 4, c.width - 8, c.height - 8);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = '800 96px "JetBrains Mono", ui-monospace, Menlo, monospace';
  if (hidden) {
    ctx.fillStyle = '#9a9a9a';
    const s = Array.from({ length: CFG.CODE_DIGITS }, () => '0123456789'[Math.floor(Math.random() * 10)]).join('');
    ctx.fillText(s, c.width / 2, c.height / 2 + 6);
  } else if (code) {
    ctx.fillStyle = '#111'; ctx.fillText(code, c.width / 2, c.height / 2 + 6);
  } else {
    ctx.fillStyle = '#bbb'; ctx.fillText('·'.repeat(CFG.CODE_DIGITS), c.width / 2, c.height / 2 + 6);
  }
  rp.tex.needsUpdate = true;
}

function makeTag(name, color) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 112;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(10,14,26,.72)'; roundRect(ctx, 8, 8, 496, 96, 28); ctx.fill();
  ctx.fillStyle = color || '#fff'; ctx.beginPath(); ctx.arc(60, 56, 22, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = '700 52px "Space Grotesk", system-ui, sans-serif'; ctx.textBaseline = 'middle';
  ctx.fillText(name, 100, 58);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true }));
  sp.scale.set(1.6, 0.35, 1);
  return sp;
}

function floorTexture(base) {
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const ctx = c.getContext('2d');
  ctx.fillStyle = base; ctx.fillRect(0, 0, 512, 512);
  ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.lineWidth = 3;
  for (let i = 0; i <= 512; i += 128) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 512); ctx.moveTo(0, i); ctx.lineTo(512, i); ctx.stroke(); }
  ctx.fillStyle = 'rgba(255,255,255,.05)';
  for (let i = 0; i < 400; i++) ctx.fillRect(Math.random() * 512, Math.random() * 512, 2, 2);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(CFG.ARENA / 8, CFG.ARENA / 8); tex.anisotropy = 8;
  return tex;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function angleDelta(a, b) { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return d; }
