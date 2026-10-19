import type { SoloAiDecision } from "../../shared/solo-ai-engine";
import type {
  SoloAiRemoteDecisionProvider,
  SoloAiRemoteDecisionRequest,
  SoloAiRemoteDecisionResponse,
} from "../../shared/solo-ai-remote";

interface SoloAiStatusResponse {
  readonly enabled?: boolean;
}

function endpoint(baseUrl: string, path: string): string {
  return new URL(path, `${baseUrl.replace(/\/+$/u, "")}/`).toString();
}

/**
 * Optional browser-to-server bridge for richer Solo bot language. It never
 * contains provider credentials and quietly returns to the local deterministic
 * bot when the server, route, provider, or network is unavailable.
 */
export function createSoloAiDecisionClient(
  baseUrl: string,
  fetcher: typeof fetch = fetch,
): SoloAiRemoteDecisionProvider {
  let statusPromise: Promise<boolean> | undefined;

  const providerEnabled = async (): Promise<boolean> => {
    if (statusPromise !== undefined) {
      return statusPromise;
    }

    statusPromise = fetcher(endpoint(baseUrl, "/api/ai/status"), {
      headers: { Accept: "application/json" },
    })
      .then(async (response) => {
        if (!response.ok) {
          return false;
        }
        const value = (await response.json()) as SoloAiStatusResponse;
        return value.enabled === true;
      })
      .catch(() => false);

    return statusPromise;
  };

  return async (
    request: SoloAiRemoteDecisionRequest,
  ): Promise<SoloAiDecision | undefined> => {
    if (!(await providerEnabled())) {
      return undefined;
    }

    try {
      const response = await fetcher(endpoint(baseUrl, "/api/ai/solo-decision"), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
      });
      if (!response.ok) {
        return undefined;
      }

      const result = (await response.json()) as Partial<SoloAiRemoteDecisionResponse>;
      return result.ok === true && result.decision !== null
        ? result.decision
        : undefined;
    } catch {
      return undefined;
    }
  };
}
