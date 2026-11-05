import ast

from compute.serverscript import build_server_script


def _requirements(source: str) -> list[str]:
    out = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.List) and [getattr(e, "value", None) for e in node.elts[2:4]] == ["pip", "install"]:
            items, skip = node.elts[4:], False
            for e in items:
                if isinstance(e, ast.Call) and ast.unparse(e).startswith("os.path.join(checkout("):
                    continue  # local directory of a git checkout pinned to a commit SHA
                text = e.value if isinstance(e, ast.Constant) else "git+" + ast.unparse(e) if isinstance(e, ast.JoinedStr) else ast.unparse(e)
                if skip:
                    skip = False
                elif text == "--extra-index-url":
                    skip = True
                elif not text.startswith("-"):
                    out.append(text)
    return out


def test_gpuScripts_everyPipRequirementIsPinnedExactly():
    script = build_server_script(backend_id="b", engine="llama", model="m.gguf", served_name="m", hf_repo="u/r")
    reqs = _requirements(script)
    assert len(reqs) >= 10  # the parser really found the install lists
    for req in reqs:
        assert "==" in req or ("git+" in req and "@" in req), f"unpinned pip requirement: {req}"


def test_gpuScripts_pinParser_flagsUnpinnedNames():
    assert _requirements("subprocess.run([sys.executable, '-m', 'pip', 'install', '-q', 'fastapi', 'x==1'])") == ["fastapi", "x==1"]


def test_trellisScript_compilesAndEmbedsTheMediaServerContract():
    script = build_server_script(backend_id="b", engine="trellis", model="microsoft/TRELLIS-image-large", served_name="trellis", hf_repo="u/r")
    compile(script, "server.py", "exec")
    assert "b64_glb" in script and "/v1/3d/generations" in script and "193e0502b5cb3eb5997ec457d5340e95d09b158e" in script
