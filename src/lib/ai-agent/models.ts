export const DEFAULT_MODEL = "claude-sonnet-5-5";

const MODEL_ID = /^claude-[a-z0-9.-]+$/;

export const defaultModel = () => process.env.AI_MODEL || DEFAULT_MODEL;

/** Models a workspace may pick: AI_ALLOWED_MODELS (comma separated) or, when unset, only the default model. */
export function allowedModels(): string[] {
  const listed = (process.env.AI_ALLOWED_MODELS ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter((m) => MODEL_ID.test(m));
  return listed.length > 0 ? [...new Set(listed)] : [defaultModel()];
}

export const isAllowedModel = (model: string) => allowedModels().includes(model);

/** The model for a call: the agent's choice only while it is still on the allow-list, otherwise the platform default. */
export function resolveModel(requested: string | null | undefined): string {
  return requested && isAllowedModel(requested) ? requested : defaultModel();
}
