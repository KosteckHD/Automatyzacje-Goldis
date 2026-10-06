import { notFound, redirect } from "next/navigation";

export default async function ImportDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound();
  redirect(`/tools/oc-policy-verification?import=${encodeURIComponent(id)}`);
}
