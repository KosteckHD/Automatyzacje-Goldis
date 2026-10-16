const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const envFlag = process.argv.indexOf("--env");
const envFile = envFlag >= 0 ? path.resolve(process.argv[envFlag + 1] || "") : path.join(root, ".env.production");
const errors = [];
const fail = (code) => errors.push(code);

function configuredCompose() {
  if (!fs.existsSync(envFile)) { fail("PRODUCTION_ENV_FILE_MISSING"); return null; }
  const result = spawnSync("docker", ["compose", "--env-file", envFile, "-f", "compose.yaml", "-f", "compose.production.yaml", "config", "--format", "json"], {
    cwd: root, encoding: "utf8", timeout: 30_000, windowsHide: true,
  });
  if (result.error || result.status !== 0 || !result.stdout) { fail("COMPOSE_CONFIG_FAILED"); return null; }
  try { return JSON.parse(result.stdout); }
  catch { fail("COMPOSE_CONFIG_INVALID_JSON"); return null; }
}

function main() {
  const config = configuredCompose();
  if (!config) return finish();
  const services = config.services || {};
  const expectedImages = ["postgres", "db-roles", "redis", "migrate", "bootstrap-admin", "api", "import-parser", "enrichment-worker", "worker", "web"];
  for (const name of expectedImages) {
    const service = services[name];
    if (!service) { fail(`SERVICE_MISSING_${name.toUpperCase().replace(/-/g, "_")}`); continue; }
    if (service.build) fail(`BUILD_ENABLED_${name.toUpperCase().replace(/-/g, "_")}`);
    if (!/^.+@sha256:[a-f0-9]{64}$/i.test(service.image || "")) fail(`IMAGE_DIGEST_REQUIRED_${name.toUpperCase().replace(/-/g, "_")}`);
  }

  for (const name of ["postgres", "redis", "api", "import-parser", "enrichment-worker", "worker"]) {
    if ((services[name]?.ports || []).length) fail(`HOST_PORT_FORBIDDEN_${name.toUpperCase().replace(/-/g, "_")}`);
  }
  const webPorts = services.web?.ports || [];
  if (webPorts.length !== 1 || webPorts[0].target !== 3000 || webPorts[0].host_ip !== "127.0.0.1") fail("WEB_LOOPBACK_PORT_INVALID");

  const networks = config.networks || {};
  if (networks.goldis_parser?.internal !== true) fail("PARSER_NETWORK_MUST_BE_INTERNAL");
  const hasNetwork = (service, name) => Object.hasOwn(service?.networks || {}, name);
  if (!hasNetwork(services.web, "goldis_frontend") || hasNetwork(services.web, "goldis_data") || hasNetwork(services.web, "goldis_parser")) fail("WEB_NETWORK_SCOPE_INVALID");
  if (!hasNetwork(services.api, "goldis_frontend") || !hasNetwork(services.api, "goldis_data") || !hasNetwork(services.api, "goldis_parser")) fail("API_NETWORK_SCOPE_INVALID");
  if (!hasNetwork(services["import-parser"], "goldis_parser") || Object.keys(services["import-parser"]?.networks || {}).length !== 1) fail("PARSER_NETWORK_SCOPE_INVALID");
  if (!hasNetwork(services.worker, "goldis_data") || Object.keys(services.worker?.networks || {}).length !== 1) fail("PORTAL_WORKER_NETWORK_SCOPE_INVALID");

  const apiEnv = services.api?.environment || {};
  if (apiEnv.APP_ENV !== "production" || apiEnv.NODE_ENV !== "production") fail("API_ENVIRONMENT_NOT_PRODUCTION");
  if (apiEnv.ARTIFACT_REQUIRE_ENCRYPTION !== "1") fail("ARTIFACT_ENCRYPTION_REQUIRED");
  if (!/^https:\/\//.test(apiEnv.PUBLIC_APP_ORIGIN || "")) fail("HTTPS_ORIGIN_REQUIRED");
  if (apiEnv.TRUST_PROXY_IPS !== "172.30.10.10") fail("TRUSTED_PROXY_CONFIGURATION_INVALID");
  if (!/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/.test(apiEnv.GOLDIS_BUILD_VERSION || "")) fail("BUILD_VERSION_INVALID");
  if (!/^[a-f0-9]{40}$/i.test(apiEnv.GOLDIS_BUILD_COMMIT || "")) fail("BUILD_COMMIT_INVALID");
  if (!/^sha256:[a-f0-9]{64}$/.test(apiEnv.GOLDIS_IMAGE_DIGEST || "")
    || apiEnv.GOLDIS_IMAGE_DIGEST !== (services.api?.image || "").split("@").at(-1)) fail("API_BUILD_DIGEST_MISMATCH");
  if (apiEnv.GOLDIS_ADMIN_USER || apiEnv.GOLDIS_ADMIN_PASSWORD) fail("ADMIN_SECRET_EXPOSED_TO_API");
  if (!apiEnv.DATABASE_URL_FILE || !apiEnv.REDIS_URL_FILE) fail("API_SECRET_FILE_CONFIG_INVALID");
  const workerEnv = services.worker?.environment || {};
  if (workerEnv.WORKER_CHROMIUM_SANDBOX !== "1" || workerEnv.WORKER_HEADLESS !== "1") fail("WORKER_SANDBOX_CONFIG_INVALID");
  if (workerEnv.GOLDIS_ENRICHMENT_PROVIDER && workerEnv.GOLDIS_ENRICHMENT_PROVIDER === "gus-bir") fail("UNSUPPORTED_PRODUCTION_REGISTRY_PROVIDER");

  const webNetwork = services.web?.networks?.goldis_frontend;
  if (webNetwork?.ipv4_address !== "172.30.10.10") fail("TRUSTED_WEB_PROXY_ADDRESS_MISMATCH");
  const nginxPath = path.join(root, "deploy", "nginx", "goldis.conf.example");
  const nginx = fs.readFileSync(nginxPath, "utf8");
  if (!nginx.includes("location ^~ /api/internal/") || !nginx.includes("return 404;")) fail("NGINX_INTERNAL_ROUTE_NOT_BLOCKED");
  if (!nginx.includes("proxy_set_header X-Forwarded-For $remote_addr;") || !nginx.includes('proxy_set_header Forwarded "";')) fail("NGINX_FORWARDING_POLICY_INVALID");
  if (!nginx.includes("client_max_body_size 20m;") || !nginx.includes("client_body_temp_path")) fail("NGINX_UPLOAD_LIMIT_INVALID");

  finish();
}

function finish() {
  if (errors.length) {
    console.error(`PRODUCTION_COMPOSE_FAIL checks=${[...new Set(errors)].join(",")}`);
    process.exitCode = 1;
  } else {
    console.log("PRODUCTION_COMPOSE_PASS images=digest ports=web-loopback networks=private secrets=files");
  }
}

main();
