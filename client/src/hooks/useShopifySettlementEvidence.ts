import { useMemo, useState } from "react";
import {
  submitShopifySettlementEvidence,
  shopifyAppHomeErrorMessage,
  type ShopifySettlementEvidenceCommitted,
  type ShopifySettlementEvidenceDryRun,
  type ShopifySettlementEvidenceResult,
  type ShopifySettlementField,
} from "@/lib/shopifyAppBridge";
import {
  assignSettlementColumn,
  confirmedSettlementMapping,
  sameSettlementMapping,
  type SettlementMapping,
} from "@/lib/shopifySettlementMapping";
import {
  canCheckSettlementEvidence,
  canImportSettlementEvidence,
  isSettlementSpreadsheet,
  settlementEvidenceInputError,
  type SettlementEvidenceFile,
} from "@/lib/shopifySettlementEvidenceRules";

async function encodeSettlementEvidence(file: SettlementEvidenceFile): Promise<{
  content: string;
  contentEncoding: "utf8" | "base64";
}> {
  if (!isSettlementSpreadsheet(file.name)) {
    return { content: await file.text(), contentEncoding: "utf8" };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return { content: btoa(binary), contentEncoding: "base64" };
}

export function useShopifySettlementEvidence() {
  const [settlementFile, setSettlementFile] = useState<File | null>(null);
  const [sourceLabel, setSourceLabel] = useState("");
  const [busy, setBusy] = useState<"checking" | "importing" | null>(null);
  const [preview, setPreview] = useState<ShopifySettlementEvidenceDryRun | null>(null);
  const [result, setResult] = useState<ShopifySettlementEvidenceCommitted | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [columnMapping, setColumnMapping] = useState<SettlementMapping | null>(null);
  const [checkedMapping, setCheckedMapping] = useState<SettlementMapping | null>(null);

  const mappingEdited = useMemo(
    () => columnMapping !== null && checkedMapping !== null && !sameSettlementMapping(columnMapping, checkedMapping),
    [columnMapping, checkedMapping],
  );
  const eligibility = useMemo(
    () => ({
      file: settlementFile,
      sourceLabel,
      busy: busy !== null,
      preview,
      result,
      checkedMapping,
      mappingEdited,
    }),
    [busy, checkedMapping, mappingEdited, preview, result, settlementFile, sourceLabel],
  );

  const chooseFile = (file: File | null) => {
    setSettlementFile(file);
    setPreview(null);
    setResult(null);
    setError(null);
    setColumnMapping(null);
    setCheckedMapping(null);
  };

  const updateSourceLabel = (value: string) => {
    setSourceLabel(value);
    setPreview(null);
    setResult(null);
    setError(null);
    setCheckedMapping(null);
  };

  const changeColumn = (field: ShopifySettlementField, header: string | null) => {
    setColumnMapping((current) => assignSettlementColumn(current ?? {}, field, header));
    setResult(null);
  };

  const submit = async (dryRun: boolean) => {
    const inputError = settlementEvidenceInputError(settlementFile, sourceLabel);
    if (inputError || !settlementFile) {
      setError(inputError);
      return;
    }
    if (!dryRun && !canImportSettlementEvidence(eligibility)) return;

    setBusy(dryRun ? "checking" : "importing");
    setError(null);
    if (dryRun) setResult(null);
    try {
      const encoded = await encodeSettlementEvidence(settlementFile);
      const mappingToSend = dryRun ? columnMapping : checkedMapping;
      const response: ShopifySettlementEvidenceResult = await submitShopifySettlementEvidence({
        fileName: settlementFile.name,
        sourceLabel: sourceLabel.trim(),
        ...encoded,
        ...(mappingToSend ? { columnMapping: mappingToSend } : {}),
        dryRun,
      });
      if (response.committed) {
        setResult(response);
      } else {
        const confirmed = confirmedSettlementMapping(response.mapping);
        setPreview(response);
        setColumnMapping(confirmed);
        setCheckedMapping(confirmed);
      }
    } catch (submitError) {
      setError(shopifyAppHomeErrorMessage(submitError));
    } finally {
      setBusy(null);
    }
  };

  return {
    settlementFile,
    sourceLabel,
    busy,
    preview,
    result,
    error,
    columnMapping,
    mappingEdited,
    canCheck: canCheckSettlementEvidence(eligibility),
    canImport: canImportSettlementEvidence(eligibility),
    chooseFile,
    updateSourceLabel,
    changeColumn,
    checkColumns: () => submit(true),
    importEvidence: () => submit(false),
  };
}
