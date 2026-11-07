/** No raw child data may leave the parent until the exact closed report is canonical. */
import { serializeReport, REFUSED_REPORT } from './report';
export function screenReport(text: string): string {
  const canonical = serializeReport(text);
  if (canonical === REFUSED_REPORT) throw new Error('report_refused');
  return canonical;
}
