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
