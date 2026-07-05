/**
 * Client Onboarding — Infinity AI super-admin page.
 *
 * The partner-channel front door: onboard a WoodCore client bank in one step —
 * organization + admin invite + connector config + data channel. Each onboarded
 * institution gets its own org-scoped ReconcileAI interface (enter it via the
 * portal switcher on the All Organisations page).
 *
 * Direct clients are NOT onboarded here — they are created as organizations
 * with a direct connection (onboardingChannel "direct"). Future core-banking
 * connectors (Mambu, T24, …) will appear here as additional channels.
 */
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Building2, CheckCircle2, Copy, Plug, UserPlus } from "lucide-react";

export default function ClientOnboarding() {
  const utils = trpc.useUtils();
  const { data: clients } = trpc.woodcoreConnector.listOnboardedClients.useQuery();
  const onboard = trpc.woodcoreConnector.onboardClient.useMutation();

  const [form, setForm] = useState({
    orgName: "",
    adminName: "",
    adminEmail: "",
    country: "NGA",
    baseCurrency: "NGN",
    baseUrl: "",
    tenantId: "default",
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((p) => ({ ...p, [k]: e.target.value }));

  const [lastResult, setLastResult] = useState<{
    orgCode: string;
    webhookPath: string;
    emailSent: boolean;
    magicLink: string | null;
  } | null>(null);

  const handleOnboard = async () => {
    if (!form.orgName || !form.adminName || !form.adminEmail) {
      toast.error("Institution name, admin name and admin email are required");
      return;
    }
    try {
      const r = await onboard.mutateAsync({
        orgName: form.orgName,
        country: form.country,
        baseCurrency: form.baseCurrency,
        adminName: form.adminName,
        adminEmail: form.adminEmail,
        origin: window.location.origin,
        connector: form.baseUrl
          ? { baseUrl: form.baseUrl, tenantId: form.tenantId || "default" }
          : { tenantId: form.tenantId || "default" },
      });
      setLastResult({
        orgCode: r.organizationCode,
        webhookPath: r.webhookPath,
        emailSent: r.emailSent,
        magicLink: r.magicLink,
      });
      toast.success(`${form.orgName} onboarded via the WoodCore channel`);
      setForm({ orgName: "", adminName: "", adminEmail: "", country: "NGA", baseCurrency: "NGN", baseUrl: "", tenantId: "default" });
      utils.woodcoreConnector.listOnboardedClients.invalidate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Onboarding failed");
    }
  };

  return (
    <div className="container mx-auto py-8 space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
          <Building2 className="h-7 w-7" /> Client Onboarding
        </h1>
        <p className="text-muted-foreground mt-1">
          Onboard core-banking clients through their CBS connector. Each institution gets its own
          organization and interface; their transactions flow in via the connector.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserPlus className="h-5 w-5" /> Onboard a WoodCore client
          </CardTitle>
          <CardDescription>
            Creates the organization, invites the institution's admin by email, and provisions
            their WoodCore connector (disabled until the connection test passes). Direct clients
            are created from All Organisations instead — this page is only for CBS-partner clients.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label>Onboarding channel</Label>
            <Select value="woodcore" disabled>
              <SelectTrigger className="w-full md:w-80">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="woodcore">WoodCore (core banking)</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              More core-banking connectors will appear here as they ship.
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Institution name *</Label>
              <Input placeholder="Sunrise Microfinance Bank" value={form.orgName} onChange={set("orgName")} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Country</Label>
                <Input value={form.country} onChange={set("country")} maxLength={3} />
              </div>
              <div className="space-y-1.5">
                <Label>Currency</Label>
                <Input value={form.baseCurrency} onChange={set("baseCurrency")} maxLength={3} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Admin name *</Label>
              <Input placeholder="Adaeze Okafor" value={form.adminName} onChange={set("adminName")} />
            </div>
            <div className="space-y-1.5">
              <Label>Admin email *</Label>
              <Input type="email" placeholder="ops@sunrisemfb.ng" value={form.adminEmail} onChange={set("adminEmail")} />
            </div>
            <div className="space-y-1.5">
              <Label>WoodCore API address (optional — can be added later)</Label>
              <Input placeholder="https://api.sunrisemfb.woodcore.app/api/v1" value={form.baseUrl} onChange={set("baseUrl")} />
            </div>
            <div className="space-y-1.5">
              <Label>WoodCore tenant ID</Label>
              <Input value={form.tenantId} onChange={set("tenantId")} />
            </div>
          </div>

          <Button onClick={handleOnboard} disabled={onboard.isPending}>
            <UserPlus className="h-4 w-4 mr-2" />
            {onboard.isPending ? "Onboarding…" : "Onboard client"}
          </Button>

          {lastResult && (
            <Card className="border-green-300 bg-green-50/50">
              <CardContent className="pt-4 text-sm space-y-2">
                <p className="flex items-center gap-2 font-medium">
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                  Onboarded as <code>{lastResult.orgCode}</code>
                </p>
                <p>
                  Webhook address for the WoodCore team:{" "}
                  <code className="bg-muted px-1.5 py-0.5 rounded">{lastResult.webhookPath}</code>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-1"
                    onClick={() => {
                      navigator.clipboard.writeText(`${window.location.origin}${lastResult.webhookPath}`);
                      toast.success("Webhook URL copied");
                    }}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </p>
                {lastResult.emailSent ? (
                  <p>The admin's welcome email with a sign-in link has been sent.</p>
                ) : lastResult.magicLink ? (
                  <p className="text-amber-700">
                    Email was not sent (email service not configured) — share this sign-in link
                    with the admin directly:{" "}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        navigator.clipboard.writeText(lastResult.magicLink!);
                        toast.success("Sign-in link copied");
                      }}
                    >
                      <Copy className="h-3.5 w-3.5 mr-1" /> Copy invite link
                    </Button>
                  </p>
                ) : null}
                <p className="text-xs text-muted-foreground">
                  Next: enter their portal from All Organisations → configure credentials on the
                  WoodCore Connector page → test the connection → enable the connector.
                </p>
              </CardContent>
            </Card>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Plug className="h-5 w-5" /> WoodCore-channel clients
          </CardTitle>
          <CardDescription>
            Institutions onboarded through the WoodCore connector, with their connector state.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!clients?.length ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No WoodCore clients onboarded yet.
            </p>
          ) : (
            <div className="space-y-2">
              {clients.map((c) => (
                <div key={c.organizationId} className="flex items-center justify-between rounded-lg border p-3 text-sm">
                  <div className="flex items-center gap-3">
                    <span className="font-medium">{c.name}</span>
                    <code className="text-xs text-muted-foreground">{c.code}</code>
                    {!c.isActive && <Badge variant="outline">inactive</Badge>}
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    {c.connector ? (
                      <>
                        <Badge
                          className={
                            !c.connector.isEnabled
                              ? "bg-gray-100 text-gray-600"
                              : c.connector.lastHealthStatus === "ok"
                                ? "bg-green-100 text-green-800"
                                : c.connector.lastHealthStatus === "down"
                                  ? "bg-red-100 text-red-800"
                                  : "bg-amber-100 text-amber-800"
                          }
                        >
                          {!c.connector.isEnabled ? "setup pending" : c.connector.lastHealthStatus}
                        </Badge>
                        {!c.connector.baseUrlSet && (
                          <span className="text-muted-foreground">API address not set</span>
                        )}
                      </>
                    ) : (
                      <Badge variant="outline">no connector</Badge>
                    )}
                    <span className="text-muted-foreground">
                      since {new Date(c.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
