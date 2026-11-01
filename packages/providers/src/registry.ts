import type {
  ExecutionMode,
  ModelCapability,
  ModelSelection,
} from '@mazz/shared';
import type { IModelProvider } from './base.js';
// Test-only implementation is never imported during normal product startup.
const DeterministicTestProvider=(process.env.NODE_TEST_CONTEXT || process.env.MAZZ_TEST_PROVIDER)
  ? (await import('./deterministic.js')).DeterministicTestProvider : undefined;
import { OpenAiCompatibleProvider } from './openai.js';
import { AnthropicProvider } from './anthropic.js';
import { GeminiProvider } from './gemini.js';

export interface ProviderDescriptor {
  id: string;
  type: string;
  name: string;
  baseUrl: string;
  locality: 'local' | 'remote';
  requiresApiKey: boolean;
  hasApiKey: boolean;
  /** Added by the user (custom OpenAI-compatible endpoint) and removable. */
  custom: boolean;
  /** Test engine, not a generative model. */
  synthetic: boolean;
}

export interface CustomProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  locality?: 'local' | 'remote';
  defaultModel?: string;
}

export function isLocalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) return false;
    if (parsed.protocol === 'local:') return parsed.hostname === 'deterministic' && Boolean(process.env.NODE_TEST_CONTEXT || process.env.MAZZ_TEST_PROVIDER);
    return ['http:', 'https:'].includes(parsed.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  } catch { return false; }
}

export class ProviderRegistry {
  private providers = new Map<string, IModelProvider>();
  private customIds = new Set<string>();

  constructor() {
    this.registerDefaults();
  }

  register(provider: IModelProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Le fournisseur "${provider.id}" est déjà enregistré. Un nouvel enregistrement ne peut pas le remplacer implicitement.`);
    }
    this.providers.set(provider.id, provider);
  }

  get(id: string): IModelProvider | undefined {
    return this.providers.get(id);
  }

  list(): IModelProvider[] {
    return Array.from(this.providers.values());
  }

  /** Public description of every provider; never contains a key. */
  describe(): ProviderDescriptor[] {
    return this.list().map((p) => {
      const locality = p.locality || (isLocalUrl(p.baseUrl) ? 'local' : 'remote');
      return {
        id: p.id,
        type: p.type,
        name: p.name,
        baseUrl: p.baseUrl,
        locality,
        requiresApiKey: p.requiresApiKey ?? locality === 'remote',
        hasApiKey: p.hasApiKey ? p.hasApiKey() : false,
        custom: this.customIds.has(p.id),
        synthetic: p.baseUrl.startsWith('local://deterministic'),
      };
    });
  }

  addCustom(config: CustomProviderConfig): IModelProvider {
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(config.id)) {
      throw new Error('Identifiant invalide : lettres minuscules, chiffres et tirets (2 à 41 caractères).');
    }
    if (this.providers.has(config.id) && !this.customIds.has(config.id)) {
      throw new Error(`L'identifiant "${config.id}" est réservé à un fournisseur intégré.`);
    }
    let url: URL;
    try {
      url = new URL(config.baseUrl);
    } catch {
      throw new Error('URL de base invalide.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Seuls les protocoles http et https sont acceptés.');
    }
    const provider = new OpenAiCompatibleProvider({
      id: config.id,
      type: 'openai_compatible',
      name: config.name.slice(0, 80) || config.id,
      baseUrl: config.baseUrl,
      locality: config.locality || (isLocalUrl(config.baseUrl) ? 'local' : 'remote'),
      defaultModel: config.defaultModel,
    });
    // Re-submitting a custom provider with the same ID is an explicit user
    // configuration update. Generic register() remains append-only so that
    // registering a provider can never silently shadow an existing backend.
    if (this.customIds.has(config.id)) this.providers.set(provider.id, provider);
    else this.register(provider);
    this.customIds.add(config.id);
    return provider;
  }

  removeCustom(id: string): boolean {
    if (!this.customIds.has(id)) return false;
    this.customIds.delete(id);
    return this.providers.delete(id);
  }

  private registerDefaults(): void {
    // 0. MAZZ Cloud API Gateway (Passerelle Inférence Locale & GPU Distant Orchestrée)
    this.register(
      new OpenAiCompatibleProvider({
        id: 'mazz-cloud',
        type: 'openai_compatible',
        name: 'MAZZ Cloud API (Local & GPU Kaggle)',
        baseUrl: 'http://127.0.0.1:7070/v1',
        locality: 'local',
        defaultModel: 'Mazz-Technos-Base-4B-Abliterated.Q4_K_M',
      })
    );

    // 1. Deterministic test engine (offline)
    // Synthetic responses are available only inside Node's unit-test worker.
    // The application and CLI must always use a real runtime.
    if (DeterministicTestProvider) this.register(new DeterministicTestProvider());

    // 2. Local llama.cpp default server
    this.register(
      new OpenAiCompatibleProvider({
        id: 'llama-local',
        type: 'llama_cpp',
        name: 'llama.cpp Server',
        baseUrl: 'http://127.0.0.1:8080/v1',
        locality: 'local',
      })
    );

    // 3. Local LM Studio
    this.register(
      new OpenAiCompatibleProvider({
        id: 'lm-studio',
        type: 'lm_studio',
        name: 'LM Studio Local',
        baseUrl: 'http://127.0.0.1:1234/v1',
        locality: 'local',
      })
    );

    // 4. Local Ollama
    this.register(
      new OpenAiCompatibleProvider({
        id: 'ollama',
        type: 'ollama',
        name: 'Ollama Engine',
        baseUrl: 'http://127.0.0.1:11434/v1',
        locality: 'local',
      })
    );

    // 5. Cloud DeepSeek API
    this.register(
      new OpenAiCompatibleProvider({
        id: 'deepseek-api',
        type: 'deepseek',
        name: 'DeepSeek API',
        baseUrl: 'https://api.deepseek.com/v1',
        defaultModel: 'deepseek-chat',
        locality: 'remote',
      })
    );

    // 6. Cloud Groq API
    this.register(
      new OpenAiCompatibleProvider({
        id: 'groq-api',
        type: 'groq',
        name: 'Groq API',
        baseUrl: 'https://api.groq.com/openai/v1',
        defaultModel: 'llama-3.3-70b-versatile',
        locality: 'remote',
      })
    );

    // 7. Cloud OpenAI
    this.register(
      new OpenAiCompatibleProvider({
        id: 'openai-api',
        type: 'openai_compatible',
        name: 'OpenAI API',
        baseUrl: 'https://api.openai.com/v1',
        locality: 'remote',
      })
    );

    // 8. Cloud Anthropic Claude
    this.register(new AnthropicProvider({ id: 'anthropic-claude' }));

    // 9. Cloud Google Gemini
    this.register(new GeminiProvider({ id: 'google-gemini' }));

    // 10. OVHcloud AI Endpoints (Anonymous, 2 req/min/IP/model)
    this.register(
      new OpenAiCompatibleProvider({
        id: 'ovh-ai',
        type: 'openai_compatible',
        name: 'OVHcloud AI Endpoints (Anonyme)',
        baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
        locality: 'remote',
        requiresApiKey: false,
        defaultModel: 'Mistral-Nemo-Instruct-2407',
        modelFilter: (modelId: string) => !/^(bge-|whisper|nvr-tts|stable-diffusion|flux-)/i.test(modelId),
      })
    );

    // 11. llmfaucet Faucet (Anonymous, 20 req/day/IP)
    this.register(
      new OpenAiCompatibleProvider({
        id: 'llmfaucet',
        type: 'openai_compatible',
        name: 'llmfaucet Faucet (Anonyme)',
        baseUrl: 'https://api.llmfaucet.dev/v1',
        locality: 'remote',
        requiresApiKey: false,
        apiKey: 'free',
        defaultModel: 'auto:coding',
        knownModels: ['auto:coding', 'auto', 'auto:fast', 'auto:smart'],
      })
    );
  }

  async listAllModels(): Promise<ModelCapability[]> {
    const all: ModelCapability[] = [];
    for (const p of this.providers.values()) {
      try {
        const models = await p.listModels();
        all.push(...models);
      } catch {}
    }
    return all;
  }

  resolveProviderForSelection(selection: ModelSelection): IModelProvider {
    const provider = this.get(selection.providerId);
    if (!provider) {
      throw new Error(`Provider inconnu : "${selection.providerId}".`);
    }

    // Enforce Local Strict mode
    if (selection.executionMode === 'local_strict') {
      // Both the declared execution locality and the concrete URL must be
      // local. A loopback endpoint may itself be a cloud proxy, so an explicit
      // remote classification must never be overridden by its host name.
      const isLocal = provider.locality !== 'remote' && isLocalUrl(provider.baseUrl);

      if (!isLocal) {
        throw new Error(
          `Violation du mode "LOCAL STRICT" : le provider "${provider.name}" (${provider.baseUrl}) est distant. Aucun flux réseau externe n'est autorisé en local strict.`
        );
      }
    }

    return provider;
  }
}

export const defaultProviderRegistry = new ProviderRegistry();
