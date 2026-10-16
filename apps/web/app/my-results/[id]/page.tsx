import LeadWorkspace from "../../leads/LeadWorkspace";

export default async function MyLeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LeadWorkspace mode="detail" leadId={id} />;
}
