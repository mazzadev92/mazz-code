"""Secret files under %USERPROFILE%\\.mazz kept as Windows DPAPI blobs (spec 05 §4: never stored in clear).

A file still in clear text is read once, then rewritten encrypted for the current Windows account.
Outside Windows (no DPAPI) files stay as they are.
"""
import os
import secrets
import subprocess

from .backends import DPAPI, _decrypt_key, _encrypt_key

PREFIX = "dpapi:"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def restrict_acl(path):
    """Removes inherited ACEs and grants the current Windows account full control on `path`.

    Best effort: a non-Windows host or a locked-down icacls returns without raising, because the
    secret still lives under the user profile and the caller must not fail on a hardening step.
    """
    if os.name != "nt":
        return
    user = os.environ.get("USERNAME")
    if not user:
        return
    try:
        subprocess.run(
            ["icacls", path, "/inheritance:r", "/grant:r", f"{user}:F"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10, creationflags=NO_WINDOW, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        pass


def ensure_secret_file(path):
    """Returns the text secret in `path`, creating a 32-byte token and a user-only ACL when absent."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            key = f.read().strip()
        if key:
            restrict_acl(path)
            return key
    except FileNotFoundError:
        pass
    os.makedirs(os.path.dirname(path), exist_ok=True)
    key = secrets.token_urlsafe(32)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(key)
    try:
        os.chmod(tmp, 0o600)
    except OSError:
        pass
    os.replace(tmp, path)
    restrict_acl(path)
    return key


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
