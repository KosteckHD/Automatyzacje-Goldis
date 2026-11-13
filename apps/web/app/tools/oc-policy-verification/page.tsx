import Workspace from "../../workspace";
import "./automation.css";

export default async function OcPolicyVerificationPage({ searchParams }: {
  searchParams: Promise<{ view?: string | string[]; import?: string | string[] }>;
}) {
  const params = await searchParams;
  const workspaceEnabled = process.env.OC_AUTOMATION_WORKSPACE_ENABLED !== "0";
  const importId = Array.isArray(params.import) ? params.import[0] : params.import;
  return <Workspace mode={workspaceEnabled && params.view !== "legacy" ? "oc-automation" : "catalog"} initialImportId={importId ?? null} />;
}
