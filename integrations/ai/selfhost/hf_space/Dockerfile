FROM ghcr.io/ggml-org/llama.cpp:server
ENV PORT=7860
EXPOSE 7860
CMD ["sh", "-c", "exec llama-server --host 0.0.0.0 --port ${PORT} --model ${MODEL_FILE:-/data/model.gguf} ${HF_SPACE_API_KEY:+--api-key ${HF_SPACE_API_KEY}} --ctx-size ${CTX_SIZE:-4096}"]
