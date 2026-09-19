import { getWorkflowRepository } from "../workflow-runtime";

/**
 * Agent API token: persisted value in app_settings (desktop auto-generates).
 * If no token is configured, returns null → guard returns 404 (endpoints invisible).
 */
export async function getAgentApiToken(): Promise<string | null> {
  const stored = await getWorkflowRepository().getSetting("agent_api_token");
  return stored?.trim() || null;
}

/**
 * Constant-time bearer token comparison. Returns true if valid, false otherwise.
 * If no token is configured, returns false (all requests fail → 404 semantics).
 */
export async function verifyAgentApiToken(authHeader: string | null): Promise<boolean> {
  const configured = await getAgentApiToken();
  if (!configured) {
    return false;
  }
  if (!authHeader) {
    return false;
  }
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return false;
  }
  const provided = match[1];
  if (provided === undefined || configured.length !== provided.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < configured.length; i++) {
    diff |= configured.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}
