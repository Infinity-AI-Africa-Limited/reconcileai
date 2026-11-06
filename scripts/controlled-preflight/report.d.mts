export type ScreenedOutput = {
  status: "screened_report" | "screened_failure" | "output_refused";
  code: string;
  exit_code: number;
  hold: true;
  report?: Record<string, unknown>;
  verdict?: string;
};

/** Screens the pinned v2 output; never returns raw stdout, stderr or exceptions. */
export function screenOutput(stdout: string, stderr: string, exitCode: number): ScreenedOutput;
