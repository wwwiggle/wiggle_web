import { Suspense } from "react";
import { DrawingStudio } from "@/app/components/DrawingStudio";
import { DrawingLocked } from "@/app/components/DrawingLocked";
import { WaitMongri } from "@/app/components/WaitMongri";
import { DRAWING_LOCKED } from "@/lib/feature-locks";
// 그림 그리기는 유료 요금제 기능으로 잠겨 있다(lib/feature-locks.ts). 잠금을 풀면 아래 그림판이 그대로 열린다.
export default function DrawPage() { if (DRAWING_LOCKED) return <DrawingLocked />; return <Suspense fallback={<WaitMongri line="도화지를 펴고 있어요" />}><DrawingStudio /></Suspense>; }
