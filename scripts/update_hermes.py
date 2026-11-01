import pathlib

p = pathlib.Path('D:/Mazz Code/MAZZ_AGENT_STUDIO/packages/hermes-bridge/src/hermes-bridge.ts')
content = p.read_text(encoding='utf-8')

target = """function findHermesCli(pythonPath?: string): { executable: string; version: string } | undefined {
  const candidates: string[] = [];
  if (pythonPath && isAbsolute(pythonPath)) {
    const scriptsDir = dirname(pythonPath);
    candidates.push(join(scriptsDir, process.platform === 'win32' ? 'hermes.exe' : 'hermes'));
  }
  candidates.push(...(process.platform === 'win32' ? ['hermes.exe'] : ['hermes']));"""

replacement = """function findHermesCli(pythonPath?: string): { executable: string; version: string } | undefined {
  const candidates: string[] = [];
  if (pythonPath && isAbsolute(pythonPath)) {
    const scriptsDir = dirname(pythonPath);
    candidates.push(join(scriptsDir, process.platform === 'win32' ? 'hermes.exe' : 'hermes'));
  }
  const userProfile = process.env.USERPROFILE || process.env.HOME || '';
  if (userProfile) {
    candidates.push(join(userProfile, '.cargo', 'bin', process.platform === 'win32' ? 'hermes.exe' : 'hermes'));
  }
  candidates.push(...(process.platform === 'win32' ? ['hermes.exe'] : ['hermes']));"""

# Normalize \r\n to \n for replacement
norm_content = content.replace('\r\n', '\n')
norm_target = target.replace('\r\n', '\n')
norm_replacement = replacement.replace('\r\n', '\n')

assert norm_target in norm_content, "target not found in normalized content"
updated = norm_content.replace(norm_target, norm_replacement).replace('\n', '\r\n')
p.write_bytes(updated.encode('utf-8'))
print("findHermesCli updated successfully!")
