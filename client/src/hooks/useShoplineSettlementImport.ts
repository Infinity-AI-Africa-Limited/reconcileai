import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import { usePortalContext } from "@/contexts/PortalContext";
import {
  canImportShoplineSettlement,
  shoplineMappingEdited,
  shoplineSettlementFileError,
  shoplineSettlementMapping,
  type ShoplineSettlementField,
  type ShoplineSettlementMapping,
} from "@/lib/shoplineSettlementImport";

const SPREADSHEET_RE = /\.(xlsx|xlsm|xls)$/i;

async function encodeSettlementFile(file: File): Promise<{ content: string; encoding: "utf8" | "base64" }> {
  if (!SPREADSHEET_RE.test(file.name)) return { content: await file.text(), encoding: "utf8" };
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000; // chunked: spreading a whole file blows the argument limit
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return { content: btoa(binary), encoding: "base64" };
}

export type ShoplineSettlementPreview = {
  committed: boolean;
  headers: string[];
  mapping: ShoplineSettlementMapping;
  missingRequired: string[];
  totalRows: number;
  parseErrors: string[];
};

export type ShoplineSettlementCommitted = ShoplineSettlementPreview & {
  imported: number;
  duplicates: number;
  failed: number;
  matchedCount: number;
};

/**
 * The SHOPLINE settlement-file import: check the columns, correct the mapping,
 * import exactly what was checked.
 *
 * The first check lets the server detect columns. After that, the mapping on
 * screen is sent as CONFIRMED — the whole answer, so a field the merchant took
 * away stays away — and an import sends only the mapping the last check
 * confirmed. An edit since then must be checked again.
 */
export function useShoplineSettlementImport(onImported?: (result: ShoplineSettlementCommitted) => void) {
  const { viewAsOrg } = usePortalContext();
  const importFile = trpc.shoplineConnector.importSettlementFile.useMutation();
  const [file, setFile] = useState<File | null>(null);
  const [sourceLabel, setSourceLabel] = useState("");
  const [busy, setBusy] = useState<"checking" | "importing" | null>(null);
  const [preview, setPreview] = useState<ShoplineSettlementPreview | null>(null);
  const [result, setResult] = useState<ShoplineSettlementCommitted | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [columnMapping, setColumnMapping] = useState<ShoplineSettlementMapping | null>(null);
  const [checkedMapping, setCheckedMapping] = useState<ShoplineSettlementMapping | null>(null);

  const mappingEdited = useMemo(
    () => shoplineMappingEdited({ columnMapping, checkedMapping }),
    [columnMapping, checkedMapping],
  );
  const canImport = canImportShoplineSettlement({
    busy: busy !== null,
    preview: result ? { committed: true, missingRequired: [] } : preview,
    checkedMapping,
    columnMapping,
  });

  const reset = () => {
    setPreview(null);
    setResult(null);
    setError(null);
    setColumnMapping(null);
    setCheckedMapping(null);
  };

  const chooseFile = (next: File | null) => {
    setFile(next);
    reset();
  };

  const changeColumn = (field: ShoplineSettlementField, header: string | null) => {
    setColumnMapping((current) => shoplineSettlementMapping.assign(current ?? {}, field, header));
    setResult(null);
  };

  const submit = async (dryRun: boolean) => {
    const fileError = shoplineSettlementFileError(file);
    if (fileError || !file) {
      setError(fileError);
      return;
    }
    if (!dryRun && !canImport) return;

    setBusy(dryRun ? "checking" : "importing");
    setError(null);
    try {
      const { content, encoding } = await encodeSettlementFile(file);
      const mappingToSend = dryRun ? columnMapping : checkedMapping;
      const response = await importFile.mutateAsync({
        fileName: file.name,
        organizationId: viewAsOrg?.id,
        content,
        contentEncoding: encoding,
        sourceLabel: sourceLabel.trim() || file.name,
        ...(mappingToSend ? { columnMapping: mappingToSend } : {}),
        dryRun,
      });
      if (response.committed) {
        setResult(response as ShoplineSettlementCommitted);
        onImported?.(response as ShoplineSettlementCommitted);
      } else {
        const confirmed = shoplineSettlementMapping.confirmed(response.mapping as ShoplineSettlementMapping);
        setPreview(response as ShoplineSettlementPreview);
        setColumnMapping(confirmed);
        setCheckedMapping(confirmed);
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Import failed");
    } finally {
      setBusy(null);
    }
  };

  return {
    file,
    sourceLabel,
    busy,
    preview,
    result,
    error,
    columnMapping,
    mappingEdited,
    canCheck: busy === null && shoplineSettlementFileError(file) === null,
    canImport,
    chooseFile,
    setSourceLabel: (value: string) => {
      setSourceLabel(value);
      setResult(null);
    },
    changeColumn,
    checkColumns: () => submit(true),
    importFile: () => submit(false),
  };
}
