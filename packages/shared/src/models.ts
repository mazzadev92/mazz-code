/**
 * MAZZ ÆNGENIUM — Model & Provider Type Contracts
 */

export type ExecutionMode = 'local_strict' | 'cloud' | 'hybrid_opt_in' | 'manual';

export type ToolCallingSupport = 'verified' | 'unverified' | 'unsupported';

export type ModelLocality = 'local' | 'remote';

export type ProviderType =
  | 'llama_cpp'
  | 'lm_studio'
  | 'ollama'
  | 'openai_compatible'
  | 'gemini'
  | 'groq'
  | 'deepseek'
  | 'anthropic'
  | 'muce';

export interface ModelCapability {
  id: string;
  name: string;
  providerId: string;
  locality: ModelLocality;
  supportsStreaming: boolean;
  toolCalling: ToolCallingSupport;
  maxContextTokens?: number;
  quantization?: string;
  sizeBytes?: number;
  estimatedRamBytes?: number;
  measuredSpeedTps?: number;
  pricing?: {
    promptPerMillionUsd: number;
    completionPerMillionUsd: number;
  };
  verifiedAt?: string;
  isAvailable: boolean;
}

export interface ModelSelection {
  providerId: string;
  modelId: string;
  executionMode: ExecutionMode;
  allowedWorkspaceRoots: string[];
  temperature?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  maxOutputTokens?: number;
  maxCostUsd?: number;
  maxCalls?: number;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Image sent to a vision model with a user message (base64, no data: prefix). */
export interface ChatImage {
  mime: string;
  dataBase64: string;
  name?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** User messages only, for vision models. */
  images?: ChatImage[];
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCallRequest[];
}

export interface ModelProviderConfig {
  id: string;
  type: ProviderType;
  name: string;
  baseUrl: string;
  apiKey?: string;
  enabled: boolean;
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
}

export interface GgufMetadata {
  filePath: string;
  fileName: string;
  fileSizeBytes: number;
  architecture: string;
  quantization: string;
  /** Training context length declared by the header; undefined when absent. */
  contextLength?: number;
  tensorCount?: number;
  /** Estimate at min(contextLength, 8192) tokens: weights + KV cache + overhead. */
  estimatedRamMb: number;
  isValidGguf: boolean;
  error?: string;
  ggufVersion?: number;
  modelName?: string;
  sizeLabel?: string;
  /** Sum of tensor elements read from the tensor table (exact, not a label). */
  parameterCount?: number;
  blockCount?: number;
  embeddingLength?: number;
  headCount?: number;
  headCountKv?: number;
  keyLength?: number;
  valueLength?: number;
  vocabSize?: number;
  tokenizerModel?: string;
  hasChatTemplate?: boolean;
  /** Pooling/embedding-only architectures (bert, nomic-bert...) cannot chat. */
  likelyEmbeddingModel?: boolean;
  /** Metadata keys that hold only a tokenizer: vocab-only file, no weights. */
  vocabOnly?: boolean;
}
