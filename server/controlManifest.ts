import { parseExactDecimal } from "../shared/money";
import type {
  ControlSourceRole,
  DuplicateDeliveryState,
  SourceSchemaState,
} from "./controlCompleteness";

export const CONTROL_SOURCE_CONTRACT_STATUSES = [
  "draft",
  "approved",
  "tested",
  "active",
  "retired",
] as const;

export type ControlSourceContractStatus =
  (typeof CONTROL_SOURCE_CONTRACT_STATUSES)[number];

export interface ControlSourceContractInput {
  sourceKey: string;
  version: number;
  role: ControlSourceRole;
  displayName: string;
  systemName: string;
  controlPurpose: string;
  accountableOwner: string;
  escalationOwner: string;
  deliveryRoute: string;
  timeZone: string;
  cutoffMinutes: number;
  schemaVersion: string;
  controlTotalRequired: boolean;
  expectedCurrency: string | null;
  status: ControlSourceContractStatus;
  approvalReference: string | null;
  effectiveAt: Date;
}

export interface ControlBatchManifestInput {
  sourceContractId: number;
  controlPeriod: string;
  deliveryIdentity: string;
  uploadBatchId: number | null;
  receivedAt: Date;
  mappingVersion: string;
  reconciliationPolicyVersion: string;
  schemaState: SourceSchemaState;
  duplicateDelivery: DuplicateDeliveryState;
  invalidRowCount: number;
  expectedRecordCount: number | null;
  expectedMonetaryTotal: string | null;
  expectedCurrency: string | null;
  receivedRecordCount: number;
  receivedMonetaryTotal: string;
  receivedCurrency: string;
}

export interface StoredControlSourceContract {
  id: number;
  organizationId: number;
  sourceKey: string;
  version: number;
  status: ControlSourceContractStatus;
  controlTotalRequired: boolean;
  expectedCurrency: string | null;
}

export class ControlManifestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlManifestValidationError";
  }
}

export class ControlManifestConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlManifestConflictError";
  }
}

export function validateSourceContract(
  input: ControlSourceContractInput
): void {
  if (!Number.isSafeInteger(input.version) || input.version < 1) {
    throw new ControlManifestValidationError(
      "Source-contract version must be a positive integer."
    );
  }
  if (
    !Number.isSafeInteger(input.cutoffMinutes) ||
    input.cutoffMinutes < 0 ||
    input.cutoffMinutes > 1_439
  ) {
    throw new ControlManifestValidationError(
      "Daily source cut-off must be between 00:00 and 23:59."
    );
  }
  if (!isNonBlank(input.sourceKey) || !isNonBlank(input.schemaVersion)) {
    throw new ControlManifestValidationError(
      "Source key and schema version are required."
    );
  }
  if (!isKnownContractStatus(input.status)) {
    throw new ControlManifestValidationError(
      "Source-contract status is not recognised."
    );
  }
  if (!isValidDate(input.effectiveAt)) {
    throw new ControlManifestValidationError(
      "Source-contract effective time is invalid."
    );
  }
  if (input.status !== "draft" && !isNonBlank(input.approvalReference)) {
    throw new ControlManifestValidationError(
      "An approval reference is required before a source contract can leave draft."
    );
  }
  if (input.controlTotalRequired && !isCurrency(input.expectedCurrency)) {
    throw new ControlManifestValidationError(
      "A three-letter expected currency is required when the contract requires control totals."
    );
  }
  if (!input.controlTotalRequired && input.expectedCurrency !== null) {
    throw new ControlManifestValidationError(
      "Expected currency must be omitted when the contract does not require control totals."
    );
  }
}

export function validateBatchManifest(
  input: ControlBatchManifestInput,
  contract: StoredControlSourceContract
): void {
  if (input.sourceContractId !== contract.id) {
    throw new ControlManifestValidationError(
      "The batch manifest does not belong to the supplied source contract."
    );
  }
  if (contract.status === "draft" || contract.status === "retired") {
    throw new ControlManifestValidationError(
      "A batch manifest requires an approved, tested, or active source contract."
    );
  }
  if (!isNonBlank(input.controlPeriod) || !isNonBlank(input.deliveryIdentity)) {
    throw new ControlManifestValidationError(
      "Control period and delivery identity are required."
    );
  }
  if (!isValidDate(input.receivedAt)) {
    throw new ControlManifestValidationError("Batch receipt time is invalid.");
  }
  if (
    !Number.isSafeInteger(input.invalidRowCount) ||
    input.invalidRowCount < 0
  ) {
    throw new ControlManifestValidationError(
      "Invalid-row count must be a non-negative integer."
    );
  }
  if (
    !Number.isSafeInteger(input.receivedRecordCount) ||
    input.receivedRecordCount < 0
  ) {
    throw new ControlManifestValidationError(
      "Received record count must be a non-negative integer."
    );
  }
  if (
    input.uploadBatchId !== null &&
    (!Number.isSafeInteger(input.uploadBatchId) || input.uploadBatchId < 1)
  ) {
    throw new ControlManifestValidationError(
      "Upload batch identifier must be a positive integer when supplied."
    );
  }
  assertExactMoney(input.receivedMonetaryTotal, "Received monetary total");
  if (!isCurrency(input.receivedCurrency)) {
    throw new ControlManifestValidationError(
      "Received currency must be a three-letter ISO code."
    );
  }

  const hasAnyExpected = [
    input.expectedRecordCount,
    input.expectedMonetaryTotal,
    input.expectedCurrency,
  ].some(value => value !== null);

  if (!contract.controlTotalRequired) {
    if (hasAnyExpected) {
      throw new ControlManifestValidationError(
        "Expected control totals cannot be recorded when the source contract does not require them."
      );
    }
    return;
  }

  if (
    input.expectedRecordCount === null ||
    input.expectedMonetaryTotal === null ||
    input.expectedCurrency === null
  ) {
    throw new ControlManifestValidationError(
      "Expected count, monetary total, and currency are required by this source contract."
    );
  }
  if (
    !Number.isSafeInteger(input.expectedRecordCount) ||
    input.expectedRecordCount < 0
  ) {
    throw new ControlManifestValidationError(
      "Expected record count must be a non-negative integer."
    );
  }
  assertExactMoney(input.expectedMonetaryTotal, "Expected monetary total");
  if (!isCurrency(input.expectedCurrency)) {
    throw new ControlManifestValidationError(
      "Expected currency must be a three-letter ISO code."
    );
  }
  if (
    contract.expectedCurrency !== null &&
    input.expectedCurrency.toUpperCase() !==
      contract.expectedCurrency.toUpperCase()
  ) {
    throw new ControlManifestValidationError(
      "Expected currency must match the approved source contract."
    );
  }
}

function assertExactMoney(value: string, label: string): void {
  if (parseExactDecimal(value) === null) {
    throw new ControlManifestValidationError(
      `${label} must be an exact decimal string.`
    );
  }
}

function isKnownContractStatus(
  value: string
): value is ControlSourceContractStatus {
  return (CONTROL_SOURCE_CONTRACT_STATUSES as readonly string[]).includes(
    value
  );
}

function isCurrency(value: string | null): value is string {
  return typeof value === "string" && /^[A-Za-z]{3}$/.test(value);
}

function isNonBlank(value: string | null): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidDate(value: Date): boolean {
  return value instanceof Date && !Number.isNaN(value.getTime());
}
