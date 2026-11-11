"""
MAZZ Code — Pipeline Haute Fidélité TRELLIS / TRELLIS.2 sur Modal
Génération d'assets 3D PBR (GLB, MP4 turntable, décomposition par couches, animations).
Stockage automatique sur votre depot Hugging Face (MAZZ_TRELLIS_REPO) et livraison locale.
"""

import os
import sys
import io
import time
import base64
import argparse
from pathlib import Path
from PIL import Image

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

import modal

# 1. Image Container Haute Performance
app_image = (
    modal.Image.from_registry("nvidia/cuda:12.4.1-devel-ubuntu22.04", add_python="3.11")
    .apt_install(
        "git", "ninja-build", "build-essential", "clang",
        "libgl1-mesa-glx", "libglib2.0-0", "libjpeg-dev", "ffmpeg",
        "libglm-dev", "libegl1", "libegl1-mesa", "libgl1-mesa-dev", "libgomp1"
    )
    .pip_install(
        "torch==2.6.0", "torchvision==0.21.0",
        index_url="https://download.pytorch.org/whl/cu124"
    )
    .pip_install(
        "imageio", "imageio-ffmpeg", "tqdm", "easydict", "opencv-python-headless",
        "ninja", "trimesh", "transformers", "pandas", "kornia", "timm", "pillow",
        "huggingface_hub", "rembg", "onnxruntime", "open3d", "xatlas", "pyvista",
        "pymeshfix", "igraph", "spconv-cu120==2.3.6"
    )
    .env({
        "TORCH_CUDA_ARCH_LIST": "8.0;8.6;8.9;9.0",
        "ATTN_BACKEND": "sdpa",
        "SPCONV_ALGO": "native",
        "OPENCV_IO_ENABLE_OPENEXR": "1"
    })
    .run_commands(
        "pip install flash-attn==2.7.3 --no-build-isolation",
        "pip install git+https://github.com/EasternJournalist/utils3d.git@9a4eb15e4021b67b12c460c7057d642626897ec8",
        "git clone -b v0.4.0 https://github.com/NVlabs/nvdiffrast.git /tmp/nvdiffrast && pip install /tmp/nvdiffrast --no-build-isolation",
        "git clone -b renderutils https://github.com/JeffreyXiang/nvdiffrec.git /tmp/nvdiffrec && pip install /tmp/nvdiffrec --no-build-isolation",
        "git clone --recursive https://github.com/JeffreyXiang/diffoctreerast.git /tmp/diffoctreerast && pip install /tmp/diffoctreerast --no-build-isolation",
        "git clone --recursive https://github.com/autonomousvision/mip-splatting.git /tmp/mip-splatting && pip install /tmp/mip-splatting/submodules/diff-gaussian-rasterization --no-build-isolation",
        "git clone https://github.com/microsoft/TRELLIS.git /opt/TRELLIS && git clone https://github.com/MaxtirError/FlexiCubes.git /opt/TRELLIS/trellis/representations/mesh/flexicubes",
        "git clone https://github.com/JeffreyXiang/CuMesh.git --recursive /tmp/CuMesh && pip install /tmp/CuMesh --no-build-isolation || true",
        "git clone -b main https://github.com/microsoft/TRELLIS.2.git --recursive /opt/TRELLIS.2 && pip install /opt/TRELLIS.2/o-voxel --no-build-isolation || true"
    )
)

# 2. Application Modal & Volume de Cache persistant
hf_token_val = os.environ.get("HF_TOKEN")
if not hf_token_val:
    _hf_tok_path = os.path.expanduser("~/.cache/huggingface/token")
    if os.path.exists(_hf_tok_path):
        with open(_hf_tok_path, "r") as f:
            hf_token_val = f.read().strip()

modal_secrets = []
if hf_token_val:
    modal_secrets.append(modal.Secret.from_dict({"HF_TOKEN": hf_token_val}))

app = modal.App("mazz-trellis-engine")
weights_volume = modal.Volume.from_name("trellis-weights-v1", create_if_missing=True)

# 3. Service d'Inférence Dédié (A100 40GB/80GB)
@app.cls(
    image=app_image,
    gpu="A100-40GB",
    timeout=900,
    volumes={"/cache": weights_volume},
    secrets=modal_secrets
)
class Trellis3DGenerator:
    @modal.enter()
    def initialize_models(self):
        import os
        import sys
        import types
        import torch

        # Mock kaolin pour flexicubes sans dépendance lourde
        if "kaolin" not in sys.modules:
            fake_k = types.ModuleType("kaolin")
            fake_ku = types.ModuleType("kaolin.utils")
            fake_kut = types.ModuleType("kaolin.utils.testing")
            fake_kut.check_tensor = lambda *a, **kw: True
            fake_ku.testing = fake_kut
            fake_k.utils = fake_ku
            sys.modules["kaolin"] = fake_k
            sys.modules["kaolin.utils"] = fake_ku
            sys.modules["kaolin.utils.testing"] = fake_kut

        os.environ["HF_HOME"] = "/cache/huggingface"
        os.environ["TORCH_HOME"] = "/cache/torch"
        os.environ["U2NET_HOME"] = "/cache/u2net"
        os.environ["ATTN_BACKEND"] = "sdpa"
        os.environ["SPCONV_ALGO"] = "native"

        if os.environ.get("HF_TOKEN"):
            try:
                from huggingface_hub import login
                login(token=os.environ["HF_TOKEN"])
            except Exception as e:
                print("HF login warning:", e)

        # Moteur TRELLIS Large (Open & Non-gated, compatible A100)
        self.engine_type = "trellis1"
        sys.path.insert(0, "/opt/TRELLIS")
        from huggingface_hub import snapshot_download
        from trellis.pipelines import TrellisImageTo3DPipeline

        print("Chargement des poids du modèle microsoft/TRELLIS-image-large...")
        model_dir = snapshot_download("microsoft/TRELLIS-image-large")
        self.pipeline = TrellisImageTo3DPipeline.from_pretrained(model_dir)
        self.pipeline.cuda()
        print("TRELLIS-image-large chargé avec succès sur CUDA A100.")

    @modal.method()
    def generate_3d_asset(
        self,
        image_bytes: bytes,
        asset_name: str,
        seed: int = 42,
        simplify: float = 0.95,
        texture_size: int = 2048,
        hf_token: str = None
    ) -> dict:
        import io
        import time
        from PIL import Image
        import numpy as np
        import imageio
        from huggingface_hub import HfApi

        start_time = time.time()
        input_im = Image.open(io.BytesIO(image_bytes))

        # Nettoyage automatique du fond (garantit transparence alpha propre)
        try:
            import rembg
            input_rgba = rembg.remove(input_im)
        except Exception:
            input_rgba = input_im.convert("RGBA")

        # Inférence 3D
        glb_bytes = None
        mp4_bytes = None

        if self.engine_type == "trellis2":
            import o_voxel
            mesh = self.pipeline.run(input_rgba.convert("RGB"))[0]
            mesh.simplify(16777216)
            glb_obj = o_voxel.postprocess.to_glb(
                vertices=mesh.vertices,
                faces=mesh.faces,
                attr_volume=mesh.attrs,
                coords=mesh.coords,
                attr_layout=mesh.layout,
                voxel_size=mesh.voxel_size,
                aabb=[[-0.5, -0.5, -0.5], [0.5, 0.5, 0.5]],
                decimation_target=int(500000 * (1.0 - simplify + 0.05)),
                texture_size=texture_size,
                remesh=True,
                verbose=False
            )
            glb_buf = io.BytesIO()
            glb_obj.export(glb_buf, file_type="glb")
            glb_bytes = glb_buf.getvalue()
        else:
            from trellis.utils import postprocessing_utils, render_utils
            out = self.pipeline.run(input_rgba, seed=seed, formats=['mesh', 'gaussian'])
            glb_obj = postprocessing_utils.to_glb(
                out["gaussian"][0],
                out["mesh"][0],
                simplify=simplify,
                texture_size=texture_size
            )
            glb_bytes = glb_obj.export(file_type="glb")
            if isinstance(glb_bytes, str):
                glb_bytes = glb_bytes.encode("utf-8")

            # Rendu vidéo 360° en couleur (Gaussiennes)
            try:
                video_frames = render_utils.render_video(out["gaussian"][0], num_frames=120)["color"]
                mp4_buf = io.BytesIO()
                imageio.mimsave(mp4_buf, video_frames, fps=24, format="mp4")
                mp4_bytes = mp4_buf.getvalue()
            except Exception as e:
                print("Vidéo non générée:", e)

        # Upload vers Hugging Face si token présent
        hf_url = None
        if hf_token and glb_bytes:
            try:
                api = HfApi(token=hf_token)
                repo_id = os.environ.get("MAZZ_TRELLIS_REPO", "").strip()
                if not repo_id:
                    print("MAZZ_TRELLIS_REPO non defini : asset 3D garde en local, aucun envoi Hugging Face.")
                    raise RuntimeError("depot de destination non configure")
                folder = os.environ.get("MAZZ_TRELLIS_FOLDER", "3d_assets")
                path_in_repo = f"{folder}/{asset_name}.glb"
                api.upload_file(
                    path_or_fileobj=glb_bytes,
                    path_in_repo=path_in_repo,
                    repo_id=repo_id,
                    repo_type="model",
                    commit_message=f"Add 3D asset: {asset_name}.glb"
                )
                hf_url = f"https://huggingface.co/{repo_id}/resolve/main/{path_in_repo}"

                if mp4_bytes:
                    api.upload_file(
                        path_or_fileobj=mp4_bytes,
                        path_in_repo=f"{folder}/{asset_name}_turntable.mp4",
                        repo_id=repo_id,
                        repo_type="model",
                        commit_message=f"Add turntable: {asset_name}"
                    )
            except Exception as exc:
                print(f"Erreur upload Hugging Face ({asset_name}):", exc)

        duration = time.time() - start_time
        return {
            "name": asset_name,
            "engine": self.engine_type,
            "glb_size": len(glb_bytes) if glb_bytes else 0,
            "mp4_size": len(mp4_bytes) if mp4_bytes else 0,
            "glb_bytes": glb_bytes,
            "mp4_bytes": mp4_bytes,
            "hf_url": hf_url,
            "duration": round(duration, 2),
            "status": "success"
        }


# 4. Orchestration Locale
def main():
    parser = argparse.ArgumentParser(description="Pipeline 3D TRELLIS sur Modal")
    parser.add_argument("--single", type=str, help="Générer un seul fichier PNG")
    parser.add_argument("--all", action="store_true", help="Générer tous les assets et étapes")
    parser.add_argument("--input-dir", type=str, default=os.environ.get("MAZZ_TRELLIS_INPUT", ""),
                        help="Dossier des PNG d'entrée (défaut : ./input_images)")
    parser.add_argument("--out-dir", type=str, default=os.environ.get("MAZZ_TRELLIS_OUTPUT", ""),
                        help="Dossier de sortie des modèles 3D (défaut : ./output_3d)")
    args = parser.parse_args()

    # Récupération du jeton Hugging Face local
    hf_token = os.environ.get("HF_TOKEN")
    if not hf_token:
        tok_file = os.path.expanduser("~/.cache/huggingface/token")
        if os.path.exists(tok_file):
            with open(tok_file, "r") as f:
                hf_token = f.read().strip()

    input_dir = Path(args.input_dir).resolve() if args.input_dir else (Path.cwd() / "input_images")
    output_dirs = [Path(args.out_dir).resolve()] if args.out_dir else [Path.cwd() / "output_3d"]
    if not input_dir.is_dir():
        raise SystemExit(f"Dossier d'entrée introuvable : {input_dir} (utilisez --input-dir)")
    for d in output_dirs:
        d.mkdir(parents=True, exist_ok=True)

    if args.single:
        target_files = [input_dir / args.single]
    else:
        all_candidates = sorted(list(input_dir.glob("*.png")))
        target_files = []
        for f in all_candidates:
            if (output_dirs[0] / f"{f.stem}.glb").exists():
                print(f"[Déjà présent] {f.stem}.glb")
            else:
                target_files.append(f)

    print(f"Démarrage du pipeline 3D sur Modal ({len(target_files)} assets à traiter)...")
    with app.run():
        generator = Trellis3DGenerator()
        for idx, img_path in enumerate(target_files, 1):
            asset_name = img_path.stem
            print(f"[{idx}/{len(target_files)}] Inférence 3D pour {asset_name}...")
            with open(img_path, "rb") as f:
                raw_bytes = f.read()

            result = generator.generate_3d_asset.remote(
                image_bytes=raw_bytes,
                asset_name=asset_name,
                texture_size=2048,
                simplify=0.95,
                hf_token=hf_token
            )

            # Sauvegarde locale
            if result.get("glb_bytes"):
                for d in output_dirs:
                    glb_path = d / f"{asset_name}.glb"
                    with open(glb_path, "wb") as f_out:
                        f_out.write(result["glb_bytes"])
                print(f"  -> GLB sauvegardé ({result['glb_size'] / 1024:.1f} Ko) en {result['duration']}s")

            if result.get("mp4_bytes"):
                for d in output_dirs:
                    mp4_path = d / f"{asset_name}_turntable.mp4"
                    with open(mp4_path, "wb") as f_out:
                        f_out.write(result["mp4_bytes"])

            if result.get("hf_url"):
                print(f"  -> Hugging Face: {result['hf_url']}")

    print("Pipeline 3D terminé avec succès.")

if __name__ == "__main__":
    main()
