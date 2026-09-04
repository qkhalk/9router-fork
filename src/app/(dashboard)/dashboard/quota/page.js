import { Suspense } from "react";
import { CardSkeleton } from "@/shared/components/Loading";
import ProviderLimits from "../usage/components/ProviderLimits";
import BreakerPanel from "./BreakerPanel";

export default function QuotaPage() {
  return (
    <div className="space-y-6">
      <Suspense fallback={<CardSkeleton />}>
        <ProviderLimits />
      </Suspense>
      <Suspense fallback={<CardSkeleton />}>
        <BreakerPanel />
      </Suspense>
    </div>
  );
}
