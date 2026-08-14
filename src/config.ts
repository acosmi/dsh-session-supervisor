/**
 * Deployment configuration: the same contract exists as a TypeScript
 * interface and as a Schemastery Standard Schema, so illegal values fail at
 * load time. No deployment-tunable value lives in source constants.
 */

import Schema from '@deepseek-ai/schemastery'

export interface Config {
  /** Global kill switch: no timers, no follow-ups; the read-only fold stays available. */
  enabled: boolean
  /** Admin floor for lifecycle_silence thresholds, seconds. */
  minSilenceSeconds: number
  maxGuardsPerSession: number
  maxPoliciesPerGuard: number
  maxLabelBytes: number
  /** Suspect-to-open confirmation window, seconds. */
  confirmationSeconds: number
  /** Recovering-to-resolved confirmation window, seconds. */
  recoveryConfirmationSeconds: number
  /** Explicit bounded retry table for delivery failures, milliseconds. */
  deliveryRetryDelaysMs: number[]
  maxDeliveryAttempts: number
  maxEvidenceItems: number
  maxEvidenceBytes: number
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}

export const DEFAULT_CONFIG: Config = {
  enabled: true,
  minSilenceSeconds: 60,
  maxGuardsPerSession: 16,
  maxPoliciesPerGuard: 8,
  maxLabelBytes: 240,
  confirmationSeconds: 60,
  recoveryConfirmationSeconds: 30,
  deliveryRetryDelaysMs: [1_000, 5_000, 15_000],
  maxDeliveryAttempts: 3,
  maxEvidenceItems: 20,
  maxEvidenceBytes: 4096,
  logLevel: 'warn',
}

export const Config = Schema.object({
  enabled: Schema.boolean().default(DEFAULT_CONFIG.enabled),
  minSilenceSeconds: Schema.number().min(1).default(DEFAULT_CONFIG.minSilenceSeconds),
  maxGuardsPerSession: Schema.number().min(1).default(DEFAULT_CONFIG.maxGuardsPerSession),
  maxPoliciesPerGuard: Schema.number().min(1).default(DEFAULT_CONFIG.maxPoliciesPerGuard),
  maxLabelBytes: Schema.number().min(1).max(4096).default(DEFAULT_CONFIG.maxLabelBytes),
  confirmationSeconds: Schema.number().min(1).default(DEFAULT_CONFIG.confirmationSeconds),
  recoveryConfirmationSeconds: Schema.number().min(1).default(DEFAULT_CONFIG.recoveryConfirmationSeconds),
  deliveryRetryDelaysMs: Schema.array(Schema.number().min(0)).default([...DEFAULT_CONFIG.deliveryRetryDelaysMs]),
  maxDeliveryAttempts: Schema.number().min(1).default(DEFAULT_CONFIG.maxDeliveryAttempts),
  maxEvidenceItems: Schema.number().min(1).default(DEFAULT_CONFIG.maxEvidenceItems),
  maxEvidenceBytes: Schema.number().min(1).max(1_048_576).default(DEFAULT_CONFIG.maxEvidenceBytes),
  logLevel: Schema.union(['debug', 'info', 'warn', 'error'] as const).default(DEFAULT_CONFIG.logLevel),
})

/** Evaluation windows derived from the validated config. */
export function evaluationConfig(config: Config): { confirmationMs: number; recoveryConfirmationMs: number } {
  return {
    confirmationMs: config.confirmationSeconds * 1000,
    recoveryConfirmationMs: config.recoveryConfirmationSeconds * 1000,
  }
}
