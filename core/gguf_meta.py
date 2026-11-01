"""Minimal GGUF header reader: scalar metadata only (name, architecture, size label, context, quant type).

Arrays (tokenizer vocab, merges) are skipped by seeking, so reading a 9 GB model costs a few hundred
kilobytes of I/O. Spec: https://github.com/ggml-org/ggml/blob/master/docs/gguf.md
"""
import struct

_SCALARS = {0: "<B", 1: "<b", 2: "<H", 3: "<h", 4: "<I", 5: "<i", 6: "<f", 7: "<?", 10: "<Q", 11: "<q", 12: "<d"}
_STRING, _ARRAY = 8, 9

# llama.cpp general.file_type values -> quantization label
FILE_TYPES = {
    0: "F32", 1: "F16", 2: "Q4_0", 3: "Q4_1", 7: "Q8_0", 8: "Q5_0", 9: "Q5_1", 10: "Q2_K", 11: "Q3_K_S",
    12: "Q3_K_M", 13: "Q3_K_L", 14: "Q4_K_S", 15: "Q4_K_M", 16: "Q5_K_S", 17: "Q5_K_M", 18: "Q6_K",
    19: "IQ2_XXS", 20: "IQ2_XS", 21: "Q2_K_S", 22: "IQ3_XS", 23: "IQ3_XXS", 24: "IQ1_S", 25: "IQ4_NL",
    26: "IQ3_S", 27: "IQ3_M", 28: "IQ2_S", 29: "IQ2_M", 30: "IQ4_XS", 31: "IQ1_M", 32: "BF16",
}

WANTED = (
    "general.name", "general.basename", "general.architecture", "general.size_label", "general.file_type",
    "general.author", "general.organization", "general.finetune", "general.quantized_by",
)


def _read_str(f):
    (n,) = struct.unpack("<Q", f.read(8))
    return f.read(n).decode("utf-8", errors="replace")


def _skip_value(f, vtype):
    if vtype in _SCALARS:
        f.seek(struct.calcsize(_SCALARS[vtype]), 1)
    elif vtype == _STRING:
        (n,) = struct.unpack("<Q", f.read(8))
        f.seek(n, 1)
    elif vtype == _ARRAY:
        (itype,) = struct.unpack("<I", f.read(4))
        (count,) = struct.unpack("<Q", f.read(8))
        if itype in _SCALARS:
            f.seek(struct.calcsize(_SCALARS[itype]) * count, 1)
        else:
            for _ in range(count):
                _skip_value(f, itype)
    else:
        raise ValueError(f"type GGUF inconnu {vtype}")


def _read_value(f, vtype):
    if vtype in _SCALARS:
        fmt = _SCALARS[vtype]
        return struct.unpack(fmt, f.read(struct.calcsize(fmt)))[0]
    if vtype == _STRING:
        return _read_str(f)
    _skip_value(f, vtype)
    return None


def read_gguf_metadata(path):
    """Returns the wanted keys plus `<arch>.context_length` and `<arch>.block_count`, or raises ValueError."""
    out = {}
    with open(path, "rb") as f:
        if f.read(4) != b"GGUF":
            raise ValueError("pas un fichier GGUF (magie absente)")
        (version,) = struct.unpack("<I", f.read(4))
        if version < 2:
            raise ValueError(f"version GGUF {version} non prise en charge")
        _tensors, kv_count = struct.unpack("<QQ", f.read(16))
        arch = None
        for _ in range(kv_count):
            key = _read_str(f)
            (vtype,) = struct.unpack("<I", f.read(4))
            interesting = key in WANTED or (arch and key in (f"{arch}.context_length", f"{arch}.block_count"))
            if interesting:
                value = _read_value(f, vtype)
                out[key] = value
                if key == "general.architecture":
                    arch = value
            else:
                _skip_value(f, vtype)
    out["gguf_version"] = version
    if isinstance(out.get("general.file_type"), int):
        out["quant"] = FILE_TYPES.get(out["general.file_type"], str(out["general.file_type"]))
    return out
