/* ============================================================
   physics.js
   Cannon-es による重力・衝突・積み重ね処理
============================================================ */
import * as CANNON from 'cannon-es';

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

export function createPhysicsWorld() {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
  world.broadphase = new CANNON.SAPBroadphase(world);
  world.allowSleep = true;
  world.solver.iterations = 8;
  return world;
}

let _lastFrameTime = null;
export function clockDelta() {
  const now = performance.now();
  if (_lastFrameTime === null) {
    _lastFrameTime = now;
    return 1 / 60;
  }
  const dt = Math.min((now - _lastFrameTime) / 1000, 1 / 20); // clamp to avoid big jumps
  _lastFrameTime = now;
  return dt;
}

export function syncMeshesToPhysics(physicsBodies) {
  for (const pb of physicsBodies) {
    pb.mesh.position.copy(pb.body.position);
    pb.mesh.quaternion.copy(pb.body.quaternion);
  }
}

/* Add a static collider (thin box) for a detected/placed plane so that
   physics bodies can land on it and on top of each other. */
export function addPlaneCollider(world, planeColliders, positionVec3, quaternion, halfExtents = { x: 1.2, y: 0.01, z: 1.2 }) {
  const shape = new CANNON.Box(new CANNON.Vec3(halfExtents.x, halfExtents.y, halfExtents.z));
  const body = new CANNON.Body({ mass: 0, shape });
  body.position.set(positionVec3.x, positionVec3.y - halfExtents.y, positionVec3.z);
  body.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
  world.addBody(body);
  planeColliders.push(body);
  return body;
}

/* Avoid stacking duplicate colliders on (roughly) the same spot —
   reuse an existing one within ~25cm, otherwise add a new static plane. */
const PLANE_COLLIDER_MERGE_DIST = 0.25;
export function ensurePlaneColliderNear(world, planeColliders, posVec3, quaternion) {
  for (const body of planeColliders) {
    const dx = body.position.x - posVec3.x;
    const dz = body.position.z - posVec3.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < PLANE_COLLIDER_MERGE_DIST) return body; // reuse
  }
  return addPlaneCollider(world, planeColliders, posVec3, quaternion);
}

/* Build a CANNON.Body matching the rough shape of the visual object,
   approximated as a box/sphere depending on object_type, so it can
   fall, collide, and stack naturally. */
export function addPhysicsBodyForGroup(world, physicsBodies, group, spec, dropHeight = 0.15) {
  const scale = group.scale.x;
  let shape;
  let mass = 1;

  switch (spec.object_type) {
    case 'floating_orb':
    case 'crystal':
    case 'abstract_shape':
      shape = new CANNON.Sphere(0.32 * scale);
      mass = 0.4; // lighter, these "float" visually too
      break;
    case 'creature':
      shape = new CANNON.Box(new CANNON.Vec3(0.32 * scale, 0.45 * scale, 0.4 * scale));
      mass = 1.2;
      break;
    case 'furniture':
      shape = new CANNON.Box(new CANNON.Vec3(0.32 * scale, 0.4 * scale, 0.32 * scale));
      mass = 3.0; // heavier, harder to knock around
      break;
    case 'lamp':
      shape = new CANNON.Box(new CANNON.Vec3(0.2 * scale, 0.45 * scale, 0.2 * scale));
      mass = 1.0;
      break;
    case 'plant':
      shape = new CANNON.Box(new CANNON.Vec3(0.26 * scale, 0.45 * scale, 0.26 * scale));
      mass = 0.8;
      break;
    default:
      shape = new CANNON.Sphere(0.3 * scale);
      mass = 1.0;
  }

  const body = new CANNON.Body({
    mass,
    shape,
    position: new CANNON.Vec3(group.position.x, group.position.y + dropHeight, group.position.z),
    linearDamping: 0.35,
    angularDamping: 0.6,
  });
  body.quaternion.setFromEuler(0, group.rotation.y, 0);

  world.addBody(body);
  physicsBodies.push({ body, mesh: group });
  return body;
}

export { clamp };
