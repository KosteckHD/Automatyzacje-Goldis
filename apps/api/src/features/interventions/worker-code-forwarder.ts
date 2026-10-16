import { loadApiRuntimeConfig, loadApiSecretConfig } from "../../infrastructure/config";

const forwardTimeoutMs = 5_000;

export class WorkerCodeForwarder {
  private endpoint(): { url: URL; secret: string } {
    const configuredUrl = loadApiRuntimeConfig().workerInternalUrl;
    const serviceSecret = loadApiSecretConfig().workerAuthSecret;
    if (!configuredUrl || !serviceSecret || serviceSecret.length < 32)
      throw new Error("WORKER_CODE_FORWARDER_CONFIG_INVALID");
    const url = new URL(configuredUrl);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("WORKER_CODE_FORWARDER_CONFIG_INVALID");
    }
    url.pathname = "/internal/auth-challenges";
    return { url, secret: serviceSecret };
  }

  async deliver(challengeId: string, code: string): Promise<void> {
    const { url, secret } = this.endpoint();
    url.pathname += `/${challengeId}/code`;
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ code }),
      redirect: "error",
      signal: AbortSignal.timeout(forwardTimeoutMs),
    });
    if (response.status !== 202) throw new Error("WORKER_CODE_NOT_ACCEPTED");
  }

  async invalidate(challengeId: string): Promise<void> {
    try {
      const { url, secret } = this.endpoint();
      url.pathname += `/${challengeId}`;
      await fetch(url, {
        method: "DELETE",
        headers: { authorization: `Bearer ${secret}` },
        redirect: "error",
        signal: AbortSignal.timeout(2_000),
      });
    } catch {
      // Delivery already has an uncertain outcome. Never retry the code or expose transport details.
    }
  }
}
