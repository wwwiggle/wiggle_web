import { Archive } from "@/app/components/Archive";
import { DrawingLocked } from "@/app/components/DrawingLocked";
import { DRAWING_LOCKED } from "@/lib/feature-locks";
// 내 그림 보관함도 그림 기능이라 유료 요금제로 잠근다(lib/feature-locks.ts). 잠금을 풀면 그대로 열린다.
export default function ArchivePage() { if (DRAWING_LOCKED) return <DrawingLocked />; return <Archive />; }
