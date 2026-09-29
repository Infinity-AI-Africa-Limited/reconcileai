import { useReducer, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { usePortalContext } from "@/contexts/PortalContext";
import {
  canImportShoplineSettlement,
  initialShoplineImportState,
  positiveReversalRowsNote,
  shoplineImportReducer,
  shoplineMappingEdited,
  shoplineSettlementFileError,
  type ShoplineSettlementCommitted,
  type ShoplineSettlementField,
  type ShoplineSettlementMapping,
  type ShoplineSettlementPreview,
} from "@/lib/shoplineSettlementImport";

export type { ShoplineSettlementCommitted, ShoplineSettlementPreview };

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

/**
 * The SHOPLINE settlement-file import: check the columns, correct the mapping,
 * import exactly what was checked.
 *
 * The first check lets the server detect columns. After that, the mapping on
 * screen is sent as CONFIRMED — the whole answer, so a field the merchant took
 * away stays away — and an import sends only the mapping the last check
 * confirmed. State changes go through shoplineImportReducer, which drops any
 * reply that answers for a file the merchant has since replaced.
 */
export function useShoplineSettlementImport(onImported?: (result: ShoplineSettlementCommitted) => void) {
  const { viewAsOrg } = usePortalContext();
  const importFile = trpc.shoplineConnector.importSettlementFile.useMutation();
  const [state, dispatch] = useReducer(shoplineImportReducer<File>, undefined, initialShoplineImportState<File>);
  // The generation of the file on screen, readable after an await.
  const generation = useRef(state.generation);
  generation.current = state.generation;

  const mappingEdited = shoplineMappingEdited(state);
  const canImport = canImportShoplineSettlement({
    busy: state.busy !== null,
    preview: state.result ? { committed: true, missingRequired: [] } : state.preview,
    checkedMapping: state.checkedMapping,
    columnMapping: state.columnMapping,
  });

  const submit = async (dryRun: boolean) => {
    const { file } = state;
    const fileError = shoplineSettlementFileError(file);
    if (fileError || !file) {
      dispatch({ type: "invalid", message: fileError ?? "Choose a file first." });
      return;
    }
    if (!dryRun && !canImport) return;

    const sentFor = state.generation;
    dispatch({ type: "started", generation: sentFor, mode: dryRun ? "checking" : "importing" });
    try {
      const { content, encoding } = await encodeSettlementFile(file);
      const mappingToSend = dryRun ? state.columnMapping : state.checkedMapping;
      const response = await importFile.mutateAsync({
        fileName: file.name,
        organizationId: viewAsOrg?.id,
        content,
        contentEncoding: encoding,
        sourceLabel: state.sourceLabel.trim() || file.name,
        ...(mappingToSend ? { columnMapping: mappingToSend } : {}),
        dryRun,
      });
      if (response.committed) {
        const result = response as ShoplineSettlementCommitted;
        dispatch({ type: "imported", generation: sentFor, result });
        // Tell the page only about an import for the file still on screen.
        if (sentFor === generation.current) onImported?.(result);
      } else {
        dispatch({
          type: "checked",
          generation: sentFor,
          preview: { ...(response as ShoplineSettlementPreview), mapping: response.mapping as ShoplineSettlementMapping },
        });
      }
    } catch (submitError) {
      dispatch({
        type: "failed",
        generation: sentFor,
        message: submitError instanceof Error ? submitError.message : "Import failed",
      });
    }
  };

  return {
    file: state.file,
    sourceLabel: state.sourceLabel,
    busy: state.busy,
    preview: state.preview,
    result: state.result,
    error: state.error,
    columnMapping: state.columnMapping,
    mappingEdited,
    // Said before the import, not after: once imported, these rows are booked by their sign.
    positiveReversalNote:
      state.preview && !state.result ? positiveReversalRowsNote(state.preview.positiveRowsReadingAsReversals) : null,
    canCheck: state.busy === null && shoplineSettlementFileError(state.file) === null,
    canImport,
    chooseFile: (file: File | null) => dispatch({ type: "chooseFile", file }),
    setSourceLabel: (value: string) => dispatch({ type: "sourceLabel", value }),
    changeColumn: (field: ShoplineSettlementField, header: string | null) =>
      dispatch({ type: "changeColumn", field, header }),
    checkColumns: () => submit(true),
    importFile: () => submit(false),
  };
}
