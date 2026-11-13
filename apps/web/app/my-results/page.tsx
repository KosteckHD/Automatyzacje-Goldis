import { Suspense } from "react";
import LeadWorkspace from "../leads/LeadWorkspace";

export default function MyResultsPage() {
  return <Suspense fallback={<main className="lead-loading" role="status">Otwieram listę firm…</main>}><LeadWorkspace mode="mine" /></Suspense>;
}
