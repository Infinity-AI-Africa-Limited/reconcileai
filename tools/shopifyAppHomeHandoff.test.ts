/**
 * Shopify App Home may send a merchant to ReconcileAI's Payment Exceptions page,
 * and must never carry Shopify or tenant context there. The handoff function
 * (client/src/lib/shopifyExceptionHandoff.ts) builds the only link that is
 * allowed to; this test reads the page's syntax tree to prove the page uses it
 * and adds nothing. A unit test of the function proves nothing about a page
 * that hand-builds `/exceptions?shop=…` next to it.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const PAGE = path.resolve(__dirname, "../client/src/pages/ShopifyAppHome.tsx");
const HANDOFF = "shopifyExceptionWorkspaceHandoff";

function parse(): ts.SourceFile {
  return ts.createSourceFile(PAGE, fs.readFileSync(PAGE, "utf8"), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/** Every `<a …>` opening or self-closing element in the page. */
function anchors(source: ts.SourceFile): Array<ts.JsxOpeningElement | ts.JsxSelfClosingElement> {
  const found: Array<ts.JsxOpeningElement | ts.JsxSelfClosingElement> = [];
  walk(source, (node) => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === "a") {
      found.push(node);
    }
  });
  return found;
}

describe("when Shopify App Home links to the exception workspace", () => {
  const source = parse();

  it("should never spell the workspace path itself", () => {
    const literals: string[] = [];
    walk(source, (node) => {
      if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
        literals.push(node.text);
      }
      if (ts.isJsxText(node)) literals.push(node.text);
    });
    expect(literals.filter((text) => text.includes("/exceptions"))).toEqual([]);
  });

  it("should build the link from the page's own origin through the handoff function only", () => {
    const calls: string[] = [];
    walk(source, (node) => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === HANDOFF) {
        calls.push(node.arguments.map((argument) => argument.getText(source)).join(", "));
      }
    });
    expect(calls).toEqual(["window.location.origin"]);
  });

  it("should spread only the handoff into its link, and let nothing override it", () => {
    // Which variable holds the handoff: the one initialised by the call.
    const holders = new Set<string>();
    walk(source, (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isCallExpression(node.initializer) &&
        node.initializer.expression.getText(source) === HANDOFF
      ) {
        holders.add(node.name.text);
      }
    });
    expect(holders.size).toBe(1);

    const spreading = anchors(source).filter((anchor) =>
      anchor.attributes.properties.some((property) => ts.isJsxSpreadAttribute(property))
    );
    expect(spreading).toHaveLength(1);
    const [anchor] = spreading;
    const properties = anchor!.attributes.properties;
    const spreads = properties.filter(ts.isJsxSpreadAttribute).map((spread) => spread.expression.getText(source));
    expect(spreads).toEqual([...holders]);
    // An explicit href, target or rel next to the spread would replace the
    // vetted value (or, before it, be replaced by it: either way it is a second
    // source of truth for where the merchant goes).
    const explicit = properties.filter(ts.isJsxAttribute).map((attribute) => attribute.name.getText(source));
    expect(explicit.filter((name) => ["href", "target", "rel"].includes(name))).toEqual([]);
  });

  it("should send no other link out of the embedded app", () => {
    // Every other anchor is a fixed public page (Privacy, Support) of this app.
    const hrefs = anchors(source)
      .flatMap((anchor) => anchor.attributes.properties.filter(ts.isJsxAttribute))
      .filter((attribute) => attribute.name.getText(source) === "href")
      .map((attribute) => attribute.initializer?.getText(source));
    expect(hrefs.sort()).toEqual(['"/privacy"', '"/support"']);
  });
});
