"""Build a real, reviewable local Windows distribution without GGUF downloads."""
import argparse,datetime,hashlib,json,pathlib,shutil,zipfile
from concurrent.futures import ThreadPoolExecutor
ROOT=pathlib.Path(__file__).resolve().parent.parent
p=argparse.ArgumentParser();p.add_argument('--destination',type=pathlib.Path);p.add_argument('--finalize-existing',type=pathlib.Path);p.add_argument('--archive-suffix',default='');a=p.parse_args()
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
destination=(a.destination or ROOT/'dist').resolve();destination.mkdir(parents=True,exist_ok=True)
folder=a.finalize_existing.resolve() if a.finalize_existing else destination/('MAZZ-Agent-Studio-1.1.1-windows-local-'+stamp)
if a.finalize_existing:
    if not folder.is_dir() or not (folder/'SBOM.json').is_file() or not (folder/'apps/cli/dist/index.js').is_file():raise ValueError('Not a previously copied distribution')
elif folder.exists():raise FileExistsError(folder)
else:folder.mkdir()
def ignore(directory,names):
    return [n for n in names if n in {'__pycache__','.cache','.git'} or '.test.' in n or n.startswith('deterministic.')]
for name in (() if a.finalize_existing else ('package.json','package-lock.json','README.md','AGENT_INTEGRATION_MANIFEST.json','MAZZ_AGENT_INTEGRATION.md')):
    shutil.copy2(ROOT/name,folder/name)
for relative in (() if a.finalize_existing else ('apps/cli/dist','apps/web/dist','node_modules','integrations/sdk','THIRD_PARTY_NOTICES')):
    shutil.copytree(ROOT/relative,folder/relative,symlinks=False,ignore=ignore)
for package in ([] if a.finalize_existing else (ROOT/'packages').iterdir()):
    if not package.is_dir() or not (package/'package.json').is_file():continue
    dest=folder/'packages'/package.name;dest.mkdir(parents=True,exist_ok=True)
    shutil.copy2(package/'package.json',dest/'package.json')
    if (package/'dist').is_dir():shutil.copytree(package/'dist',dest/'dist',ignore=ignore)
(folder/'scripts').mkdir(exist_ok=True)
for name in ('start.ps1','doctor.ps1'):shutil.copy2(ROOT/'scripts'/name,folder/'scripts'/name)
(folder/'LANCER_MAZZ.bat').write_text('@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\start.ps1" %*\r\n',encoding='ascii')
(folder/'PACKAGE_README.md').write_text('''# MAZZ Windows local

Lancer LANCER_MAZZ.bat (ou scripts/start.ps1 -Port 3334 pour un port distinct).
Node.js doit être installé. Les dépendances JavaScript et l’interface compilée sont incluses. Aucun modèle, clé, données utilisateur, runtime simulé ou résultat préenregistré n’est fourni.
Le runtime GGUF, Python/Bib1 et les outils de compilation restent des dépendances externes détectées/configurées. Ce package ne prétend pas être un exécutable autonome sans prérequis. Le diagnostic liste les absences. Aucun compte cloud n’est nécessaire.
Les doubles des tests internes sont exclus. Les chemins utilisateur et les GGUF originaux ne sont ni déplacés ni modifiés.
''',encoding='utf-8')
lock=json.loads((ROOT/'package-lock.json').read_text(encoding='utf-8'))
sbom={'at':stamp,'scope':'npm package-lock inventory; license declarations are not a legal clearance',
      'packages':[{'path':path,'version':data.get('version'),'license':data.get('license','UNKNOWN'),'integrity':data.get('integrity')} for path,data in lock.get('packages',{}).items()]}
(folder/'SBOM.json').write_text(json.dumps(sbom,indent=2),encoding='utf-8')
def fingerprint(file):
    with file.open('rb') as handle:sha=hashlib.file_digest(handle,'sha256').hexdigest()
    return {'path':file.relative_to(folder).as_posix(),'bytes':file.stat().st_size,'sha256':sha}
files=sorted(f for f in folder.rglob('*') if f.is_file() and f.name!='PACKAGE_MANIFEST.json')
print(json.dumps({'phase':'hash','files':len(files)}),flush=True)
manifest=[]
with ThreadPoolExecutor(max_workers=2) as pool:
    for item in pool.map(fingerprint,files):
        manifest.append(item)
        if len(manifest)%1000==0:print(json.dumps({'phase':'hash','done':len(manifest),'total':len(files)}),flush=True)
(folder/'PACKAGE_MANIFEST.json').write_text(json.dumps({'at':stamp,'files':manifest},indent=2),encoding='utf-8')
if any(c not in '-_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' for c in a.archive_suffix):raise ValueError('Invalid archive suffix')
archive=pathlib.Path(str(folder)+a.archive_suffix+'.zip')
with zipfile.ZipFile(archive,'x',compression=zipfile.ZIP_DEFLATED,compresslevel=2) as z:
    for i,file in enumerate([*files,folder/'PACKAGE_MANIFEST.json'],1):
        z.write(file,file.relative_to(folder))
        if i%1000==0:print(json.dumps({'phase':'zip','done':i,'total':len(files)+1}),flush=True)
with zipfile.ZipFile(archive) as z:
    bad=z.testzip()
    if bad:raise ValueError('ZIP integrity failure: '+bad)
print(json.dumps({'at':stamp,'folder':str(folder),'zip':str(archive),'files':len(manifest),'zip_bytes':archive.stat().st_size,'sha256':hashlib.file_digest(archive.open('rb'),'sha256').hexdigest(),'zip_crc':'verified'},indent=2))
