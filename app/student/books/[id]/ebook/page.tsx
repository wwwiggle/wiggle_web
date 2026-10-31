import { EbookRedirect } from "@/app/components/EbookRedirect";

export default async function StudentEbookPage({ params }: { params: Promise<{ id: string }> }) {
  return <EbookRedirect bookId={(await params).id} />;
}
