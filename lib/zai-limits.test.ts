import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ZAI_QUOTA_URL, parseZaiQuota, zaiQuotaCommand } from "./zai-limits";

const quotaBody = JSON.stringify({
  code: 200,
  data: {
    limits: [
      { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 5, nextResetTime: 1791190276506 },
      { type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 45, nextResetTime: 1791449905984 },
      { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 9 },
    ],
  },
});

const tempDirs: string[] = [];
afterEach(() => {
  for (const directory of tempDirs) rmSync(directory, { recursive: true, force: true });
  tempDirs.length = 0;
});

function runCommand(auth: Record<string, unknown> | null, curlExit = 0) {
  const root = mkdtempSync(join(tmpdir(), "bb-zai-"));
  tempDirs.push(root);
  const dataDir = join(root, "data");
  const binDir = join(root, "bin");
  mkdirSync(dirname(join(dataDir, "opencode", "auth.json")), { recursive: true });
  mkdirSync(binDir);
  if (auth !== null) writeFileSync(join(dataDir, "opencode", "auth.json"), JSON.stringify(auth));
  const curlPath = join(binDir, "curl");
  writeFileSync(curlPath, `#!/bin/sh
header=$(cat)
if [ "$header" != "Authorization: Bearer $EXPECTED_KEY" ]; then exit 9; fi
[ "$FAKE_CURL_EXIT" = "0" ] || exit "$FAKE_CURL_EXIT"
printf %s "$FAKE_BODY"
`);
  chmodSync(curlPath, 0o755);
  const result = spawnSync("/bin/sh", ["-c", zaiQuotaCommand()], {
    encoding: "utf8",
    env: {
      ...process.env,
      EXPECTED_KEY: "zai-test-secret-do-not-log",
      FAKE_BODY: quotaBody,
      FAKE_CURL_EXIT: String(curlExit),
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      XDG_DATA_HOME: dataDir,
    },
  });
  return { output: `${result.stdout}${result.stderr}`, status: result.status };
}

describe("z.ai quota command", () => {
  it("reads the OpenCode z.ai key without printing it and calls the quota endpoint", () => {
    const command = zaiQuotaCommand();
    expect(command).toContain(ZAI_QUOTA_URL);
    expect(command).toContain("-H @-");
    expect(command).not.toContain("Authorization: Bearer $bb_usage_zai_key");
    expect(command).toContain("set +x");
  });

  it("emits the quota block and never the credential", () => {
    const result = runCommand({ "zai-coding-plan": { type: "api", key: "zai-test-secret-do-not-log" } });
    expect(result.status).toBe(0);
    expect(result.output).toContain("__BB_ZAI_BEGIN__");
    expect(result.output).toContain(quotaBody);
    expect(result.output).not.toContain("zai-test-secret-do-not-log");
  });

  it("prints nothing and exits 0 without a z.ai key, without auth.json, or when curl fails", () => {
    for (const result of [
      runCommand({ "opencode-go": { type: "api", key: "go-key" } }),
      runCommand(null),
      runCommand({ "zai-coding-plan": { type: "api", key: "zai-test-secret-do-not-log" } }, 22),
    ]) {
      expect(result.status).toBe(0);
      expect(result.output).toBe("");
    }
  });
});

describe("parseZaiQuota", () => {
  it("maps credit limits to windows and ignores other limit types", () => {
    expect(parseZaiQuota(`noise\n__BB_ZAI_BEGIN__\n${quotaBody}\n__BB_ZAI_END__\n`)).toEqual([
      { label: "z.ai 5-hour credits", usedPercent: 5, resetsAt: new Date(1791190276506).toISOString() },
      { label: "z.ai weekly credits", usedPercent: 45, resetsAt: new Date(1791449905984).toISOString() },
    ]);
  });

  it("returns no windows for missing, malformed or unexpected output", () => {
    expect(parseZaiQuota("")).toEqual([]);
    expect(parseZaiQuota("__BB_ZAI_BEGIN__\nnot json\n__BB_ZAI_END__")).toEqual([]);
    expect(parseZaiQuota("__BB_ZAI_BEGIN__\n{\"data\":{}}\n__BB_ZAI_END__")).toEqual([]);
  });
});
