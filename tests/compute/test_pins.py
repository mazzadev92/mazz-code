import ast

from compute.serverscript import build_server_script


def _requirements(source: str) -> list[str]:
    out = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.List) and [getattr(e, "value", None) for e in node.elts[2:4]] == ["pip", "install"]:
            items, skip = node.elts[4:], False
            for e in items:
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
