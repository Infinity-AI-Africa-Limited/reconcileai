/**
 * The half of the hook-order class that ESLint cannot see, plus a sweep.
 *
 * Two production defects in one week came from a hook sitting below a
 * conditional return. `react-hooks/rules-of-hooks` catches one shape and is
 * blind to the other, because it only treats a member expression as a hook when
 * the object is a PascalCase identifier — so `trpc.x.y.useQuery()` is invisible
 * to it, and that is how most hooks are written here.
 *
 * The fixtures below pin the detector's behaviour directly. The sweep at the end
 * is what actually fails the build.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { hooksCalledAfterConditionalReturn } from "./hookOrder";

describe("when a hook sits below a conditional return", () => {
  it("should catch a tRPC query, the shape ESLint misses", () => {
    // This is the AuditorDashboard defect, reduced. Fed the real pre-fix file,
    // react-hooks/rules-of-hooks reported nothing at all.
    const source = [
      "export default function AuditorDashboard() {",
      "  const segment = useOrgSegment();",
      '  if (isRetailCommerce(segment)) return <Redirect to="/dashboard" />;',
      "  const { data } = trpc.dashboard.auditorCompliance.useQuery();",
      "  return <div>{data}</div>;",
      "}",
    ].join("\n");
    const found = hooksCalledAfterConditionalReturn(source);
    expect(found).toHaveLength(1);
    expect(found[0].returnLine).toBe(3);
    expect(found[0].hookLine).toBe(4);
  });

  it("should catch a plain useState below a block-form guard", () => {
    // The ComplianceAssessmentResult defect, reduced.
    const source = [
      "export default function Result() {",
      "  const { data, isLoading } = trpc.assessment.getByToken.useQuery({ token });",
      "  if (isLoading) {",
      "    return <Spinner />;",
      "  }",
      "  const [copied, setCopied] = useState(false);",
      "  return <div>{copied}</div>;",
      "}",
    ].join("\n");
    const found = hooksCalledAfterConditionalReturn(source);
    expect(found).toHaveLength(1);
    expect(found[0].hookLine).toBe(6);
  });
});

describe("when the code is fine", () => {
  it("should not flag hooks that all precede the guard", () => {
    const source = [
      "export default function Fine() {",
      "  const [a] = useState(0);",
      "  const { data } = trpc.dashboard.stats.useQuery();",
      "  if (!data) return null;",
      "  return <div>{a}</div>;",
      "}",
    ].join("\n");
    expect(hooksCalledAfterConditionalReturn(source)).toEqual([]);
  });

  it("should not flag a hook inside a nested callback", () => {
    // Indented deeper than component top level, so it is not a top-level call.
    const source = [
      "export default function Nested() {",
      "  if (x) return null;",
      "  const rows = items.map((i) => {",
      "    const label = useLabel(i);",
      "    return label;",
      "  });",
      "  return <div>{rows}</div>;",
      "}",
    ].join("\n");
    expect(hooksCalledAfterConditionalReturn(source)).toEqual([]);
  });

  it("should not flag a comment that merely mentions a hook", () => {
    const source = [
      "export default function Commented() {",
      "  if (x) return null;",
      "  // was: const { data } = trpc.dashboard.stats.useQuery();",
      "  return <div />;",
      "}",
    ].join("\n");
    expect(hooksCalledAfterConditionalReturn(source)).toEqual([]);
  });

  it("should treat a later declaration as a fresh component", () => {
    // A guard in one component must not implicate hooks in the next.
    const source = [
      "function First() {",
      "  if (x) return null;",
      "  return <div />;",
      "}",
      "export default function Second() {",
      "  const [a] = useState(0);",
      "  return <div>{a}</div>;",
      "}",
    ].join("\n");
    expect(hooksCalledAfterConditionalReturn(source)).toEqual([]);
  });
});

describe("the client tree", () => {
  const CLIENT = join(__dirname, "..");

  function tsxFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        // Vendored shadcn/ui primitives are not ours to police.
        if (entry === "ui") continue;
        tsxFiles(p, out);
      } else if (entry.endsWith(".tsx")) out.push(p);
    }
    return out;
  }

  it("should have no hook called after a conditional return", () => {
    const offenders: string[] = [];
    for (const file of tsxFiles(CLIENT)) {
      for (const f of hooksCalledAfterConditionalReturn(readFileSync(file, "utf8"))) {
        offenders.push(
          `${file.slice(CLIENT.length + 1).split("\\").join("/")}: ` +
            `return on L${f.returnLine}, then ${f.hook} on L${f.hookLine}`,
        );
      }
    }
    expect(
      offenders,
      "A hook below a conditional return changes the hook count between renders, " +
        "and React throws instead of rendering. Move every hook above the guards.\n" +
        offenders.join("\n"),
    ).toEqual([]);
  });
});
