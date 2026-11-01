// Measures the pairwise judge on a live llama-server: can the model put the correct explanation of a
// function first, among a correct, a vague and a wrong one? Each case is ranked `trials` times.
// Usage: node scripts/judge-bench.mjs [--url http://127.0.0.1:8091] [--model id] [--trials 5] [--repeats 3]
import { tournament } from '../packages/agent/dist/index.js';
import { OpenAiCompatibleProvider } from '../packages/providers/dist/index.js';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const baseUrl = opt('url', 'http://127.0.0.1:8091');
const modelId = opt('model', 'Qwen_Qwen3-0.6B-Q4_K_M.gguf');
const trials = Number(opt('trials', '5'));
const repeats = Number(opt('repeats', '3'));
const provider = new OpenAiCompatibleProvider({ id: 'llama-judge', type: 'llama_cpp', name: 'llama.cpp', baseUrl: `${baseUrl}/v1`, locality: 'local' });

// Candidate 0 is always the correct one; the bench shuffles them for each trial.
const CASES = [
  {
    name: 'crc32_update',
    context: 'uint32_t crc32_update(uint32_t seed, const void *data, size_t length) {\n  uint32_t crc = ~seed;\n  for (size_t i = 0; i < length; i++) {\n    crc ^= ((const unsigned char *)data)[i];\n    for (int k = 0; k < 8; k++) crc = (crc >> 1) ^ (0xEDB88320u & -(crc & 1u));\n  }\n  return ~crc;\n}',
    criterion: 'the explanation is factually correct about what the function computes and returns',
    candidates: [
      'Computes the reflected CRC-32 (polynomial 0xEDB88320) of length bytes, continuing from seed, and returns the final inverted CRC.',
      'Processes some data in a loop and returns a number.',
      'Sorts the bytes of data in place and returns the number of bytes that were moved.',
    ],
  },
  {
    name: 'vm_dot',
    context: 'double vm_dot(const double *a, const double *b, size_t n) {\n  double s = 0.0;\n  for (size_t i = 0; i < n; i++) s += a[i] * b[i];\n  return s;\n}',
    criterion: 'the explanation is factually correct about what the function computes and returns',
    candidates: [
      'Returns the dot product of the two vectors: the sum of a[i] * b[i] for i < n.',
      'Does a computation on two arrays.',
      'Returns the largest element found in a or b.',
    ],
  },
  {
    name: 'clamp',
    context: 'def clamp(x, lo, hi):\n    return max(lo, min(x, hi))',
    criterion: 'the explanation is factually correct about what the function returns',
    candidates: [
      'Returns x limited to the range [lo, hi]: lo if x is below lo, hi if x is above hi, else x.',
      'Returns some value related to x.',
      'Returns the average of x, lo and hi.',
    ],
  },
];

const shuffle = (n, seed) => {
  const order = [...Array(n).keys()];
  let s = seed;
  for (let i = n - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
};

let firstCorrect = 0;
let total = 0;
const started = Date.now();
for (const c of CASES) {
  let hits = 0;
  for (let t = 0; t < trials; t++) {
    const order = shuffle(c.candidates.length, 7 + t * 31 + c.name.length);
    const shown = order.map((i) => c.candidates[i]);
    const r = await tournament({ provider, modelId, taskId: `judge_${c.name}_${t}`, criterion: c.criterion, context: c.context, repeats }, shown);
    const best = order[r.ranking[0]];
    if (best === 0) hits++;
  }
  firstCorrect += hits;
  total += trials;
  console.log(`${c.name}: explication juste classée 1re ${hits}/${trials}`);
}
console.log(`TOTAL ${firstCorrect}/${total} (hasard : 1/3), ${Math.round((Date.now() - started) / 1000)} s, ${repeats} jugement(s) par paire`);
