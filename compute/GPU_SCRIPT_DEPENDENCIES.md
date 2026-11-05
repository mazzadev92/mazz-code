# Dependencies installed by the GPU server script (compute/gpu_server_body.py)

Every `pip install` is pinned with `==` (checked by tests/compute/test_pins.py). Versions were read on PyPI on 2026-11-05 and the
sets were checked with `pip install --dry-run` (resolver, Python 3.12, manylinux): no conflict. The Kaggle logs of the earlier
runs are gone (kernels deleted at stop), so these are current stable releases, not the versions of a past live run.
To bump one: change the pin, re-run the dry-run, then one live test.

| Package | Version | Engine | Why |
|---|---|---|---|
| huggingface_hub | 2.4.0 | all | model download, announcement upload/delete |
| llama-cpp-python[server] | 0.3.19 | llama | OpenAI-compatible GGUF server; newest wheel on the cu124 index (abetlen.github.io/llama-cpp-python/whl/cu124) for cp311/cp312 |
| nvidia-cuda-runtime-cu12 | 12.4.127 | llama | libcudart.so.12 for the cu124 wheel (images with CUDA 13 lack it) |
| nvidia-cublas-cu12 | 12.4.5.8 | llama | libcublas for the cu124 wheel |
| vllm | 0.33.0 | vllm | HF repos with vLLM. NOT resolver-checked here (its Windows-only markers break a cross-platform dry-run); no live run on Kaggle/Colab |
| diffusers | 0.42.1 | diffusers, diffusers_video | pipelines (SDXL Turbo, Wan 2.1) |
| transformers | 5.22.1 | diffusers*, triposr | text encoders / ViT; compatible with huggingface_hub 2.x (4.x needs hub < 1) |
| accelerate | 1.15.0 | diffusers* | CPU offload, device placement |
| safetensors | 0.8.0 | diffusers* | weights |
| sentencepiece | 0.2.3 | diffusers_video | tokenizer |
| ftfy | 6.3.1 | diffusers_video | text cleaning in WanPipeline |
| imageio / imageio-ffmpeg | 2.38.1 / 0.8.1 | diffusers_video, triposr | mp4 writer |
| fastapi / uvicorn | 0.162.0 / 0.54.0 | media engines | the engine's HTTP server |
| omegaconf | 2.3.0 | triposr | TripoSR config (version of its requirements.txt) |
| einops, trimesh, rembg, onnxruntime | 0.8.2, 5.2.0, 2.0.86, 1.31.1 | triposr | TripoSR requirements minus UI/texture parts; transformers 5.x with TripoSR is untested |
| torchmcubes | git commit a9ac95aa | triposr | pinned commit SHA |
| TripoSR (git) | 107cefdc | triposr | pinned commit SHA |

## TRELLIS (engine `trellis`, Colab L4/A100 only) - written, NEVER run live

Source: https://github.com/microsoft/TRELLIS at commit 193e0502b5cb3eb5997ec457d5340e95d09b158e (read; MIT), model microsoft/TRELLIS-image-large (3.3 GB, MIT).
Pinned: FlexiCubes 815e075a (submodule gitlink), nvdiffrast 253ac4fc, diffoctreerast b09c20b8 (+ its glm submodule), mip-splatting dda02ab5
(diff-gaussian-rasterization), utils3d 9a4eb15e (the SHA of setup.sh), spconv-cu120 2.3.6, open3d 0.20.0, xatlas 0.0.11, pyvista 0.49.2,
pymeshfix 0.18.1, igraph 1.0.0, easydict 1.13, opencv-python-headless 5.0.0.93, scipy 1.18.1, ninja 1.13.2 (plus rembg, trimesh, onnxruntime, transformers, imageio as above).
Attention backend forced to `sdpa` (no flash-attn / xformers build), `SPCONV_ALGO=native`.

Why there was no live test (the install cannot be shown reproducible):
- the official stack is torch 2.4.0 + CUDA 11.8/12.1 on Python 3.10; a Colab image ships a newer torch/CUDA/Python/numpy and the script keeps the image's torch (untested combination; `kaolin` wheels exist only per exact torch version and were left out);
- three CUDA extensions are compiled on the VM against that torch (minutes, depends on the image's nvcc);
- at run time `TrellisImageTo3DPipeline` downloads unpinned third-party code and weights (`torch.hub.load('facebookresearch/dinov2')`, rembg u2net) that no pin here covers.
To make it reproducible: build a container/wheelhouse with torch 2.4.0+cu121 and the compiled extensions once, pin that, then test on a Colab L4.

Colab GPU option: `colab new --gpu` accepts T4, L4, G4, H100, A100 (read from `colab new --help`); MAZZ offers t4 (default), l4, a100
(a100 refused unless options.confirm_cost is true). The CLI does not print compute-unit prices; Google's published rates are roughly
T4 1.8, L4 4.8, A100 11.8 units/hour (not verified by the CLI).
