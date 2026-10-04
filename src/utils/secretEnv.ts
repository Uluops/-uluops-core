/**
 * Secret-class environment variables, and the environment a definition-driven child process
 * may inherit without them.
 *
 * Two paths run commands that a definition (or a model following one) chooses: PDL `steps:`
 * (StepsExecutor) and the agent shell tool (shellExecutor). Both are "the same trust boundary"
 * (config.ts, allowStageSteps), so both inherit the same scrubbed environment from here.
 * Until 2026-10-04 only steps scrubbed; the agent shell passed `process.env` through whole,
 * which went unnoticed because no registry-resolved agent was ever offered a shell (tracker
 * 38ce9462). Operator credentials are not inherited: a command that legitimately needs one is a
 * capability question, not an inheritance default (security review SEM-INC/M CWE-200).
 */

/** Names treated as secrets: credential suffixes, and the cloud / model-provider prefixes. */
export const SECRET_ENV_RE = /(_API_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIALS?)$|^(AWS_|GOOGLE_|AZURE_|ANTHROPIC_|OPENAI_)/;

/** `env` without its secret-class variables. */
export function scrubSecretEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (!SECRET_ENV_RE.test(k)) out[k] = v;
  }
  return out;
}
