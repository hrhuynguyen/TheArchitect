import { notFound } from "next/navigation";
import { DebugBench } from "../../features/debug/DebugBench";

export default function DebugPage() {
  if (
    process.env.ENABLE_DEBUG_ROUTES !== "true" ||
    process.env.NODE_ENV === "production"
  ) notFound();
  return <DebugBench />;
}
