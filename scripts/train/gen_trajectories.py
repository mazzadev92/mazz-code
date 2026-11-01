"""Procedural, execution-validated agent trajectories for fine-tuning small models on the Studio's tools.

Each case is a tiny Python project with a known injected bug (fix task), a missing function (feature task) or
a question about the code (understand task). For every case the ideal trajectory is written in the Studio's
OpenAI tool-call format (fs__read / fs__patch / fs__write / terminal__run ...), then REPLAYED in a temp dir:
the patch must apply, the project tests must fail before and pass after. Only validated trajectories are kept.
This teaches tool use (read, edit exactly, test, stop), not reasoning about unseen bugs.

Usage: python scripts/train/gen_trajectories.py <out.jsonl> [--n 1500] [--seed 7]
"""
from __future__ import annotations

import argparse
import json
import random
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
TOOLS = json.loads((HERE / 'tools.json').read_text(encoding='utf-8'))
SYSTEM = (
    "Tu es l'agent de code du Studio. Tu travailles dans le workspace avec les outils fournis. "
    "Lis ce qui est utile, modifie avec fs__patch (blocs search/replace exacts) ou fs__write, "
    "vérifie avec terminal__run, puis réponds brièvement. N'invente aucun résultat."
)

# Each function: name, correct body, (bug body, bug description) list, test cases (args, expected).
FUNCS = [
    dict(name='count_words', sig='text', body="    return len(text.split())",
         bugs=["    return len(text.split(' '))", "    return len(text.split()) - 1"],
         tests=[("'a b  c'", '3'), ("''", '0'), ("'un\\tdeux\\ntrois'", '3')]),
    dict(name='mean', sig='values', body="    if not values:\n        raise ValueError('empty')\n    return sum(values) / len(values)",
         bugs=["    if not values:\n        raise ValueError('empty')\n    return sum(values) / (len(values) - 1)",
               "    if not values:\n        raise ValueError('empty')\n    return sum(values) // len(values)"],
         tests=[('[1, 2, 3, 4]', '2.5'), ('[5]', '5.0')]),
    dict(name='clamp', sig='x, lo, hi', body="    return max(lo, min(x, hi))",
         bugs=["    return min(lo, max(x, hi))", "    return max(lo, min(x, lo))"],
         tests=[('5, 0, 10', '5'), ('-3, 0, 10', '0'), ('42, 0, 10', '10')]),
    dict(name='is_palindrome', sig='s', body="    t = ''.join(c.lower() for c in s if c.isalnum())\n    return t == t[::-1]",
         bugs=["    t = ''.join(c for c in s if c.isalnum())\n    return t == t[::-1]", "    t = s.lower()\n    return t == t[::-1]"],
         tests=[("'Kayak'", 'True'), ("'Esope reste ici et se repose'", 'True'), ("'abc'", 'False')]),
    dict(name='last_index', sig='items, value', body="    for i in range(len(items) - 1, -1, -1):\n        if items[i] == value:\n            return i\n    return -1",
         bugs=["    for i in range(len(items) - 1, 0, -1):\n        if items[i] == value:\n            return i\n    return -1",
               "    for i in range(len(items)):\n        if items[i] == value:\n            return i\n    return -1"],
         tests=[('[1, 2, 1], 1', '2'), ('[7, 3], 7', '0'), ('[1], 9', '-1')]),
    dict(name='factorial', sig='n', body="    result = 1\n    for k in range(2, n + 1):\n        result *= k\n    return result",
         bugs=["    result = 1\n    for k in range(2, n):\n        result *= k\n    return result", "    result = 0\n    for k in range(2, n + 1):\n        result *= k\n    return result"],
         tests=[('0', '1'), ('5', '120'), ('1', '1')]),
    dict(name='chunk', sig='items, size', body="    return [items[i:i + size] for i in range(0, len(items), size)]",
         bugs=["    return [items[i:i + size] for i in range(0, len(items) - 1, size)]", "    return [items[i:i + size - 1] for i in range(0, len(items), size)]"],
         tests=[('[1, 2, 3, 4, 5], 2', '[[1, 2], [3, 4], [5]]'), ('[], 3', '[]'), ('[1, 2], 2', '[[1, 2]]')]),
    dict(name='celsius_to_fahrenheit', sig='c', body="    return c * 9 / 5 + 32",
         bugs=["    return c * 5 / 9 + 32", "    return (c + 32) * 9 / 5"],
         tests=[('0', '32.0'), ('100', '212.0'), ('-40', '-40.0')]),
    dict(name='dedupe', sig='items', body="    seen = set()\n    out = []\n    for x in items:\n        if x not in seen:\n            seen.add(x)\n            out.append(x)\n    return out",
         bugs=["    return list(set(items))", "    seen = set()\n    out = []\n    for x in items:\n        if x in seen:\n            seen.add(x)\n            out.append(x)\n    return out"],
         tests=[('[3, 1, 3, 2, 1]', '[3, 1, 2]'), ('[]', '[]')]),
    dict(name='safe_div', sig='a, b', body="    if b == 0:\n        return None\n    return a / b",
         bugs=["    if a == 0:\n        return None\n    return a / b", "    return a / b"],
         tests=[('6, 3', '2.0'), ('1, 0', 'None'), ('0, 5', '0.0')]),
]
MODULES = ['utils', 'helpers', 'core', 'tools', 'mathx', 'textlib', 'common', 'ops']
DIRS = ['', 'src/', 'lib/', 'app/']


def module_source(funcs, bugged=None):
    parts = ['"""Petites fonctions utilitaires."""\n']
    for f in funcs:
        body = bugged[1] if bugged and bugged[0] == f['name'] else f['body']
        parts.append(f"\ndef {f['name']}({f['sig']}):\n{body}\n")
    return ''.join(parts)


def test_source(mod_import, funcs):
    lines = ['import os', 'import sys', 'import unittest', '',
             "sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))",
             f'from {mod_import} import {", ".join(f["name"] for f in funcs)}  # noqa: E402', '', '',
             'class FunctionsTest(unittest.TestCase):']
    for f in funcs:
        lines.append(f"    def test_{f['name']}(self):")
        for args, exp in f['tests']:
            lines.append(f"        self.assertEqual({f['name']}({args}), {exp})")
        lines.append('')
    lines += ['', "if __name__ == '__main__':", '    unittest.main()', '']
    return '\n'.join(lines)


def numbered(text):
    return '\n'.join(f'{i + 1:4d} | {l}' for i, l in enumerate(text.split('\n')))


def run_tests(root: Path, test_rel: str):
    r = subprocess.run([sys.executable, test_rel], cwd=root, capture_output=True, text=True, timeout=60)
    return r.returncode, (r.stdout + r.stderr).strip()


def call(cid, name, args):
    return {'id': cid, 'type': 'function', 'function': {'name': name, 'arguments': json.dumps(args, ensure_ascii=False)}}


def tool_msg(cid, name, content):
    return {'role': 'tool', 'tool_call_id': cid, 'name': name, 'content': content}


def make_fix_case(rng):
    funcs = rng.sample(FUNCS, rng.randint(2, 4))
    target = rng.choice(funcs)
    bug = rng.choice(target['bugs'])
    d = rng.choice(DIRS)
    mod = rng.choice(MODULES)
    mod_rel = f'{d}{mod}.py'
    mod_import = (d.replace('/', '.') + mod) if d else mod
    test_rel = f'tests/test_{mod}.py'
    files = {mod_rel: module_source(funcs, (target['name'], bug)), test_rel: test_source(mod_import, funcs)}
    if d:
        files[f'{d}__init__.py'] = ''
    fixed = module_source(funcs)
    phrasing = rng.choice([
        f'Les tests de {test_rel} échouent. Trouve et corrige le bug dans {mod_rel}, sans modifier les tests, puis relance les tests.',
        f'Corrige {mod_rel} : la fonction {target["name"]} renvoie de mauvais résultats. Vérifie avec {test_rel}.',
        f'{test_rel} ne passe plus. Répare {mod_rel} et vérifie que tous les tests passent.',
    ])
    return dict(kind='fix', files=files, mod_rel=mod_rel, test_rel=test_rel, prompt=phrasing,
                search=bug, replace=target['body'], expected=fixed, fname=target['name'])


def make_feature_case(rng):
    funcs = rng.sample(FUNCS, rng.randint(2, 3))
    new = rng.choice([f for f in FUNCS if f not in funcs])
    mod = rng.choice(MODULES)
    mod_rel = f'{mod}.py'
    test_rel = f'tests/test_{mod}.py'
    files = {mod_rel: module_source(funcs), test_rel: test_source(mod, funcs)}
    doc = {'count_words': 'nombre de mots séparés par des blancs', 'mean': 'moyenne, ValueError si vide',
           'clamp': 'x borné entre lo et hi', 'is_palindrome': 'palindrome en ignorant casse et ponctuation',
           'last_index': 'dernier indice de value, -1 si absent', 'factorial': 'factorielle de n',
           'chunk': 'liste découpée en morceaux de taille size', 'celsius_to_fahrenheit': 'conversion Celsius vers Fahrenheit',
           'dedupe': 'éléments sans doublons, ordre conservé', 'safe_div': 'a / b, None si b vaut 0'}[new['name']]
    prompt = f'Ajoute la fonction {new["name"]}({new["sig"]}) à {mod_rel} : {doc}. Ajoute ses tests dans {test_rel} et vérifie qu’ils passent.'
    return dict(kind='feature', files=files, mod_rel=mod_rel, test_rel=test_rel, prompt=prompt, new=new, funcs=funcs, mod=mod)


def user_message(prompt, files, shown):
    block = '\n'.join(f'<fichier chemin="{rel}">\n{numbered(files[rel])}\n</fichier>' for rel in shown)
    tests = [rel for rel in shown if rel.startswith('tests/')]
    hint = f"\nPour lancer les tests, depuis la racine du projet (cwd vide), avec terminal.run : {' ; '.join('python ' + t for t in tests)}. N’installe aucun paquet." if tests else ''
    return f'{prompt}\n\n<fichiers_cites>\n{block}\n</fichiers_cites>\nCes fichiers sont déjà lus : ne les recherche pas, modifie-les directement si la tâche le demande.{hint}'


def trajectory_fix(case, root: Path):
    code_before, out_before = run_tests(root, case['test_rel'])
    if code_before == 0:
        return None
    src = (root / case['mod_rel']).read_text(encoding='utf-8')
    if src.count(case['search']) != 1:
        return None
    (root / case['mod_rel']).write_text(src.replace(case['search'], case['replace']), encoding='utf-8')
    code_after, out_after = run_tests(root, case['test_rel'])
    if code_after != 0:
        return None
    msgs = [{'role': 'system', 'content': SYSTEM},
            {'role': 'user', 'content': user_message(case['prompt'], case['files'], [case['mod_rel'], case['test_rel']])},
            {'role': 'assistant', 'content': f"Le bug est dans {case['fname']} ; je le corrige.",
             'tool_calls': [call('c1', 'fs__patch', {'path': case['mod_rel'], 'edits': [{'search': case['search'], 'replace': case['replace']}]})]},
            tool_msg('c1', 'fs__patch', json.dumps({'path': case['mod_rel'], 'applied': 1})),
            {'role': 'assistant', 'content': 'Je lance les tests.',
             'tool_calls': [call('c2', 'terminal__run', {'command': f"python {case['test_rel']}", 'cwd': ''})]},
            tool_msg('c2', 'terminal__run', json.dumps({'exitCode': 0, 'stdout': out_after[-600:]}, ensure_ascii=False)),
            {'role': 'assistant', 'content': f"Corrigé : {case['fname']} dans {case['mod_rel']}. Les tests de {case['test_rel']} passent."}]
    return msgs


def trajectory_feature(case, root: Path):
    new = case['new']
    new_src = f"\n\ndef {new['name']}({new['sig']}):\n{new['body']}\n"
    mod_path = root / case['mod_rel']
    mod_path.write_text(mod_path.read_text(encoding='utf-8').rstrip('\n') + '\n' + new_src, encoding='utf-8')
    test_path = root / case['test_rel']
    old_import = f'from {case["mod"]} import {", ".join(f["name"] for f in case["funcs"])}'
    new_import = f'from {case["mod"]} import {", ".join([f["name"] for f in case["funcs"]] + [new["name"]])}'
    test_block = f"    def test_{new['name']}(self):\n" + ''.join(f"        self.assertEqual({new['name']}({a}), {e})\n" for a, e in new['tests']) + '\n'
    anchor = "\nif __name__ == '__main__':"
    tsrc = test_path.read_text(encoding='utf-8')
    if tsrc.count(old_import) != 1 or tsrc.count(anchor) != 1:
        return None
    test_path.write_text(tsrc.replace(old_import, new_import).replace(anchor, '\n' + test_block.rstrip('\n') + '\n' + anchor), encoding='utf-8')
    code, out = run_tests(root, case['test_rel'])
    if code != 0:
        return None
    last_fn = case['funcs'][-1]
    msgs = [{'role': 'system', 'content': SYSTEM},
            {'role': 'user', 'content': user_message(case['prompt'], case['files'], [case['mod_rel'], case['test_rel']])},
            {'role': 'assistant', 'content': f"J’ajoute {new['name']} à la fin de {case['mod_rel']}.",
             'tool_calls': [call('c1', 'fs__patch', {'path': case['mod_rel'], 'edits': [{'search': last_fn['body'], 'replace': last_fn['body'] + new_src.rstrip('\n')}]})]},
            tool_msg('c1', 'fs__patch', json.dumps({'path': case['mod_rel'], 'applied': 1})),
            {'role': 'assistant', 'content': 'J’ajoute ses tests.',
             'tool_calls': [call('c2', 'fs__patch', {'path': case['test_rel'], 'edits': [
                 {'search': old_import, 'replace': new_import},
                 {'search': anchor.lstrip('\n'), 'replace': test_block + anchor.lstrip('\n')}]})]},
            tool_msg('c2', 'fs__patch', json.dumps({'path': case['test_rel'], 'applied': 2})),
            {'role': 'assistant', 'content': 'Je lance les tests.',
             'tool_calls': [call('c3', 'terminal__run', {'command': f"python {case['test_rel']}", 'cwd': ''})]},
            tool_msg('c3', 'terminal__run', json.dumps({'exitCode': 0, 'stdout': out[-600:]}, ensure_ascii=False)),
            {'role': 'assistant', 'content': f"Ajouté : {new['name']} dans {case['mod_rel']}, avec ses tests ; tous les tests passent."}]
    # The patch in the trajectory must reproduce what was validated: last function body unique in the module.
    if case['files'][case['mod_rel']].count(last_fn['body']) != 1:
        return None
    return msgs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('out')
    ap.add_argument('--n', type=int, default=1500)
    ap.add_argument('--seed', type=int, default=7)
    a = ap.parse_args()
    rng = random.Random(a.seed)
    kept = rejected = 0
    with open(a.out, 'w', encoding='utf-8') as out:
        while kept < a.n:
            case = make_fix_case(rng) if rng.random() < 0.65 else make_feature_case(rng)
            tmp = Path(tempfile.mkdtemp(prefix='traj-'))
            try:
                for rel, text in case['files'].items():
                    p = tmp / rel
                    p.parent.mkdir(parents=True, exist_ok=True)
                    p.write_text(text, encoding='utf-8')
                msgs = trajectory_fix(case, tmp) if case['kind'] == 'fix' else trajectory_feature(case, tmp)
            finally:
                shutil.rmtree(tmp, ignore_errors=True)
            if not msgs:
                rejected += 1
                continue
            out.write(json.dumps({'kind': case['kind'], 'messages': msgs, 'tools': TOOLS}, ensure_ascii=False) + '\n')
            kept += 1
    print(f'{kept} trajectoires validées par exécution, {rejected} rejetées -> {a.out}')


if __name__ == '__main__':
    main()
