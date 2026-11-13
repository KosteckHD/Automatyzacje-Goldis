import { Suspense } from "react";
import LeadWorkspace from "../leads/LeadWorkspace";

export default function BusinessResultsPage() {
  return <Suspense fallback={<main className="lead-loading" role="status">Otwieram pulę firm…</main>}><LeadWorkspace mode="pool" /></Suspense>;
}
