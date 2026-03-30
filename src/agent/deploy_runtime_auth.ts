import { getIdToken, supportsIssuingIdTokens } from "@deno/oidc";
import { DenoClawError } from "../shared/errors.ts";
import { log } from "../shared/log.ts";

export interface ResolveBrokerAuthTokenInput {
  brokerUrl: string;
  oidcAudience: string;
  staticToken?: string | null;
  supportsOidc?: () => boolean;
  issueIdToken?: (audience: string) => Promise<string>;
}

export async function resolveBrokerAuthToken(
  input: ResolveBrokerAuthTokenInput,
): Promise<string> {
  const staticToken = input.staticToken === undefined
    ? Deno.env.get("DENOCLAW_BROKER_TOKEN") ??
      Deno.env.get("DENOCLAW_API_TOKEN")
    : input.staticToken ?? undefined;
  if (staticToken) {
    return staticToken;
  }

  const supportsOidc = input.supportsOidc ?? supportsIssuingIdTokens;
  if (supportsOidc()) {
    try {
      const issueIdToken = input.issueIdToken ?? getIdToken;
      return await issueIdToken(input.oidcAudience);
    } catch (error) {
      log.warn("OIDC token issuance failed", {
        brokerUrl: input.brokerUrl,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  throw new DenoClawError(
    "BROKER_AUTH_MISSING",
    { brokerUrl: input.brokerUrl },
    "Set DENOCLAW_BROKER_TOKEN or DENOCLAW_API_TOKEN, or enable OIDC",
  );
}

export function getRequiredBrokerUrl(
  brokerUrl = Deno.env.get("DENOCLAW_BROKER_URL"),
): string {
  if (!brokerUrl) {
    throw new DenoClawError(
      "BROKER_URL_MISSING",
      {},
      "Set DENOCLAW_BROKER_URL in the deployed agent environment",
    );
  }
  return brokerUrl;
}

export function isAuthorizedBrokerWakeUp(
  req: Request,
  configuredToken = Deno.env.get("DENOCLAW_API_TOKEN"),
): boolean {
  if (!configuredToken) {
    return true;
  }

  const auth = req.headers.get("authorization");
  return auth === `Bearer ${configuredToken}`;
}
