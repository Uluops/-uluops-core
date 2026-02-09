/**
 * SDK Configuration
 */
export interface UluOpsConfig {
  /** API key for authentication (used for both services). Falls back to ULUOPS_API_KEY or ULU_API_KEY env var. */
  apiKey?: string;

  /**
   * Base URL for uluops-registry-api
   * @default "https://registry.uluops.ai/api"
   */
  registryUrl?: string;

  /**
   * Base URL for uluops-validation-api
   * @default "https://ops.uluops.ai/api"
   */
  validationUrl?: string;

  /**
   * Base URL for dashboard links
   * @default "https://app.uluops.ai"
   */
  dashboardUrl?: string;

  /**
   * Local definitions directory for development
   * When set, SDK looks here first before remote registry
   * Supports: *.agent.yaml, *.command.yaml, *.workflow.yaml, *.pipeline.yaml
   */
  localDefinitions?: string;

  /**
   * Enable result submission to validation service
   * @default true
   */
  trackingEnabled?: boolean;

  /**
   * Enable hash verification for definitions
   * @default true
   */
  hashVerificationEnabled?: boolean;

  /** Request timeout in ms (default: 300000) */
  timeout?: number;

  /** Model override for all executions */
  modelOverride?: 'haiku' | 'sonnet' | 'opus';

  /** Default project name for validation service */
  defaultProject?: string;
}

/**
 * Validated configuration with defaults applied
 */
export interface ResolvedConfig {
  apiKey: string;
  registryUrl: string;
  validationUrl: string;
  dashboardUrl: string;
  localDefinitions?: string;
  trackingEnabled: boolean;
  hashVerificationEnabled: boolean;
  timeout: number;
  modelOverride?: 'haiku' | 'sonnet' | 'opus';
  defaultProject?: string;
}
