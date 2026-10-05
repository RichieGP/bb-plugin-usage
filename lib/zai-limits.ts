import { z } from "zod";
import { clampPercent } from "./provider-limits";
import type { OpenCodeGoLimitWindow } from "./opencode-go";

// z.ai GLM Coding Plan credit windows, collected next to the OpenCode Go
// windows because both are used through OpenCode. The key is OpenCode\x27s own
// `zai-coding-plan` entry in auth.json. Strictly best effort: a missing key,
// missing tooling or any failure prints nothing and exits 0, so it can never
// affect the OpenCode Go collection.
export const ZAI_QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";

const zaiLimitSchema = z.object({
  type: z.string().optional(),
  unit: z.number().optional(),
  number: z.number().optional(),
  percentage: z.number().min(0).optional(),
  nextResetTime: z.number().optional(),
});

const zaiQuotaSchema = z.object({ data: z.object({ limits: z.array(zaiLimitSchema) }) });

export function zaiQuotaCommand() {
  return [
    `set +x`,
    `auth_path="\${XDG_DATA_HOME:-$HOME/.local/share}/opencode/auth.json"`,
    `bb_usage_zai_key=`,
    `if [ -r "$auth_path" ] && command -v curl >/dev/null 2>&1; then if command -v jq >/dev/null 2>&1; then bb_usage_zai_key=$(jq -er \x27."zai-coding-plan" | (.key // .api_key) | select(type == "string" and test("^[^[:space:]]+$"))\x27 "$auth_path" 2>/dev/null); elif command -v node >/dev/null 2>&1; then bb_usage_zai_key=$(node -e \x27try{const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const e=d["zai-coding-plan"];const k=e&&(e.key??e.api_key);if(typeof k==="string"&&/^\\S+$/.test(k))process.stdout.write(k)}catch{}\x27 "$auth_path" 2>/dev/null); fi; fi`,
    `if [ -n "$bb_usage_zai_key" ]; then bb_usage_zai_body=$(printf \x27Authorization: Bearer %s\\n\x27 "$bb_usage_zai_key" | curl -q -sS -f -m 20 --proto \x27=https\x27 -H @- \x27${ZAI_QUOTA_URL}\x27 2>/dev/null); if [ -n "$bb_usage_zai_body" ]; then printf \x27%s\\n\x27 \x27__BB_ZAI_BEGIN__\x27; printf \x27%s\\n\x27 "$bb_usage_zai_body"; printf \x27%s\\n\x27 \x27__BB_ZAI_END__\x27; fi; fi`,
    `exit 0`,
  ].join("; ");
}

function windowLabel(limit: z.infer<typeof zaiLimitSchema>) {
  if (limit.unit === 3 && limit.number === 5) return "z.ai 5-hour credits";
  if (limit.unit === 6) return "z.ai weekly credits";
  return "z.ai credits";
}

// Returns no windows for output without a z.ai block or with an unexpected
// shape; never throws.
export function parseZaiQuota(output: string): OpenCodeGoLimitWindow[] {
  const start = output.indexOf("__BB_ZAI_BEGIN__");
  const end = output.lastIndexOf("__BB_ZAI_END__");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = zaiQuotaSchema.safeParse(JSON.parse(output.slice(start + "__BB_ZAI_BEGIN__".length, end)));
    if (!parsed.success) return [];
    return parsed.data.data.limits.flatMap((limit): OpenCodeGoLimitWindow[] => {
      if (limit.type !== "CREDIT_LIMIT" || typeof limit.percentage !== "number") return [];
      return [{
        label: windowLabel(limit),
        usedPercent: clampPercent(limit.percentage),
        resetsAt: typeof limit.nextResetTime === "number" ? new Date(limit.nextResetTime).toISOString() : null,
      }];
    });
  } catch {
    return [];
  }
}
