import sys

path = 'D:/Mazz Code/MAZZ_AGENT_STUDIO/packages/muce-bridge/src/muce-bridge.ts'
with open(path, 'r', encoding='utf-8') as f:
    text = f.read()

old_block = """    const caps = (raw.capabilities || {}) as Record<string, unknown>;
    const unsupported = Array.isArray(caps.unsupported) ? (caps.unsupported as string[]) : [];
    const generative: MuceBridgeStatus['generativeAcceleration'] = unsupported.includes('muce_llm_kernel_replacement')
      ? 'unsupported'
      : Array.isArray(caps.compute) && (caps.compute as string[]).some((c) => /gguf|llm|token/i.test(c))
        ? 'declared'
        : 'unknown';"""

new_block = """    const caps = (raw.capabilities || {}) as Record<string, unknown>;
    const unsupported = Array.isArray(caps.unsupported) ? (caps.unsupported as string[]) : [];
    const hasSpeculativeOrGguf = Array.isArray(caps.gguf) && (caps.gguf as string[]).some((c) => /speculative|radix|sparse|native_generation/i.test(c));
    const generative: MuceBridgeStatus['generativeAcceleration'] = hasSpeculativeOrGguf
      ? 'declared'
      : unsupported.includes('muce_llm_kernel_replacement')
        ? 'unsupported'
        : Array.isArray(caps.compute) && (caps.compute as string[]).some((c) => /gguf|llm|token/i.test(c))
          ? 'declared'
          : 'unknown';"""

old_diag = """    const generativeAcceleration = extra.generativeAcceleration ?? 'unknown';
    if (generativeAcceleration === 'unsupported') {
      diagnostics.push('Le manifeste déclare "muce_llm_kernel_replacement" non pris en charge : la génération reste assurée par llama.cpp.');
    }"""

new_diag = """    const generativeAcceleration = extra.generativeAcceleration ?? 'unknown';
    if (generativeAcceleration === 'declared') {
      diagnostics.push('Accélération générative active : décodage spéculatif N-Gram, persistance des pools GGML et cache Radix déclarés.');
    } else if (generativeAcceleration === 'unsupported') {
      diagnostics.push('Le manifeste déclare "muce_llm_kernel_replacement" non pris en charge : la génération reste assurée par llama.cpp.');
    }"""

assert old_block in text, "old_block not found"
assert old_diag in text, "old_diag not found"

text = text.replace(old_block, new_block)
text = text.replace(old_diag, new_diag)
text = text.replace('Binaire CLI v?rifi? :', 'Binaire CLI vérifié :')
text = text.replace('Binaire CLI d?clar? mais absent', 'Binaire CLI déclaré mais absent')

with open(path, 'w', encoding='utf-8', newline='\r\n') as f:
    f.write(text)

print("muce-bridge.ts updated successfully!")
