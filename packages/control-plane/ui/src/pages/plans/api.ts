// Plans page data: run artifacts through the CPE-04 route (loopback only; a missing artifact reads as null, never an error).
import type { RunDetailResponse } from "../../api";
import { fetchArtifact } from "../run/stream";
import { buildMatrix, diffFiles, parseJson, type Matrix, type Receipt } from "./logic";

export interface PlanData { matrix: Matrix; stages: RunDetailResponse["stages"] | null; verdict: string | null; have: { issue: boolean; plan: boolean; receipt: boolean } }

export async function loadPlan(source: string, run: string, stages: RunDetailResponse["stages"] | null): Promise<PlanData> {
  const [issueT, planT, receiptT, diffT] = await Promise.all(["issue.json", "plan.json", "receipt.json", "diff.patch"].map((n) => fetchArtifact(source, run, n)));
  const receipt = parseJson(receiptT ?? null) as Receipt | null;
  const issue = parseJson(issueT ?? null), plan = parseJson(planT ?? null);
  return {
    matrix: buildMatrix({ issue, plan, receipt, changedFiles: diffFiles(diffT ?? null) }),
    stages,
    verdict: receipt?.verdict ?? null,
    have: { issue: issue !== null, plan: plan !== null, receipt: receipt !== null },
  };
}
