import { describe, expect, it } from "vitest";
import {
  describePrivacyDelivery,
  privacyDeliveriesToShow,
  privacyDeliveryHref,
  type PrivacyDeliveryRow,
} from "./shopifyPrivacyDeliveries";

const NOW = new Date("2026-09-25T12:00:00Z");
const row = (over: Partial<PrivacyDeliveryRow> = {}): PrivacyDeliveryRow => ({
  artifactId: "11111111-1111-4111-8111-111111111111",
  kind: "order_evidence",
  recordsFound: 3,
  generatedAt: "2026-09-24T12:00:00Z",
  expiresAt: "2026-10-01T12:00:00Z",
  deliveryStatus: "pending",
  ...over,
});

describe("when a customer data-request export is listed for the merchant", () => {
  it("should link to the authenticated download route, never a storage URL", () => {
    expect(describePrivacyDelivery(row(), NOW).href).toBe(
      "/api/shopify/privacy/artifacts/11111111-1111-4111-8111-111111111111",
    );
    expect(privacyDeliveryHref("a/b")).toBe("/api/shopify/privacy/artifacts/a%2Fb");
  });

  it("should describe order evidence and a zero-record statement differently", () => {
    expect(describePrivacyDelivery(row({ recordsFound: 1 }), NOW).summary).toBe("1 order record");
    expect(describePrivacyDelivery(row({ recordsFound: 3 }), NOW).summary).toBe("3 order records");
    expect(describePrivacyDelivery(row({ kind: "zero_record_attestation", recordsFound: 0 }), NOW).summary).toMatch(
      /zero-record statement/,
    );
  });

  it("should count whole days left, never negative", () => {
    expect(describePrivacyDelivery(row(), NOW).expiresInDays).toBe(6);
    expect(describePrivacyDelivery(row({ expiresAt: "2026-09-25T18:00:00Z" }), NOW).expiresInDays).toBe(0);
    expect(describePrivacyDelivery(row({ expiresAt: "2026-09-20T00:00:00Z" }), NOW).expiresInDays).toBe(0);
  });

  it("should put undelivered exports first, soonest to expire first", () => {
    const shown = privacyDeliveriesToShow(
      [
        row({ artifactId: "delivered", deliveryStatus: "acknowledged", expiresAt: "2026-09-26T00:00:00Z" }),
        row({ artifactId: "later", expiresAt: "2026-10-01T00:00:00Z" }),
        row({ artifactId: "sooner", expiresAt: "2026-09-27T00:00:00Z" }),
      ],
      NOW,
    );
    expect(shown.map((view) => view.artifactId)).toEqual(["sooner", "later", "delivered"]);
    expect(shown.map((view) => view.delivered)).toEqual([false, false, true]);
  });
});
