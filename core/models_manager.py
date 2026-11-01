import os
import glob

MODELS_DIR = r"D:\Models Locaux\Mazz models"

def list_local_models():
    models = []
    if not os.path.exists(MODELS_DIR):
        return models
    
    files = glob.glob(os.path.join(MODELS_DIR, "*.gguf"))
    for f in files:
        fname = os.path.basename(f)
        sz_bytes = os.path.getsize(f)
        sz_gb = round(sz_bytes / (1024**3), 2)
        sz_mb = round(sz_bytes / (1024**2), 1)
        
        # Determine archetype
        alias = fname.replace(".gguf", "")
        clean_alias = alias.lower()
        role = "general"
        est_tok_s = 6.0
        
        if "code" in clean_alias or "coder" in clean_alias:
            role = "code_reverse"
            est_tok_s = 9.8 if "iq4_xs" in clean_alias else 6.2
        elif "chat" in clean_alias or "2b" in clean_alias:
            role = "chat"
            est_tok_s = 14.8
        elif "base" in clean_alias or "4b" in clean_alias:
            role = "base_abliterated"
            est_tok_s = 6.2
        elif "draft" in clean_alias or "0.6b" in clean_alias or "0.8b" in clean_alias:
            role = "draft"
            est_tok_s = 35.0
            
        models.append({
            "id": alias,
            "filename": fname,
            "path": f,
            "size_gb": sz_gb,
            "size_mb": sz_mb,
            "role": role,
            "local_speed_tok_s": est_tok_s,
            "remote_speed_tok_s": round(est_tok_s * 6.5, 1) if role != "draft" else 80.0,
            "is_quantized_iq4": "iq4_xs" in clean_alias
        })
        
    return sorted(models, key=lambda m: m["size_gb"])

def get_model_by_alias(alias):
    models = list_local_models()
    for m in models:
        if m["id"].lower() == alias.lower() or m["filename"].lower() == alias.lower():
            return m
    return None
