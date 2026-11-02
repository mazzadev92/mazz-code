import { useEffect, useRef, useState } from 'react';

/**
 * 3D viewer for a .glb produced by extract_game_3d (spec 08 §4): orbit rotation, pan and wheel zoom.
 * three.js and its loaders are imported dynamically, so they stay out of the main bundle and are only
 * downloaded when a model is actually shown.
 */

export function model3dUrl(glbPath: string, sessionId?: string): string {
  const query = new URLSearchParams({ path: glbPath });
  if (sessionId) query.set('sessionId', sessionId);
  return `/api/files/model3d?${query.toString()}`;
}

type ViewerState = { kind: 'loading' } | { kind: 'ready'; vertices: number; triangles: number } | { kind: 'error'; message: string };

export function Model3DViewer({ src, label, height = 360 }: { src: string; label: string; height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<ViewerState>({ kind: 'loading' });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let cleanup: () => void = () => {};
    setState({ kind: 'loading' });
    (async () => {
      const [THREE, { GLTFLoader }, { OrbitControls }] = await Promise.all([
        import('three'),
        import('three/examples/jsm/loaders/GLTFLoader.js'),
        import('three/examples/jsm/controls/OrbitControls.js'),
      ]);
      if (disposed) return;
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      const scene = new THREE.Scene();
      scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 2.5));
      const sun = new THREE.DirectionalLight(0xffffff, 2);
      sun.position.set(3, 5, 4);
      scene.add(sun);
      const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10_000);
      const controls = new OrbitControls(camera, canvas);
      controls.enableDamping = true;
      let frame = 0;
      const resize = () => {
        const { clientWidth, clientHeight } = canvas;
        renderer.setSize(clientWidth, clientHeight, false);
        camera.aspect = clientWidth / Math.max(1, clientHeight);
        camera.updateProjectionMatrix();
      };
      const observer = new ResizeObserver(resize);
      observer.observe(canvas);
      cleanup = () => {
        cancelAnimationFrame(frame);
        observer.disconnect();
        controls.dispose();
        renderer.dispose();
      };
      const gltf = await new GLTFLoader().loadAsync(src);
      if (disposed) return;
      scene.add(gltf.scene);
      // Frame the model: centre it and back the camera off by its bounding sphere.
      const sphere = new THREE.Box3().setFromObject(gltf.scene).getBoundingSphere(new THREE.Sphere());
      const radius = sphere.radius || 1;
      controls.target.copy(sphere.center);
      camera.position.copy(sphere.center).add(new THREE.Vector3(radius * 1.6, radius * 1.1, radius * 1.6));
      camera.near = radius / 100;
      camera.far = radius * 100;
      resize();
      let vertices = 0;
      let triangles = 0;
      gltf.scene.traverse((node) => {
        const geometry = (node as { geometry?: import('three').BufferGeometry }).geometry;
        if (!geometry) return;
        const count = geometry.getAttribute('position')?.count ?? 0;
        vertices += count;
        triangles += (geometry.index?.count ?? count) / 3;
      });
      setState({ kind: 'ready', vertices, triangles: Math.round(triangles) });
      const loop = () => {
        controls.update();
        renderer.render(scene, camera);
        frame = requestAnimationFrame(loop);
      };
      loop();
    })().catch((err: unknown) => {
      if (!disposed) setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    });
    return () => {
      disposed = true;
      cleanup();
    };
  }, [src]);

  return (
    <figure className="rounded border border-line bg-code overflow-hidden" role="group" aria-label={`Modèle 3D : ${label}`}>
      <canvas
        ref={canvasRef}
        className="block w-full"
        style={{ height }}
        role="img"
        tabIndex={0}
        aria-label={`Vue 3D interactive de ${label} : glisser pour tourner, clic droit pour déplacer, molette pour zoomer.`}
      />
      <figcaption className="px-2 py-1 text-[11px] text-faint flex gap-2">
        <span className="font-mono truncate">{label}</span>
        {state.kind === 'loading' && <span role="status">Chargement du modèle…</span>}
        {state.kind === 'ready' && <span role="status">{state.vertices} sommets, {state.triangles} triangles</span>}
        {state.kind === 'error' && <span role="alert" className="text-bad">Affichage impossible : {state.message}</span>}
      </figcaption>
    </figure>
  );
}
