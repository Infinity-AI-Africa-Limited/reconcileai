/**
 * Every filter on the Payment Exceptions page reaches the server.
 *
 * Two versions of the same defect shipped. First the Status menu wrote a
 * variable the query never read, so choosing "Open" did nothing. Then category
 * and severity were applied in the browser to the 200 rows already loaded, so
 * over a wide range the table and its count described one slice while the
 * total described everything — a filter that could report zero while matching
 * exceptions existed. Both look like working filters on a small dataset.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const SRC = readFileSync(path.resolve(__dirname, "..", "client/src/pages/Exceptions.tsx"), "utf8").replace(/\r\n/g, "\n");

/** The argument text of the page's `trpc.exceptions.list.useQuery(...)`. */
function listQueryArgs(): string {
  const start = SRC.indexOf("trpc.exceptions.list.useQuery(");
  expect(start, "the exceptions.list query has moved").toBeGreaterThan(-1);
  let depth = 0;
  for (let i = start + "trpc.exceptions.list.useQuery".length; i < SRC.length; i++) {
    if (SRC[i] === "(") depth++;
    else if (SRC[i] === ")" && --depth === 0) return SRC.slice(start, i);
  }
  throw new Error("unbalanced exceptions.list query");
}

describe("when the Payment Exceptions page filters", () => {
  it("should send status, category and severity to the server", () => {
    const args = listQueryArgs();
    expect(args).toMatch(/status: statusFilter/);
    expect(args).toMatch(/category: filters[.]category/);
    expect(args).toMatch(/severity: filters[.]severity/);
  });

  it("should not filter the loaded rows again in the browser", () => {
    // A second, client-side pass over one page of results is the slice bug.
    expect(SRC).not.toMatch(/data[?]?[.]data[?]?[.]filter[(]/);
  });

  it("should bind the Status menu to the same state the query reads", () => {
    expect(SRC).toMatch(/<Select value=[{]statusFilter[}] onValueChange=[{]setStatusFilter[}]>/);
  });
});
