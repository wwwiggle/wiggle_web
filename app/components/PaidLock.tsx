// 유료 요금제로 잠긴 단추·카드. 누를 수 없고, 마우스를 올리면 금지 표시(not-allowed)가 뜬다.
import type { ReactNode } from "react";
import { DRAWING_LOCKED_MESSAGE, PAID_PLAN_LABEL } from "@/lib/feature-locks";

export function PaidLock({ children, className = "", message = DRAWING_LOCKED_MESSAGE, badge = true }: { children: ReactNode; className?: string; message?: string; badge?: boolean }) {
  return <span className={`paid-lock ${className}`.trim()} aria-disabled="true" title={message} data-paid-lock="">
    {children}
    {badge && <small className="paid-lock-badge"><span aria-hidden="true">🔒</span> {PAID_PLAN_LABEL}</small>}
  </span>;
}
