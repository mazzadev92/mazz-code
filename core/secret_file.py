"""Secret files under %USERPROFILE%\\.mazz kept as Windows DPAPI blobs (spec 05 §4: never stored in clear).

A file still in clear text is read once, then rewritten encrypted for the current Windows account.
Outside Windows (no DPAPI) files stay as they are.
"""
import os

from .backends import DPAPI, _decrypt_key, _encrypt_key

PREFIX = "dpapi:"


def read_secret(path):
    """Returns the decrypted text of `path`, or None when the file does not exist."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = f.read().strip()
    except FileNotFoundError:
        return None
    if raw.startswith(PREFIX):
        return _decrypt_key(raw[len(PREFIX):])
    if DPAPI and raw:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(PREFIX + _encrypt_key(raw))
        os.replace(tmp, path)
    return raw


if __name__ == "__main__":
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "groq.key")
        with open(p, "w", encoding="utf-8") as f:
            f.write("gsk_test_value\n")
        assert read_secret(p) == "gsk_test_value"
        stored = open(p, encoding="utf-8").read()
        assert (stored.startswith(PREFIX) and "gsk_test_value" not in stored) if DPAPI else stored.strip() == "gsk_test_value"
        assert read_secret(p) == "gsk_test_value"
        assert read_secret(os.path.join(d, "absent")) is None
    print("secret_file OK")
