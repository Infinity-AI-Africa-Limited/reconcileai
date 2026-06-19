/**
 * POC Hub (super-admin) — a single place that lists every company POC built on
 * ReconcileAI. Each POC has its own public page; the hub is the operator's index.
 */
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Database, Sparkles, ExternalLink, FlaskConical, CreditCard } from "lucide-react";

type Poc = {
  name: string;
  blurb: string;
  path: string;
  icon: typeof Database;
  accent: string;
  status: "Live" | "Active";
};

const POCS: Poc[] = [
  {
    name: "Woodcore CBS",
    blurb: "GL-to-CBS reconciliation against the live Woodcore/Fineract test tenant (savings + loan portfolios).",
    path: "/woodcore-poc",
    icon: Database,
    accent: "from-[#1a2f6e] to-[#2563eb]",
    status: "Live",
  },
  {
    name: "Salad Africa",
    blurb: "Self-service ledger ↔ bank statement reconciliation. Upload Excel/CSV/PDF (incl. scans) and run the 3-layer engine.",
    path: "/salad-africa-poc",
    icon: Sparkles,
    accent: "from-emerald-700 to-lime-600",
    status: "Active",
  },
  {
    name: "LAPO MFB — Interswitch Card Settlement",
    blurb: "CBS vs Interswitch card settlement reconciliation. Pre-loaded demo dataset with chargebacks, settlement shortfalls, late presentments, duplicate RRNs, and amount mismatches. Supports Mastercard, Visa, and Verve.",
    path: "/lapo-poc",
    icon: CreditCard,
    accent: "from-[#003087] to-[#1677ff]",
    status: "Active",
  },
];

export default function PocHub() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <FlaskConical className="h-6 w-6 text-primary" />
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-primary">POC Hub</h1>
          <p className="text-muted-foreground mt-1">Proof-of-concept environments built for prospective clients. Each opens in its own public page.</p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {POCS.map((poc) => {
          const Icon = poc.icon;
          return (
            <Card key={poc.path} className="overflow-hidden">
              <div className={`h-1.5 bg-gradient-to-r ${poc.accent}`} />
              <CardContent className="pt-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Icon className="h-5 w-5 text-primary" />
                    <h2 className="font-semibold">{poc.name}</h2>
                  </div>
                  <Badge variant="outline" className="text-emerald-700 border-emerald-300">{poc.status}</Badge>
                </div>
                <p className="text-sm text-muted-foreground mt-2 min-h-[40px]">{poc.blurb}</p>
                <div className="mt-4 flex items-center gap-2">
                  <a href={poc.path} target="_blank" rel="noopener noreferrer">
                    <Button size="sm" className="gap-2"><ExternalLink className="h-4 w-4" /> Open POC</Button>
                  </a>
                  <code className="text-xs text-muted-foreground">{poc.path}</code>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground">
        POC pages are public (no login) so prospects can use them directly. POC data is isolated from real tenant data.
      </p>
    </div>
  );
}
