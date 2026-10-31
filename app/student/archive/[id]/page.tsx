import { ArtworkDetail } from "../../../components/ArtworkDetail";
import { DrawingLocked } from "../../../components/DrawingLocked";
import { DRAWING_LOCKED } from "@/lib/feature-locks";

// 완성 그림 보기도 「내 그림」의 일부라 유료 요금제로 잠근다.
export default function ArtworkDetailPage() { if (DRAWING_LOCKED) return <DrawingLocked />; return <ArtworkDetail />; }
