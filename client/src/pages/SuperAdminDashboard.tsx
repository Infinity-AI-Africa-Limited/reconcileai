import { useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  Globe,
  Building2,
  Users,
  BarChart3,
  Plus,
  RefreshCw,
  Shield,
  Network,
  Layers,
  AlertCircle,
  ClipboardList,
  UserCog,
  PlusCircle,
  ArrowRightLeft,
  Crown,
  ChevronLeft,
  ChevronRight,
  LogIn,
  TrendingUp,
  Activity,
  CheckCircle2,
  Percent,
  AlertTriangle,
} from "lucide-react";
import {
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, AreaChart, Area,
} from "recharts";
import { usePortalContext, type OrgSegment } from "@/contexts/PortalContext";

type Segment = "financial_services" | "corporate_b2b" | "super_admin";

const SEGMENT_LABELS: Record<Segment, string> = {
  financial_services: "Financial Services",
  corporate_b2b: "Corporate B2B",
  super_admin: "Infinity AI (Internal)",
};

const SEGMENT_COLORS: Record<Segment, string> = {
  financial_services: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  corporate_b2b: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  super_admin: "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
};

function SegmentBadge({ segment }: { segment: string }) {
  const s = segment as Segment;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${SEGMENT_COLORS[s] ?? "bg-gray-100 text-gray-600"}`}>
      {SEGMENT_LABELS[s] ?? segment}
    </span>
  );
}

// ─── Platform Stats Cards ─────────────────────────────────────────────────────
function PlatformStatsCards() {
  const { data, isLoading } = trpc.superAdmin.platformStats.useQuery();

  const stats = [
    {
      icon: Building2,
      label: "Total Organisations",
      value: data?.totalOrgs ?? 0,
      color: "text-blue-500",
    },
    {
      icon: Users,
      label: "Total Users",
      value: data?.totalUsers ?? 0,
      color: "text-emerald-500",
    },
    {
      icon: BarChart3,
      label: "Total Recon Jobs",
      value: data?.totalJobs ?? 0,
      color: "text-amber-500",
    },
    {
      icon: Layers,
      label: "FS Orgs",
      value: (data?.segmentBreakdown as Record<string, number>)?.financial_services ?? 0,
      color: "text-blue-400",
    },
    {
      icon: Network,
      label: "B2B Orgs",
      value: (data?.segmentBreakdown as Record<string, number>)?.corporate_b2b ?? 0,
      color: "text-emerald-400",
    },
    {
      icon: Shield,
      label: "Internal Orgs",
      value: (data?.segmentBreakdown as Record<string, number>)?.super_admin ?? 0,
      color: "text-violet-400",
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      {stats.map((stat) => (
        <Card key={stat.label} className="border-border/60">
          <CardContent className="pt-4 pb-3 px-4">
            <div className="flex items-center gap-2 mb-1">
              <stat.icon className={`h-4 w-4 ${stat.color}`} />
              <span className="text-xs text-muted-foreground truncate">{stat.label}</span>
            </div>
            {isLoading ? (
              <div className="h-7 w-12 bg-muted animate-pulse rounded" />
            ) : (
              <p className="text-2xl font-bold text-foreground">{stat.value.toLocaleString()}</p>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ─── Create Organisation Dialog — the unified onboarding hub ─────────────────
// One front door for both acquisition channels:
//   Direct                — org with its own data connection (uploads/API/SFTP)
//   Core Banking Connector — CBS-partner client (WoodCore/T24/Mambu/FLEXCUBE):
//                            org + admin invite + connector config + channel
function CreateOrgDialog({
  open,
  onClose,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [channel, setChannel] = useState<"direct" | "cbs">("direct");
  const [cbsType, setCbsType] = useState<"woodcore" | "t24" | "mambu" | "flexcube">("woodcore");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [segment, setSegment] = useState<Segment>("financial_services");
  const [country, setCountry] = useState("NGA");
  const [currency, setCurrency] = useState("NGN");
  const [adminName, setAdminName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [cbsResult, setCbsResult] = useState<{
    orgCode: string;
    webhookPath: string;
    emailSent: boolean;
    magicLink: string | null;
  } | null>(null);

  const { data: cbsProfiles } = trpc.cbsConnector.listCbsProfiles.useQuery(undefined, { enabled: open });

  const resetForm = () => {
    setName(""); setCode(""); setSegment("financial_services");
    setAdminName(""); setAdminEmail(""); setApiBaseUrl("");
    setCbsResult(null);
  };

  const createOrg = trpc.superAdmin.createOrganization.useMutation({
    onSuccess: () => {
      toast.success("Organisation created successfully");
      resetForm();
      onSuccess();
      onClose();
    },
    onError: (err) => toast.error("Failed to create organisation", { description: err.message }),
  });

  const onboardCbs = trpc.cbsConnector.onboardClient.useMutation({
    onSuccess: (r) => {
      toast.success("Client onboarded via core banking connector");
      setCbsResult({
        orgCode: r.organizationCode,
        webhookPath: r.webhookPath,
        emailSent: r.emailSent,
        magicLink: r.magicLink,
      });
      onSuccess();
    },
    onError: (err) => toast.error("Onboarding failed", { description: err.message }),
  });

  const submit = () => {
    if (channel === "direct") {
      createOrg.mutate({ name, code, segment, country, baseCurrency: currency });
    } else {
      onboardCbs.mutate({
        cbsType,
        orgName: name,
        orgCode: code.trim() || undefined,
        country,
        baseCurrency: currency,
        adminName,
        adminEmail,
        origin: window.location.origin,
        connector: apiBaseUrl.trim() ? { baseUrl: apiBaseUrl.trim() } : undefined,
      });
    }
  };

  const pending = createOrg.isPending || onboardCbs.isPending;
  const cbsFieldsMissing = channel === "cbs" && (!adminName.trim() || !adminEmail.trim());

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) { resetForm(); onClose(); } }}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="h-4 w-4" />
            New Organisation
          </DialogTitle>
        </DialogHeader>

        {cbsResult ? (
          // CBS onboarding succeeded — hand the operator what they need next.
          <div className="space-y-3 py-2 text-sm">
            <p className="font-medium">
              Onboarded as <code className="bg-muted px-1.5 py-0.5 rounded">{cbsResult.orgCode}</code>
            </p>
            <p className="text-muted-foreground">
              Webhook address for the {cbsProfiles?.find((p) => p.type === cbsType)?.label ?? "CBS"} team:
            </p>
            <div className="flex items-center gap-2">
              <code className="text-xs bg-muted px-2 py-1 rounded break-all">{cbsResult.webhookPath}</code>
              <Button
                variant="ghost" size="sm"
                onClick={() => { navigator.clipboard.writeText(`${window.location.origin}${cbsResult.webhookPath}`); toast.success("Webhook URL copied"); }}
              >Copy</Button>
            </div>
            {cbsResult.emailSent ? (
              <p>The admin's welcome email with a sign-in link has been sent.</p>
            ) : cbsResult.magicLink ? (
              <div className="text-amber-700">
                Email not sent (email service unconfigured) — share the sign-in link directly:{" "}
                <Button
                  variant="outline" size="sm"
                  onClick={() => { navigator.clipboard.writeText(cbsResult.magicLink!); toast.success("Sign-in link copied"); }}
                >Copy invite link</Button>
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">
              Next: Enter Portal on the org row → Core Banking Connector page → add credentials →
              test connection → enable. Until the API is live, the CSV fallback import works immediately.
            </p>
            <DialogFooter>
              <Button onClick={() => { resetForm(); onClose(); }}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <>
            <div className="space-y-3 py-2">
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Onboarding Channel *</label>
                <Select value={channel} onValueChange={(v) => setChannel(v as "direct" | "cbs")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="direct">Direct — own data connection (uploads / API / SFTP)</SelectItem>
                    <SelectItem value="cbs">Via Core Banking Connector — CBS-partner client</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {channel === "cbs" && (
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Core Banking System *</label>
                  <Select value={cbsType} onValueChange={(v) => setCbsType(v as typeof cbsType)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(cbsProfiles ?? []).map((p) => (
                        <SelectItem key={p.type} value={p.type}>{p.label} — {p.vendor}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {cbsProfiles?.find((p) => p.type === cbsType)?.notes && (
                    <p className="text-xs text-muted-foreground mt-1">
                      {cbsProfiles.find((p) => p.type === cbsType)!.notes}
                    </p>
                  )}
                </div>
              )}

              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">Organisation Name *</label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. LapoMFB" />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground mb-1 block">
                  Code (short identifier) {channel === "direct" ? "*" : "(optional — auto-derived)"}
                </label>
                <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="e.g. LAPOMFB" maxLength={50} />
              </div>

              {channel === "direct" ? (
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Segment *</label>
                  <Select value={segment} onValueChange={(v) => setSegment(v as Segment)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="financial_services">Financial Services</SelectItem>
                      <SelectItem value="corporate_b2b">Corporate B2B</SelectItem>
                      <SelectItem value="super_admin">Infinity AI (Internal)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-medium text-muted-foreground mb-1 block">Institution Admin Name *</label>
                      <Input value={adminName} onChange={(e) => setAdminName(e.target.value)} placeholder="Adaeze Okafor" />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground mb-1 block">Institution Admin Email *</label>
                      <Input type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} placeholder="ops@bank.ng" />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">
                      CBS API address (optional — can be added later; CSV import works meanwhile)
                    </label>
                    <Input value={apiBaseUrl} onChange={(e) => setApiBaseUrl(e.target.value)} placeholder="https://api.bank.example/api/v1" />
                  </div>
                </>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Country Code</label>
                  <Input value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} maxLength={3} placeholder="NGA" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Base Currency</label>
                  <Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} maxLength={3} placeholder="NGN" />
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => { resetForm(); onClose(); }} disabled={pending}>Cancel</Button>
              <Button
                onClick={submit}
                disabled={pending || !name.trim() || (channel === "direct" && !code.trim()) || cbsFieldsMissing}
              >
                {pending ? "Creating…" : channel === "direct" ? "Create Organisation" : "Onboard Client"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Organisations Table ──────────────────────────────────────────────────────
function OrganisationsTable() {
  const utils = trpc.useUtils();
  const { data: orgs, isLoading, refetch } = trpc.superAdmin.allOrganizations.useQuery();
  const [search, setSearch] = useState("");
  const [segmentFilter, setSegmentFilter] = useState<string>("all");
  const [showCreate, setShowCreate] = useState(false);
  const { enterPortal } = usePortalContext();
  const [, setLocation] = useLocation();

  const updateSegment = trpc.superAdmin.updateOrganizationSegment.useMutation({
    onSuccess: () => {
      toast.success("Segment updated");
      utils.superAdmin.allOrganizations.invalidate();
      utils.superAdmin.platformStats.invalidate();
    },
    onError: (err) => toast.error("Failed to update segment", { description: err.message }),
  });

  const updateSso = trpc.superAdmin.setOrganizationSso.useMutation({
    onSuccess: () => {
      toast.success("Sign-in method updated — takes effect on the client's next login");
      utils.superAdmin.allOrganizations.invalidate();
    },
    onError: (err) => toast.error("Failed to update sign-in method", { description: err.message }),
  });

  const filtered = (orgs ?? []).filter((org: any) => {
    const matchSearch = !search || org.name.toLowerCase().includes(search.toLowerCase()) || org.code?.toLowerCase().includes(search.toLowerCase());
    const matchSeg = segmentFilter === "all" || org.segment === segmentFilter;
    return matchSearch && matchSeg;
  });

  return (
    <Card className="border-border/60">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Building2 className="h-4 w-4 text-muted-foreground" />
            All Organisations
            <Badge variant="secondary" className="ml-1">{orgs?.length ?? 0}</Badge>
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isLoading}>
              <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`} />
            </Button>
            <Button size="sm" onClick={() => setShowCreate(true)}>
              <Plus className="h-3.5 w-3.5 mr-1" />
              New Org
            </Button>
          </div>
        </div>
        <div className="flex gap-2 mt-2">
          <Input
            placeholder="Search by name or code…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 text-sm max-w-xs"
          />
          <Select value={segmentFilter} onValueChange={setSegmentFilter}>
            <SelectTrigger className="h-8 text-sm w-44">
              <SelectValue placeholder="All segments" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All segments</SelectItem>
              <SelectItem value="financial_services">Financial Services</SelectItem>
              <SelectItem value="corporate_b2b">Corporate B2B</SelectItem>
              <SelectItem value="super_admin">Infinity AI</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8 pl-4">ID</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>Segment</TableHead>
                <TableHead>Country</TableHead>
                <TableHead>Currency</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right pr-4">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 8 }).map((_, j) => (
                      <TableCell key={j}>
                        <div className="h-4 bg-muted animate-pulse rounded w-16" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center py-8 text-muted-foreground text-sm">
                    No organisations found
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((org: any) => (
                  <TableRow key={org.id}>
                    <TableCell className="pl-4 text-muted-foreground text-xs">{org.id}</TableCell>
                    <TableCell className="font-medium">{org.name}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{org.code ?? "—"}</TableCell>
                    <TableCell>
                      <SegmentBadge segment={org.segment ?? "financial_services"} />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{org.country ?? "NGA"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{org.baseCurrency ?? "NGN"}</TableCell>
                    <TableCell>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${org.isActive ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300" : "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"}`}>
                        {org.isActive ? "Active" : "Inactive"}
                      </span>
                    </TableCell>
                    <TableCell className="text-right pr-4">
                      <div className="flex items-center justify-end gap-2">
                        {/* Enter Portal button — only for non-super_admin segments */}
                        {org.segment !== "super_admin" && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs gap-1 px-2"
                            onClick={() => {
                              enterPortal({
                                id: org.id,
                                name: org.name,
                                code: org.code ?? "",
                                segment: org.segment as OrgSegment,
                                country: org.country ?? "NGA",
                                baseCurrency: org.baseCurrency ?? "NGN",
                              });
                              setLocation("/dashboard");
                            }}
                          >
                            <LogIn className="h-3 w-3" />
                            Enter Portal
                          </Button>
                        )}
                        <Select
                          value={org.segment ?? "financial_services"}
                          onValueChange={(v) => updateSegment.mutate({ organizationId: org.id, segment: v as Segment })}
                          disabled={updateSegment.isPending}
                        >
                          <SelectTrigger className="h-7 text-xs w-36">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="financial_services">Financial Services</SelectItem>
                            <SelectItem value="corporate_b2b">Corporate B2B</SelectItem>
                            <SelectItem value="super_admin">Infinity AI</SelectItem>
                          </SelectContent>
                        </Select>
                        {/* Sign-in method: email link is every org's default; flip
                            only when the client requests Google/Microsoft SSO. */}
                        {org.segment !== "super_admin" && (
                          <Select
                            value={org.ssoProvider ?? "none"}
                            onValueChange={(v) =>
                              updateSso.mutate({
                                organizationId: org.id,
                                ssoProvider: v as "none" | "google" | "microsoft" | "both",
                              })
                            }
                            disabled={updateSso.isPending}
                          >
                            <SelectTrigger className="h-7 text-xs w-40" title="Sign-in method">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">Email link (default)</SelectItem>
                              <SelectItem value="google">+ Google SSO</SelectItem>
                              <SelectItem value="microsoft">+ Microsoft SSO</SelectItem>
                              <SelectItem value="both">+ Google & Microsoft</SelectItem>
                            </SelectContent>
                          </Select>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
      <CreateOrgDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onSuccess={() => {
          utils.superAdmin.allOrganizations.invalidate();
          utils.superAdmin.platformStats.invalidate();
        }}
      />
    </Card>
  );
}

// ─── Users Table ──────────────────────────────────────────────────────────────
function AllUsersTable() {
  const utils = trpc.useUtils();
  const { data: allUsers, isLoading, refetch } = trpc.superAdmin.allUsers.useQuery();
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("all");

  const promote = trpc.superAdmin.promoteToSuperAdmin.useMutation({
    onSuccess: () => {
      toast.success("User promoted to Super Admin");
      utils.superAdmin.allUsers.invalidate();
    },
    onError: (err) => toast.error("Failed to promote user", { description: err.message }),
  });

  const filtered = (allUsers ?? []).filter((u: any) => {
    const matchSearch = !search || (u.name ?? "").toLowerCase().includes(search.toLowerCase()) || (u.email ?? "").toLowerCase().includes(search.toLowerCase());
    const matchRole = roleFilter === "all" || u.role === roleFilter;
    return matchSearch && matchRole;
  });

  return (
    <Card className="border-border/60">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" />
            All Users
            <Badge variant="secondary" className="ml-1">{allUsers?.length ?? 0}</Badge>
          </CardTitle>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isLoading}>
            <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`} />
          </Button>
        </div>
        <div className="flex gap-2 mt-2">
          <Input
            placeholder="Search by name or email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 text-sm max-w-xs"
          />
          <Select value={roleFilter} onValueChange={setRoleFilter}>
            <SelectTrigger className="h-8 text-sm w-40">
              <SelectValue placeholder="All roles" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All roles</SelectItem>
              <SelectItem value="super_admin">Super Admin</SelectItem>
              <SelectItem value="admin">Admin</SelectItem>
              <SelectItem value="cfo">CFO</SelectItem>
              <SelectItem value="operations">Operations</SelectItem>
              <SelectItem value="compliance">Compliance</SelectItem>
              <SelectItem value="user">User</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Org ID</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right pr-4">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 6 }).map((_, j) => (
                      <TableCell key={j}>
                        <div className="h-4 bg-muted animate-pulse rounded w-20" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-8 text-muted-foreground text-sm">
                    No users found
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((u: any) => (
                  <TableRow key={u.id}>
                    <TableCell className="pl-4 font-medium">{u.name ?? "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{u.email ?? "—"}</TableCell>
                    <TableCell>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                        u.role === "super_admin" ? "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300" :
                        u.role === "admin" ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" :
                        "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
                      }`}>
                        {u.role}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{u.organizationId ?? "—"}</TableCell>
                    <TableCell>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${u.isActive ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300" : "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"}`}>
                        {u.isActive ? "Active" : "Inactive"}
                      </span>
                    </TableCell>
                    <TableCell className="text-right pr-4">
                      {u.role !== "super_admin" && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 text-xs text-violet-600 border-violet-200 hover:bg-violet-50 dark:text-violet-400 dark:border-violet-800 dark:hover:bg-violet-900/30"
                          onClick={() => {
                            if (confirm(`Promote ${u.name ?? u.email} to Super Admin? This grants full cross-tenant access.`)) {
                              promote.mutate({ userId: u.id });
                            }
                          }}
                          disabled={promote.isPending}
                        >
                          <Shield className="h-3 w-3 mr-1" />
                          Promote
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
type SuperAdminTab = "overview" | "orgs" | "users" | "analytics";

const TAB_ROUTES: { key: SuperAdminTab; label: string; icon: React.ElementType; path: string }[] = [
  { key: "overview", label: "Overview", icon: Globe, path: "/admin/super-admin" },
  { key: "orgs", label: "Organisations", icon: Building2, path: "/admin/super-admin/orgs" },
  { key: "users", label: "Users", icon: Users, path: "/admin/super-admin/users" },
  { key: "analytics", label: "Analytics", icon: BarChart3, path: "/admin/super-admin/analytics" },
];

function tabFromPath(path: string): SuperAdminTab {
  if (path.startsWith("/admin/super-admin/orgs")) return "orgs";
  if (path.startsWith("/admin/super-admin/users")) return "users";
  if (path.startsWith("/admin/super-admin/analytics")) return "analytics";
  return "overview";
}

export default function SuperAdminDashboard() {
  const { user } = useAuth();
  const [location, setLocation] = useLocation();
  const activeTab = tabFromPath(location);

  if (user?.role !== "super_admin") {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <AlertCircle className="h-12 w-12 text-destructive" />
        <h2 className="text-xl font-semibold">Access Restricted</h2>
        <p className="text-muted-foreground text-sm text-center max-w-sm">
          This area is reserved for Infinity AI staff with the <strong>super_admin</strong> role.
          Contact your system administrator if you believe this is an error.
        </p>
        <Button variant="outline" onClick={() => setLocation("/dashboard")}>
          Return to Dashboard
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Globe className="h-5 w-5 text-violet-500" />
            <h1 className="text-xl font-bold text-foreground">Platform Control Centre</h1>
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300">
              Infinity AI Staff Only
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            Cross-tenant visibility across all ReconcileAI deployed instances and organisations.
          </p>
        </div>
      </div>

      {/* Platform Stats */}
      <PlatformStatsCards />

      {/* Tab Navigation — synced to the URL so the sidebar and tabs stay in agreement */}
      <div className="flex gap-1 border-b border-border">
        {TAB_ROUTES.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setLocation(tab.path)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.key
                ? "border-violet-500 text-violet-600 dark:text-violet-400"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <tab.icon className="h-3.5 w-3.5" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === "overview" && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Segment Architecture Card */}
          <Card className="border-border/60">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Layers className="h-4 w-4 text-muted-foreground" />
                Portal Architecture
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {[
                {
                  segment: "financial_services",
                  title: "Financial Services Portal",
                  description: "Banks, MFBs, fintechs — CBN compliance, 8-channel reconciliation, SFTP/API ingestion.",
                  color: "border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/30",
                  badge: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
                },
                {
                  segment: "corporate_b2b",
                  title: "Corporate B2B Portal",
                  description: "FMCG distributors, corporate treasury — distributor registry, B2B payment reconciliation.",
                  color: "border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30",
                  badge: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
                },
                {
                  segment: "super_admin",
                  title: "Infinity AI Internal",
                  description: "Cross-tenant visibility, platform analytics, client onboarding, and staff tooling.",
                  color: "border-violet-200 bg-violet-50 dark:border-violet-800 dark:bg-violet-950/30",
                  badge: "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
                },
              ].map((item) => (
                <div key={item.segment} className={`rounded-lg border p-3 ${item.color}`}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold ${item.badge}`}>
                      {SEGMENT_LABELS[item.segment as Segment]}
                    </span>
                  </div>
                  <p className="text-sm font-medium text-foreground">{item.title}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{item.description}</p>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Quick Actions */}
          <Card className="border-border/60">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Shield className="h-4 w-4 text-muted-foreground" />
                Quick Actions
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Button
                variant="outline"
                className="w-full justify-start text-sm h-9"
                onClick={() => setLocation("/admin/super-admin/orgs")}
              >
                <Building2 className="h-4 w-4 mr-2 text-blue-500" />
                Manage Organisations
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start text-sm h-9"
                onClick={() => setLocation("/admin/super-admin/users")}
              >
                <Users className="h-4 w-4 mr-2 text-emerald-500" />
                Manage Users &amp; Roles
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start text-sm h-9"
                onClick={() => setLocation("/admin/super-admin/analytics")}
              >
                <BarChart3 className="h-4 w-4 mr-2 text-violet-500" />
                Platform Analytics
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start text-sm h-9"
                onClick={() => setLocation("/admin/users")}
              >
                <Shield className="h-4 w-4 mr-2 text-amber-500" />
                Org-Level Admin Panel
              </Button>
            </CardContent>
          </Card>
        </div>
      )}

      {activeTab === "orgs" && <OrganisationsTable />}
      {activeTab === "users" && <AllUsersTable />}
      {activeTab === "analytics" && <PlatformAnalytics />}
    </div>
  );
}

// ─── Audit Log Table ──────────────────────────────────────────────────────────
const EVENT_META: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  org_created: { label: "Org Created", icon: PlusCircle, color: "text-emerald-600 dark:text-emerald-400" },
  org_segment_updated: { label: "Segment Updated", icon: ArrowRightLeft, color: "text-blue-600 dark:text-blue-400" },
  user_role_updated: { label: "Role Updated", icon: UserCog, color: "text-amber-600 dark:text-amber-400" },
  user_promoted_super_admin: { label: "Promoted to Super Admin", icon: Crown, color: "text-violet-600 dark:text-violet-400" },
};

function AuditLogTable() {
  const [page, setPage] = useState(0);
  const [filterEvent, setFilterEvent] = useState<string>("all");
  const PAGE_SIZE = 20;

  const { data, isLoading, refetch } = trpc.superAdmin.auditLogs.useQuery({
    eventType: filterEvent === "all" ? undefined : filterEvent as any,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });

  const logs = data?.logs ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ClipboardList className="h-4 w-4 text-violet-500" />
          <span className="text-sm font-semibold">Platform Audit Log</span>
          <Badge variant="secondary" className="ml-1">{total}</Badge>
        </div>
        <div className="flex items-center gap-2">
          <Select value={filterEvent} onValueChange={(v) => { setFilterEvent(v); setPage(0); }}>
            <SelectTrigger className="h-8 w-52 text-xs">
              <SelectValue placeholder="Filter by event" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Events</SelectItem>
              <SelectItem value="org_created">Org Created</SelectItem>
              <SelectItem value="org_segment_updated">Segment Updated</SelectItem>
              <SelectItem value="user_role_updated">Role Updated</SelectItem>
              <SelectItem value="user_promoted_super_admin">Promoted to Super Admin</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" className="h-8 gap-1" onClick={() => refetch()}>
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border/60 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead className="text-xs">Event</TableHead>
              <TableHead className="text-xs">Target</TableHead>
              <TableHead className="text-xs">Actor</TableHead>
              <TableHead className="text-xs">Before</TableHead>
              <TableHead className="text-xs">After</TableHead>
              <TableHead className="text-xs">Timestamp</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground text-sm">
                  Loading audit log...
                </TableCell>
              </TableRow>
            ) : logs.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-12 text-muted-foreground text-sm">
                  <ClipboardList className="h-8 w-8 mx-auto mb-2 opacity-30" />
                  <p>No audit events recorded yet.</p>
                  <p className="text-xs mt-1">Events appear here when organisations are created or user roles are updated.</p>
                </TableCell>
              </TableRow>
            ) : (
              logs.map((log: any) => {
                const meta = EVENT_META[log.eventType] ?? { label: log.eventType, icon: ClipboardList, color: "text-muted-foreground" };
                const Icon = meta.icon;
                return (
                  <TableRow key={log.id} className="text-xs">
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <Icon className={`h-3.5 w-3.5 shrink-0 ${meta.color}`} />
                        <span className="font-medium">{meta.label}</span>
                      </div>
                      <span className="text-muted-foreground capitalize">{log.targetType}</span>
                    </TableCell>
                    <TableCell>
                      <span className="font-medium">{log.targetName ?? `ID ${log.targetId}`}</span>
                    </TableCell>
                    <TableCell>
                      <span className="text-muted-foreground">{log.actorName ?? `User ${log.actorId}`}</span>
                    </TableCell>
                    <TableCell>
                      {log.previousValue ? (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300 font-mono">
                          {log.previousValue}
                        </span>
                      ) : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell>
                      {log.newValue ? (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 font-mono">
                          {log.newValue.length > 40 ? log.newValue.slice(0, 40) + "…" : log.newValue}
                        </span>
                      ) : <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-muted-foreground whitespace-nowrap">
                      {new Date(log.createdAt).toLocaleString()}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total} events</span>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" className="h-7 w-7 p-0" disabled={page === 0} onClick={() => setPage(p => p - 1)}>
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <span className="px-2">{page + 1} / {totalPages}</span>
            <Button variant="outline" size="sm" className="h-7 w-7 p-0" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Platform Analytics ────────────────────────────────────────────────────────
const ROLE_LABELS: Record<string, string> = {
  super_admin: "Super Admin",
  admin: "Admin",
  cfo: "CFO",
  operations: "Operations",
  compliance: "Compliance",
  user: "User",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const MODULE_LABELS: Record<string, string> = {
  settlement: "Settlement",
  account_level: "Account-Level",
  transaction_integrity: "Transaction Integrity (legacy)",
};

const SEGMENT_BAR_COLORS: Record<string, string> = {
  financial_services: "#3b82f6",
  corporate_b2b: "#10b981",
  super_admin: "#8b5cf6",
};

const STATUS_BAR_COLORS: Record<string, string> = {
  pending: "#9ca3af",
  running: "#3b82f6",
  completed: "#10b981",
  failed: "#ef4444",
  cancelled: "#6b7280",
};

const PALETTE = ["#8b5cf6", "#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#06b6d4"];

function fmtMonth(m: string): string {
  const [y, mo] = m.split("-");
  if (!y || !mo) return m;
  const d = new Date(Number(y), Number(mo) - 1, 1);
  return d.toLocaleString("en-US", { month: "short", year: "2-digit" });
}

function DistributionCard({
  title,
  icon: Icon,
  rows,
  labels,
  colorFor,
}: {
  title: string;
  icon: React.ElementType;
  rows: { key: string; value: number }[];
  labels: Record<string, string>;
  colorFor: (key: string, index: number) => string;
}) {
  const sorted = [...rows].sort((a, b) => b.value - a.value);
  const total = sorted.reduce((s, r) => s + r.value, 0);
  return (
    <Card className="border-border/60">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {sorted.length === 0 ? (
          <p className="text-xs text-muted-foreground py-2">No data yet.</p>
        ) : (
          sorted.map((r, i) => {
            const pct = total > 0 ? (r.value / total) * 100 : 0;
            return (
              <div key={r.key}>
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="font-medium text-foreground">{labels[r.key] ?? r.key}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {r.value.toLocaleString()} · {pct.toFixed(0)}%
                  </span>
                </div>
                <div className="h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{ width: `${pct}%`, backgroundColor: colorFor(r.key, i) }}
                  />
                </div>
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}

function TrendCard({
  title,
  icon: Icon,
  data,
  color,
  dataLabel,
}: {
  title: string;
  icon: React.ElementType;
  data: { month: string; value: number }[];
  color: string;
  dataLabel: string;
}) {
  const chartData = data.slice(-12).map((d) => ({ name: fmtMonth(d.month), value: d.value }));
  const gradientId = `grad-${dataLabel.replace(/\s+/g, "-")}`;
  return (
    <Card className="border-border/60">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {chartData.length === 0 ? (
          <p className="text-xs text-muted-foreground py-8 text-center">No data yet.</p>
        ) : (
          <div className="h-[200px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                <defs>
                  <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={color} stopOpacity={0.35} />
                    <stop offset="95%" stopColor={color} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" allowDecimals={false} tickLine={false} axisLine={false} width={32} />
                <Tooltip
                  contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid hsl(var(--border))", background: "hsl(var(--popover))" }}
                  formatter={(v: number) => [v.toLocaleString(), dataLabel]}
                />
                <Area type="monotone" dataKey="value" stroke={color} strokeWidth={2} fill={`url(#${gradientId})`} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PlatformAnalytics() {
  const { data, isLoading, refetch, isFetching } = trpc.superAdmin.platformAnalytics.useQuery();

  const headline = data
    ? [
        { icon: Building2, label: "Active Orgs", value: data.totals.activeOrgs.toLocaleString(), sub: `of ${data.totals.orgs.toLocaleString()} total`, color: "text-blue-500" },
        { icon: Users, label: "Active Users", value: data.totals.activeUsers.toLocaleString(), sub: `of ${data.totals.users.toLocaleString()} total`, color: "text-emerald-500" },
        { icon: CheckCircle2, label: "Completed Jobs", value: data.totals.completedJobs.toLocaleString(), sub: `of ${data.totals.jobs.toLocaleString()} runs`, color: "text-violet-500" },
        { icon: Percent, label: "Avg Match Rate", value: `${data.volume.avgMatchRate.toFixed(1)}%`, sub: "completed jobs", color: "text-amber-500" },
        { icon: Activity, label: "Txns Matched", value: data.volume.matched.toLocaleString(), sub: `${data.volume.unmatched.toLocaleString()} unmatched`, color: "text-cyan-500" },
        { icon: AlertTriangle, label: "Open Exceptions", value: data.totals.openExceptions.toLocaleString(), sub: `of ${data.totals.exceptions.toLocaleString()} total`, color: "text-rose-500" },
      ]
    : [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-violet-500" />
          <span className="text-sm font-semibold">Platform Analytics</span>
          <span className="text-xs text-muted-foreground">Cross-tenant metrics across every deployed instance</span>
        </div>
        <Button variant="outline" size="sm" className="h-8 gap-1" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Headline metric cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {isLoading
          ? Array.from({ length: 6 }).map((_, i) => (
              <Card key={i} className="border-border/60">
                <CardContent className="pt-4 pb-3 px-4">
                  <div className="h-4 w-20 bg-muted animate-pulse rounded mb-2" />
                  <div className="h-7 w-14 bg-muted animate-pulse rounded" />
                </CardContent>
              </Card>
            ))
          : headline.map((stat) => (
              <Card key={stat.label} className="border-border/60">
                <CardContent className="pt-4 pb-3 px-4">
                  <div className="flex items-center gap-2 mb-1">
                    <stat.icon className={`h-4 w-4 ${stat.color}`} />
                    <span className="text-xs text-muted-foreground truncate">{stat.label}</span>
                  </div>
                  <p className="text-2xl font-bold text-foreground tabular-nums">{stat.value}</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">{stat.sub}</p>
                </CardContent>
              </Card>
            ))}
      </div>

      {data && (
        <>
          {/* Growth trends */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <TrendCard title="Organisation Growth" icon={TrendingUp} data={data.orgGrowth} color="#3b82f6" dataLabel="New orgs" />
            <TrendCard title="Reconciliation Activity" icon={Activity} data={data.jobTrend} color="#8b5cf6" dataLabel="Jobs" />
          </div>

          {/* Categorical breakdowns */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <DistributionCard
              title="Organisations by Segment"
              icon={Layers}
              rows={data.segmentBreakdown}
              labels={SEGMENT_LABELS}
              colorFor={(key) => SEGMENT_BAR_COLORS[key] ?? "#8b5cf6"}
            />
            <DistributionCard
              title="Reconciliation Modules"
              icon={Network}
              rows={data.moduleBreakdown}
              labels={MODULE_LABELS}
              colorFor={(_key, i) => PALETTE[i % PALETTE.length]}
            />
            <DistributionCard
              title="Job Outcomes"
              icon={CheckCircle2}
              rows={data.jobStatusBreakdown}
              labels={STATUS_LABELS}
              colorFor={(key) => STATUS_BAR_COLORS[key] ?? "#8b5cf6"}
            />
            <DistributionCard
              title="Users by Role"
              icon={UserCog}
              rows={data.roleBreakdown}
              labels={ROLE_LABELS}
              colorFor={(_key, i) => PALETTE[i % PALETTE.length]}
            />
          </div>

          {/* Top organisations by activity */}
          <Card className="border-border/60">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <Building2 className="h-4 w-4 text-muted-foreground" />
                Top Organisations by Activity
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">Organisation</TableHead>
                      <TableHead>Segment</TableHead>
                      <TableHead className="text-right">Jobs</TableHead>
                      <TableHead className="text-right">Matched</TableHead>
                      <TableHead className="text-right pr-4">Exceptions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.topOrgs.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5} className="text-center py-8 text-muted-foreground text-sm">
                          No reconciliation activity recorded yet.
                        </TableCell>
                      </TableRow>
                    ) : (
                      data.topOrgs.map((org) => (
                        <TableRow key={org.organizationId ?? "unassigned"}>
                          <TableCell className="pl-4 font-medium">{org.name}</TableCell>
                          <TableCell>{org.segment ? <SegmentBadge segment={org.segment} /> : <span className="text-xs text-muted-foreground">—</span>}</TableCell>
                          <TableCell className="text-right tabular-nums">{org.jobs.toLocaleString()}</TableCell>
                          <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">{org.matched.toLocaleString()}</TableCell>
                          <TableCell className="text-right pr-4 tabular-nums text-rose-600 dark:text-rose-400">{org.exceptions.toLocaleString()}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          {/* Recent platform activity */}
          <AuditLogTable />
        </>
      )}
    </div>
  );
}
