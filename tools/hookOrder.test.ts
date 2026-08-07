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
 *
 * Several fixtures exist because the detector got this WRONG, twice, in ways
 * review caught: a callback's return read as the guard's, and a helper's return
 * leaking into the component declared after it. Both are ownership questions,
 * both now answered by the parser rather than inferred from indentation. They
 * are kept as tests because "unrepresentable" is a claim, and a claim about a
 * blocking gate should be checked.
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

  it("should catch a guard whose else branch is the one that returns", () => {
    // Still an early return on one path, so the hook below runs on some renders
    // and not others — the same defect, wearing a different shape.
    const source = [
      "export default function Branching() {",
      "  if (ready) {",
      "    warmUp();",
      "  } else {",
      "    return <Spinner />;",
      "  }",
      "  const { data } = trpc.dashboard.stats.useQuery();",
      "  return <div>{data}</div>;",
      "}",
    ].join("\n");
    const found = hooksCalledAfterConditionalReturn(source);
    expect(found).toHaveLength(1);
    expect(found[0].hookLine).toBe(7);
  });

  it("should catch a hook below an unbraced single-statement guard", () => {
    const source = [
      "export default function Unbraced() {",
      "  if (!id)",
      "    return null;",
      "  const { data } = trpc.dashboard.stats.useQuery();",
      "  return <div>{data}</div>;",
      "}",
    ].join("\n");
    expect(hooksCalledAfterConditionalReturn(source)).toHaveLength(1);
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

  it("should not treat a callback's return as the guard's", () => {
    // The guard only calls something. The `return` two lines later belongs to
    // the map callback, not to the `if` — so the tRPC hook below it is legal.
    // Asking whether "return" appeared within a few lines answered a different
    // question and failed CI on correct components.
    const source = [
      "export default function Valid() {",
      "  const [a] = useState(0);",
      "  if (!a) {",
      "    doSomething();",
      "  }",
      "  const rows = items.map((i) => {",
      "    return i.name;",
      "  });",
      "  const { data } = trpc.dashboard.stats.useQuery();",
      "  return <div>{rows}{data}</div>;",
      "}",
    ].join("\n");
    expect(hooksCalledAfterConditionalReturn(source)).toEqual([]);
  });

  it("should not flag a hook because its own body returns", () => {
    // The sharpest version of the same bug: the offender reported was
    // `useCallback` itself, for the `return` inside the callback it declares.
    const source = [
      "export default function AlsoValid() {",
      "  if (!a) {",
      "    track();",
      "  }",
      "  const cb = useCallback(() => {",
      "    return 1;",
      "  }, []);",
      "  return <div onClick={cb} />;",
      "}",
    ].join("\n");
    expect(hooksCalledAfterConditionalReturn(source)).toEqual([]);
  });

  it("should not let a helper's early return reach the component after it", () => {
    // Found by the sweep, in SettlementFileImport. `readFile` legitimately
    // returns early; the component below it was then condemned for its first
    // useState. The boundary was missed because `export function Foo()` — no
    // `default` — was not recognised as a declaration at all.
    const source = [
      "async function readFile(file: File) {",
      "  if (isSpreadsheet(file.name)) {",
      "    return { content: encode(file), encoding: 'base64' };",
      "  }",
      "  return { content: file.text(), encoding: 'utf8' };",
      "}",
      "",
      "export function SettlementFileImport({ onImported }: Props) {",
      "  const [file, setFile] = useState<File | null>(null);",
      "  return <div>{file?.name}</div>;",
      "}",
    ].join("\n");
    expect(hooksCalledAfterConditionalReturn(source)).toEqual([]);
  });

  it("should stop tracking at the end of a declaration", () => {
    // The same protection without relying on recognising what comes next.
    const source = [
      "function helper() {",
      "  if (x) return 1;",
      "}",
      "",
      "const Component = () => {",
      "  const [a] = useState(0);",
      "  return <div>{a}</div>;",
      "};",
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

describe("when the formatting is not what a line scanner assumed", () => {
  // Everything here was invisible to the previous implementation, which keyed
  // off exactly two spaces of indent and one line of lookahead. None of it is
  // exotic; it is just code that happens not to be laid out the expected way.
  // A gate people trust has to be about the code, not about its whitespace.
  const CASES: ReadonlyArray<readonly [string, string]> = [
    [
      "a component indented four spaces",
      [
        "export default function Wide() {",
        "    if (!a) return null;",
        "    const { data } = trpc.dashboard.stats.useQuery();",
        "    return <div>{data}</div>;",
        "}",
      ].join("\n"),
    ],
    [
      "a component declared inside another function",
      [
        "export function Outer() {",
        "  const Inner = () => {",
        "    if (!a) return null;",
        "    const [v] = useState(0);",
        "    return <div>{v}</div>;",
        "  };",
        "  return <Inner />;",
        "}",
      ].join("\n"),
    ],
    [
      "a guard whose return sits one block deeper",
      [
        "export default function Deep() {",
        "  if (a) {",
        "    if (b) {",
        "      return null;",
        "    }",
        "  }",
        "  const [v] = useState(0);",
        "  return <div>{v}</div>;",
        "}",
      ].join("\n"),
    ],
    [
      "a whole component on one line",
      "export default function Compact() { if (!a) return null; const [v] = useState(0); return <div>{v}</div>; }",
    ],
  ] as const;

  for (const [label, source] of CASES) {
    it(`should still catch the defect in ${label}`, () => {
      expect(hooksCalledAfterConditionalReturn(source)).toHaveLength(1);
    });
  }
});

describe("the client tree", () => {
  const CLIENT = join(__dirname, "..", "client", "src");

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
