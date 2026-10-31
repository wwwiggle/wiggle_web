import { EbookViewer } from "@/app/components/EbookViewer";

export const dynamic = "force-dynamic";

export default async function EbookPage({ params }: { params: Promise<{ token: string }> }) {
  return <EbookViewer token={(await params).token} />;
}
