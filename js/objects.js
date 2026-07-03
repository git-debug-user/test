/* ============================================================
   objects.js
   OBJECT FACTORY — build a Three.js group from AI spec
============================================================ */
import * as THREE from 'three';

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function colorOrFallback(hex, fallback) {
  if (typeof hex === 'string' && /^#([0-9a-f]{6})$/i.test(hex.trim())) return hex.trim();
  return fallback;
}

export function buildObjectFromSpec(spec) {
  const group = new THREE.Group();
  // All visual meshes live under visualRoot. `group` itself is reserved
  // for the physics body's transform (position/quaternion synced every
  // frame from Cannon-es), so decorative animations are safe to apply
  // to visualRoot/children without fighting the physics sync.
  const visualRoot = new THREE.Group();
  group.add(visualRoot);

  const scale = clamp(Number(spec.scale) || 0.6, 0.25, 1.8);
  const primary = new THREE.Color(colorOrFallback(spec.primary_color, '#00f0c0'));
  const secondary = new THREE.Color(colorOrFallback(spec.secondary_color, '#0a2a26'));

  const matPrimary = new THREE.MeshStandardMaterial({
    color: primary, roughness: 0.35, metalness: 0.25,
    emissive: primary, emissiveIntensity: 0.12,
    depthTest: true, depthWrite: true, // GPU Depth Occlusion 対象
  });
  const matSecondary = new THREE.MeshStandardMaterial({
    color: secondary, roughness: 0.6, metalness: 0.1,
    depthTest: true, depthWrite: true,
  });

  switch (spec.object_type) {
    case 'creature': {
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.5, 24, 24), matPrimary);
      body.scale.set(1, 0.85, 1.1);
      visualRoot.add(body);
      const eyeGeo = new THREE.SphereGeometry(0.09, 12, 12);
      const eyeMat = new THREE.MeshStandardMaterial({ color: 0xffffff });
      [-0.18, 0.18].forEach(x => {
        const eye = new THREE.Mesh(eyeGeo, eyeMat);
        eye.position.set(x, 0.15, 0.42);
        visualRoot.add(eye);
        const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 8), new THREE.MeshStandardMaterial({ color: 0x111111 }));
        pupil.position.set(x, 0.15, 0.49);
        visualRoot.add(pupil);
      });
      for (let i = 0; i < 3; i++) {
        const legGeo = new THREE.CylinderGeometry(0.05, 0.05, 0.3, 8);
        const leg = new THREE.Mesh(legGeo, matSecondary);
        const ang = (i / 3) * Math.PI * 2;
        leg.position.set(Math.cos(ang) * 0.32, -0.5, Math.sin(ang) * 0.32);
        visualRoot.add(leg);
      }
      group.userData.animOffset = body;
      break;
    }
    case 'plant': {
      const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 0.3, 16), matSecondary);
      pot.position.y = 0.15;
      visualRoot.add(pot);
      const leafCount = 5;
      for (let i = 0; i < leafCount; i++) {
        const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.55, 8), matPrimary);
        const ang = (i / leafCount) * Math.PI * 2;
        leaf.position.set(Math.cos(ang) * 0.12, 0.55, Math.sin(ang) * 0.12);
        leaf.rotation.z = Math.cos(ang) * 0.35;
        leaf.rotation.x = Math.sin(ang) * 0.35;
        visualRoot.add(leaf);
      }
      group.userData.animOffset = visualRoot;
      break;
    }
    case 'furniture': {
      const seat = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.08, 0.6), matPrimary);
      seat.position.y = 0.4;
      visualRoot.add(seat);
      const legPositions = [[-0.25,-0.25],[0.25,-0.25],[-0.25,0.25],[0.25,0.25]];
      legPositions.forEach(([x,z]) => {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.4, 0.06), matSecondary);
        leg.position.set(x, 0.2, z);
        visualRoot.add(leg);
      });
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.5, 0.08), matSecondary);
      back.position.set(0, 0.69, -0.26);
      visualRoot.add(back);
      break;
    }
    case 'crystal': {
      const cluster = 5;
      for (let i = 0; i < cluster; i++) {
        const h = 0.35 + Math.random() * 0.4;
        const crystal = new THREE.Mesh(new THREE.ConeGeometry(0.1 + Math.random()*0.05, h, 6), i % 2 === 0 ? matPrimary : matSecondary);
        const ang = (i / cluster) * Math.PI * 2;
        crystal.position.set(Math.cos(ang) * 0.15, h/2 - 0.05, Math.sin(ang) * 0.15);
        crystal.rotation.y = Math.random() * Math.PI;
        crystal.rotation.z = (Math.random() - 0.5) * 0.25;
        visualRoot.add(crystal);
      }
      group.userData.animOffset = visualRoot;
      break;
    }
    case 'lamp': {
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.2, 0.06, 16), matSecondary);
      visualRoot.add(base);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.6, 8), matSecondary);
      pole.position.y = 0.33;
      visualRoot.add(pole);
      const shade = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.28, 16, 1, true), new THREE.MeshStandardMaterial({ color: primary, emissive: primary, emissiveIntensity: 0.6, side: THREE.DoubleSide, transparent: true, opacity: 0.92 }));
      shade.position.y = 0.68;
      visualRoot.add(shade);
      const bulbLight = new THREE.PointLight(primary, 0.8, 2);
      bulbLight.position.y = 0.6;
      visualRoot.add(bulbLight);
      break;
    }
    case 'floating_orb': {
      const orb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.22, 1), new THREE.MeshStandardMaterial({ color: primary, emissive: primary, emissiveIntensity: 0.55, roughness: 0.2, metalness: 0.4, wireframe: false, transparent: true, opacity: 0.92 }));
      orb.position.y = 0.4;
      visualRoot.add(orb);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.015, 8, 48), matSecondary);
      ring.rotation.x = Math.PI / 2.3;
      ring.position.y = 0.4;
      visualRoot.add(ring);
      group.userData.animOffset = orb;
      group.userData.floaty = true;
      break;
    }
    default: { // abstract_shape
      const shape = new THREE.Mesh(new THREE.TorusKnotGeometry(0.22, 0.07, 100, 16), matPrimary);
      shape.position.y = 0.35;
      visualRoot.add(shape);
      group.userData.animOffset = shape;
      group.userData.floaty = true;
    }
  }

  group.scale.setScalar(scale);
  group.userData.spec = spec;
  group.userData.animMode = spec.animation || 'idle_bob';
  group.userData.spawnTime = performance.now();
  return group;
}

export { clamp };
