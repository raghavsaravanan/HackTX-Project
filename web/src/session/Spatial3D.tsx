import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, type KeyboardEvent } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { MAX_RANGE_M, type Placed, type Reconstruction } from "../lib/reconstruct.ts";
import { CAMERA_HEIGHT_M } from "../lib/spatial.ts";

export type ViewPreset = "overview" | "user" | "top";

export interface Spatial3DHandle {
  view: (preset: ViewPreset) => void;
  zoom: (factor: number) => void;
  rotate: (azimuth: number, polar: number) => void;
}

interface Props {
  rec: Reconstruction;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Placed object ids in task order, for the route. */
  route: string[];
  showImage: boolean;
  reducedMotion: boolean;
  onError: (message: string) => void;
}

const COLOR = {
  observed: 0xe0603f,
  estimated: 0x2f7681,
  earlier: 0x8a948f,
  hand: 0x5aa37a,
  selected: 0x173c34,
  route: 0xb4462f,
  floor: 0xe7e3d9,
  wedge: 0xd7e7d8,
  ring: 0xc5cbc4,
  user: 0x173c34,
};

const IMAGE_DISTANCE = 2.4;
const PRESETS: Record<ViewPreset, { pos: [number, number, number]; target: [number, number, number] }> = {
  overview: { pos: [4.6, 4.4, 3.4], target: [0, 0.5, -2.2] },
  user: { pos: [0, CAMERA_HEIGHT_M + 0.15, 0.9], target: [0, 0.9, -3] },
  top: { pos: [0, 10.5, -2.4], target: [0, 0, -2.5] },
};

const rad = (deg: number) => (deg * Math.PI) / 180;

interface Ctx {
  renderer: THREE.WebGLRenderer;
  labels: CSS2DRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  dynamic: THREE.Group;
  frustum: THREE.Group;
  imagePlane: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  pickables: THREE.Object3D[];
  needsRender: boolean;
  tween: { from: THREE.Vector3; to: THREE.Vector3; fromT: THREE.Vector3; toT: THREE.Vector3; start: number } | null;
  raf: number;
  imageSrc: string;
}

function label(text: string, className: string, onClick?: () => void): CSS2DObject {
  const el = document.createElement("div");
  el.className = className;
  el.textContent = text;
  el.setAttribute("aria-hidden", "true");
  if (onClick) {
    el.addEventListener("pointerdown", (e) => e.stopPropagation());
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
  }
  return new CSS2DObject(el);
}

function flatLine(points: THREE.Vector3[], color: number, dashed = false, opacity = 1): THREE.Line {
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = dashed
    ? new THREE.LineDashedMaterial({ color, dashSize: 0.12, gapSize: 0.08, transparent: opacity < 1, opacity })
    : new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity });
  const line = new THREE.Line(geometry, material);
  if (dashed) line.computeLineDistances();
  return line;
}

function disposeTree(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    mesh.geometry?.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat?.dispose();
    if (o instanceof CSS2DObject) o.element.remove();
  });
}

/** Static parts: the assumed floor, the observed wedge, distance rings, and the user with the phone. */
function buildStatic(scene: THREE.Scene, fovH: number) {
  scene.add(new THREE.HemisphereLight(0xffffff, 0xd8d2c4, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 0.7);
  sun.position.set(3, 6, 2);
  scene.add(sun);

  const floor = new THREE.Mesh(new THREE.CircleGeometry(14, 72), new THREE.MeshBasicMaterial({ color: COLOR.floor }));
  floor.rotation.x = -Math.PI / 2;
  floor.name = "floor";
  scene.add(floor);

  for (const r of [1, 2, 3, 4, 5, 6]) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(r - 0.006, r + 0.006, 128),
      new THREE.MeshBasicMaterial({ color: COLOR.ring, transparent: true, opacity: r % 2 ? 0.45 : 0.85 }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.004;
    scene.add(ring);
    if (r % 2 === 0) {
      const tag = label(`${r} m`, "s3d-ring");
      tag.position.set(-0.22, 0.01, -r);
      scene.add(tag);
    }
  }

  const user = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CircleGeometry(0.2, 32), new THREE.MeshBasicMaterial({ color: COLOR.user }));
  base.rotation.x = -Math.PI / 2;
  base.position.y = 0.006;
  user.add(base);
  user.add(flatLine([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, CAMERA_HEIGHT_M, 0)], COLOR.user, true, 0.7));
  const phone = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.16, 0.012), new THREE.MeshLambertMaterial({ color: COLOR.user }));
  phone.position.set(0, CAMERA_HEIGHT_M, 0);
  user.add(phone);
  const heading = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0.02, 0), 0.75, COLOR.user, 0.18, 0.12);
  user.add(heading);
  const you = label("You · phone at chest height", "s3d-you");
  you.position.set(0, CAMERA_HEIGHT_M + 0.28, 0);
  user.add(you);
  scene.add(user);

  const behind = label("Not observed", "s3d-unobserved");
  behind.position.set(0, 0.01, 2.6);
  scene.add(behind);
  const side = label("Not observed", "s3d-unobserved");
  side.position.set(-MAX_RANGE_M * 0.78, 0.01, -1.2);
  scene.add(side);

  return buildWedge(scene, fovH);
}

function buildWedge(scene: THREE.Scene, fovH: number): THREE.Group {
  const group = new THREE.Group();
  const fov = rad(fovH);
  const wedge = new THREE.Mesh(
    new THREE.CircleGeometry(MAX_RANGE_M, 48, Math.PI / 2 - fov / 2, fov),
    new THREE.MeshBasicMaterial({ color: COLOR.wedge, transparent: true, opacity: 0.95, depthWrite: false }),
  );
  wedge.rotation.x = -Math.PI / 2;
  wedge.position.y = 0.002;
  group.add(wedge);
  for (const side of [-1, 1]) {
    const edge = new THREE.Vector3(side * MAX_RANGE_M * Math.sin(fov / 2), 0.008, -MAX_RANGE_M * Math.cos(fov / 2));
    group.add(flatLine([new THREE.Vector3(0, 0.008, 0), edge], 0x7fae8c, false, 0.8));
  }
  const tag = label("Camera view (observed)", "s3d-wedge");
  tag.position.set(0, 0.01, -MAX_RANGE_M - 0.35);
  group.add(tag);
  scene.add(group);
  return group;
}

/** The real camera frame, placed where the camera saw it, with the frustum lines from the phone. */
function buildFrustum(scene: THREE.Scene, fovH: number, fovV: number) {
  const w = 2 * IMAGE_DISTANCE * Math.tan(rad(fovH / 2));
  const h = 2 * IMAGE_DISTANCE * Math.tan(rad(fovV / 2));
  const group = new THREE.Group();
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }),
  );
  plane.position.set(0, CAMERA_HEIGHT_M, -IMAGE_DISTANCE);
  plane.visible = false;
  group.add(plane);
  const eye = new THREE.Vector3(0, CAMERA_HEIGHT_M, 0);
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ]) {
    group.add(flatLine([eye, new THREE.Vector3((sx * w) / 2, CAMERA_HEIGHT_M + (sy * h) / 2, -IMAGE_DISTANCE)], 0x6f8f86, true, 0.55));
  }
  scene.add(group);
  return { group, plane };
}

export const Spatial3D = forwardRef<Spatial3DHandle, Props>(function Spatial3D({ rec, selectedId, onSelect, route, showImage, reducedMotion, onError }, ref) {
  const mountRef = useRef<HTMLDivElement>(null);
  const ctxRef = useRef<Ctx | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const fovKey = `${rec.fov.h}x${rec.fov.v}`;
  const fovRef = useRef(rec.fov);
  fovRef.current = rec.fov;

  // One renderer for the life of the view.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    } catch {
      onError("This browser could not start 3D graphics (WebGL). The spatial summary below has the same information.");
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0xf4f1e9);
    mount.appendChild(renderer.domElement);
    const labels = new CSS2DRenderer();
    labels.domElement.className = "s3d-labels";
    mount.appendChild(labels.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0xf4f1e9, 13, 28);
    const camera = new THREE.PerspectiveCamera(48, 1, 0.05, 80);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !reducedMotion;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI / 2 - 0.04;
    controls.minDistance = 0.8;
    controls.maxDistance = 20;
    controls.screenSpacePanning = true;

    buildStatic(scene, fovRef.current.h);
    const { group: frustum, plane } = buildFrustum(scene, fovRef.current.h, fovRef.current.v);
    const dynamic = new THREE.Group();
    scene.add(dynamic);

    const ctx: Ctx = {
      renderer,
      labels,
      scene,
      camera,
      controls,
      dynamic,
      frustum,
      imagePlane: plane,
      pickables: [],
      needsRender: true,
      tween: null,
      raf: 0,
      imageSrc: "",
    };
    ctxRef.current = ctx;
    const preset = PRESETS.overview;
    camera.position.set(...preset.pos);
    controls.target.set(...preset.target);
    controls.update();

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = mount;
      if (!w || !h) return;
      renderer.setSize(w, h);
      labels.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      ctx.needsRender = true;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    resize();

    controls.addEventListener("change", () => (ctx.needsRender = true));

    const loop = (t: number) => {
      ctx.raf = requestAnimationFrame(loop);
      if (ctx.tween) {
        const k = Math.min(1, (t - ctx.tween.start) / 450);
        const e = 1 - Math.pow(1 - k, 3);
        camera.position.lerpVectors(ctx.tween.from, ctx.tween.to, e);
        controls.target.lerpVectors(ctx.tween.fromT, ctx.tween.toT, e);
        if (k >= 1) ctx.tween = null;
        ctx.needsRender = true;
      }
      const moved = controls.update();
      if (moved || ctx.needsRender) {
        renderer.render(scene, camera);
        labels.render(scene, camera);
        ctx.needsRender = false;
      }
    };
    ctx.raf = requestAnimationFrame(loop);

    // A click that doesn't drag selects what is under the pointer.
    const down = { x: 0, y: 0 };
    const raycaster = new THREE.Raycaster();
    const onDown = (e: PointerEvent) => {
      down.x = e.clientX;
      down.y = e.clientY;
    };
    const onUp = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const pointer = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObjects(ctx.pickables, false)[0];
      onSelectRef.current((hit?.object.userData.id as string | undefined) ?? null);
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);

    return () => {
      cancelAnimationFrame(ctx.raf);
      observer.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointerup", onUp);
      controls.dispose();
      disposeTree(scene);
      plane.material.map?.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      labels.domElement.remove();
      ctxRef.current = null;
    };
  }, []);

  // The field of view follows the frame orientation (portrait or landscape).
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const wedge = ctx.scene.children.find((o) => o instanceof THREE.Group && o.children.some((c) => c instanceof CSS2DObject && c.element.className === "s3d-wedge"));
    if (wedge) {
      disposeTree(wedge);
      ctx.scene.remove(wedge);
    }
    buildWedge(ctx.scene, rec.fov.h);
    const map = ctx.imagePlane.material.map;
    disposeTree(ctx.frustum);
    ctx.scene.remove(ctx.frustum);
    const { group, plane } = buildFrustum(ctx.scene, rec.fov.h, rec.fov.v);
    if (map) {
      plane.material.map = map;
      plane.material.needsUpdate = true;
    }
    ctx.frustum = group;
    ctx.imagePlane = plane;
    ctx.imageSrc = "";
    ctx.needsRender = true;
  }, [fovKey, rec.fov.h, rec.fov.v]);

  // The latest real camera frame inside the camera's field of view.
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    const src = rec.frame?.image ?? "";
    ctx.imagePlane.visible = showImage && Boolean(src);
    ctx.imagePlane.material.opacity = rec.frame?.fresh ? 0.92 : 0.5;
    ctx.needsRender = true;
    if (!src || src === ctx.imageSrc) return;
    ctx.imageSrc = src;
    const img = new Image();
    img.onload = () => {
      if (ctxRef.current !== ctx || ctx.imageSrc !== src) return;
      const texture = ctx.imagePlane.material.map ?? new THREE.Texture();
      texture.image = img;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.needsUpdate = true;
      ctx.imagePlane.material.map = texture;
      ctx.imagePlane.material.needsUpdate = true;
      ctx.needsRender = true;
    };
    img.src = src;
  }, [rec.frame?.image, rec.frame?.fresh, showImage, fovKey]);

  // Objects, distance ranges, the route, and the selection.
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    disposeTree(ctx.dynamic);
    ctx.dynamic.clear();
    ctx.pickables = [];
    const byId = new Map(rec.objects.map((p) => [p.id, p]));

    for (const p of rec.objects) addObject(ctx, p, p.id === selectedId, () => onSelectRef.current(p.id));

    const stops = route.map((id) => byId.get(id)).filter((p): p is Placed => Boolean(p));
    if (stops.length) {
      const points = [new THREE.Vector3(0, 0.03, 0), ...stops.map((p) => new THREE.Vector3(p.x, 0.03, p.z))];
      ctx.dynamic.add(flatLine(points, COLOR.route, true, 0.9));
      stops.forEach((p, i) => {
        const tag = label(String(i + 1), "s3d-step");
        tag.position.set(p.x, 0.05, p.z);
        ctx.dynamic.add(tag);
      });
    }

    const target = rec.objects.find((p) => p.role === "target");
    const destination = rec.objects.find((p) => p.role === "destination");
    if (target && destination) {
      const from = new THREE.Vector3(target.x, target.y, target.z);
      const to = new THREE.Vector3(destination.x, destination.y, destination.z);
      const dir = to.clone().sub(from);
      const length = dir.length();
      if (length > 0.05) ctx.dynamic.add(new THREE.ArrowHelper(dir.normalize(), from, length, COLOR.route, Math.min(0.25, length / 3), 0.1));
    }

    const selected = selectedId ? byId.get(selectedId) : undefined;
    if (selected) {
      // Direction is observed: the ray from the phone through where the object appeared in the frame.
      const eye = new THREE.Vector3(0, CAMERA_HEIGHT_M, 0);
      const dir = new THREE.Vector3(selected.x, selected.y, selected.z).sub(eye).normalize();
      const far = eye.clone().add(dir.multiplyScalar(Math.max(selected.distance.max, 1)));
      ctx.dynamic.add(flatLine([eye, far], COLOR.selected, true, 0.85));
    }
    ctx.needsRender = true;
  }, [rec.objects, route, selectedId]);

  const handle = useMemo<Spatial3DHandle>(
    () => ({
      view(preset) {
        const ctx = ctxRef.current;
        if (!ctx) return;
        const p = PRESETS[preset];
        const to = new THREE.Vector3(...p.pos);
        const toT = new THREE.Vector3(...p.target);
        if (reducedMotion) {
          ctx.camera.position.copy(to);
          ctx.controls.target.copy(toT);
          ctx.controls.update();
          ctx.needsRender = true;
          return;
        }
        ctx.tween = { from: ctx.camera.position.clone(), to, fromT: ctx.controls.target.clone(), toT, start: performance.now() };
      },
      zoom(factor) {
        const ctx = ctxRef.current;
        if (!ctx) return;
        const offset = ctx.camera.position.clone().sub(ctx.controls.target);
        const length = THREE.MathUtils.clamp(offset.length() * factor, ctx.controls.minDistance, ctx.controls.maxDistance);
        ctx.camera.position.copy(ctx.controls.target).add(offset.setLength(length));
        ctx.controls.update();
        ctx.needsRender = true;
      },
      rotate(azimuth, polar) {
        const ctx = ctxRef.current;
        if (!ctx) return;
        const offset = ctx.camera.position.clone().sub(ctx.controls.target);
        const s = new THREE.Spherical().setFromVector3(offset);
        s.theta += azimuth;
        s.phi = THREE.MathUtils.clamp(s.phi + polar, 0.12, ctx.controls.maxPolarAngle);
        ctx.camera.position.copy(ctx.controls.target).add(new THREE.Vector3().setFromSpherical(s));
        ctx.controls.update();
        ctx.needsRender = true;
      },
    }),
    [reducedMotion],
  );
  useImperativeHandle(ref, () => handle, [handle]);

  const onKey = (e: KeyboardEvent) => {
    const step = Math.PI / 24;
    const actions: Record<string, () => void> = {
      ArrowLeft: () => handle.rotate(step, 0),
      ArrowRight: () => handle.rotate(-step, 0),
      ArrowUp: () => handle.rotate(0, -step / 2),
      ArrowDown: () => handle.rotate(0, step / 2),
      "+": () => handle.zoom(0.85),
      "=": () => handle.zoom(0.85),
      "-": () => handle.zoom(1.18),
      Escape: () => onSelect(null),
    };
    const act = actions[e.key];
    if (act) {
      e.preventDefault();
      act();
    }
  };

  return (
    <div
      ref={mountRef}
      className="s3d-mount"
      tabIndex={0}
      role="application"
      aria-roledescription="3D map"
      aria-label="Interactive 3D Quest Map. Drag to rotate, scroll to zoom, right-drag to pan. Arrow keys rotate, plus and minus zoom. The spatial summary lists the same information as text."
      onKeyDown={onKey}
    />
  );
});

function addObject(ctx: Ctx, p: Placed, selected: boolean, select: () => void) {
  const color = selected ? COLOR.selected : p.role === "hand" ? COLOR.hand : COLOR[p.provenance];
  const group = new THREE.Group();

  // Where along the observed direction the object could be: the estimated distance range.
  const half = rad(Math.max(2.5, p.angularWidthDeg / 2));
  const center = Math.PI / 2 - rad(p.azimuthDeg);
  const band = new THREE.Mesh(
    new THREE.RingGeometry(p.distance.min, p.distance.max, 40, 1, center - half, half * 2),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: p.distance.basis === "unclear" ? 0.07 : selected ? 0.26 : 0.15, depthWrite: false }),
  );
  band.rotation.x = -Math.PI / 2;
  band.position.y = 0.005;
  ctx.dynamic.add(band);

  group.position.set(p.x, 0, p.z);
  group.rotation.y = -rad(p.azimuthDeg);
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.05, 20), new THREE.MeshBasicMaterial({ color }));
  dot.rotation.x = -Math.PI / 2;
  dot.position.y = 0.007;
  group.add(dot);

  let top = p.y;
  if (p.sized) {
    const depth = Math.min(p.width, 0.5);
    const geometry = new THREE.BoxGeometry(p.width, p.height, depth);
    const body = new THREE.Mesh(
      geometry,
      new THREE.MeshLambertMaterial({ color, transparent: true, opacity: p.provenance === "observed" ? 0.36 : 0.18, depthWrite: false }),
    );
    body.position.y = p.y;
    body.userData.id = p.id;
    group.add(body);
    ctx.pickables.push(body);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      p.provenance === "observed" ? new THREE.LineBasicMaterial({ color }) : new THREE.LineDashedMaterial({ color, dashSize: 0.05, gapSize: 0.04 }),
    );
    edges.position.y = p.y;
    edges.computeLineDistances();
    group.add(edges);
    top = p.y + p.height / 2;
    const bottom = p.y - p.height / 2;
    if (bottom > 0.05) group.add(flatLine([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, bottom, 0)], color, true, 0.6));
  } else {
    const marker = new THREE.Mesh(new THREE.OctahedronGeometry(0.09), new THREE.MeshLambertMaterial({ color }));
    marker.position.y = Math.max(p.y, 0.2);
    marker.userData.id = p.id;
    group.add(marker);
    ctx.pickables.push(marker);
    group.add(flatLine([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, marker.position.y, 0)], color, true, 0.6));
    top = marker.position.y + 0.1;
  }

  const tag = label(p.label, `s3d-label prov-${p.provenance}${p.role === "hand" ? " role-hand" : ""}${selected ? " selected" : ""}${p.hazard ? " hazard" : ""}`, select);
  tag.position.set(0, top + 0.16, 0);
  group.add(tag);
  ctx.dynamic.add(group);
}

export default Spatial3D;
