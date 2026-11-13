import { Suspense } from "react";
import LeadWorkspace from "../../leads/LeadWorkspace";

export default async function MyLeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Suspense fallback={<main className="lead-loading" role="status">Otwieram firmę…</main>}><LeadWorkspace mode="detail" leadId={id} /></Suspense>;
}
