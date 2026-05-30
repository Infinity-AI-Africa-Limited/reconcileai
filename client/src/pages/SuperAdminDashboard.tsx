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
} from "lucide-react";

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

// ─── Create Organisation Dialog ───────────────────────────────────────────────
function CreateOrgDialog({
  open,
  onClose,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [segment, setSegment] = useState<Segment>("financial_services");
  const [country, setCountry] = useState("NGA");
  const [currency, setCurrency] = useState("NGN");

  const createOrg = trpc.superAdmin.createOrganization.useMutation({
    onSuccess: () => {
      toast.success("Organisation created successfully");
      setName(""); setCode(""); setSegment("financial_services");
      onSuccess();
      onClose();
    },
    onError: (err) => toast.error("Failed to create organisation", { description: err.message }),
  });

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="h-4 w-4" />
            New Organisation
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Organisation Name *</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. LapoMFB" />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Code (short identifier) *</label>
            <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="e.g. LAPOMFB" maxLength={50} />
          </div>
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
          <Button variant="outline" onClick={onClose} disabled={createOrg.isPending}>Cancel</Button>
          <Button
            onClick={() => createOrg.mutate({ name, code, segment, country, baseCurrency: currency })}
            disabled={createOrg.isPending || !name.trim() || !code.trim()}
          >
            {createOrg.isPending ? "Creating…" : "Create Organisation"}
          </Button>
        </DialogFooter>
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

  const updateSegment = trpc.superAdmin.updateOrganizationSegment.useMutation({
    onSuccess: () => {
      toast.success("Segment updated");
      utils.superAdmin.allOrganizations.invalidate();
      utils.superAdmin.platformStats.invalidate();
    },
    onError: (err) => toast.error("Failed to update segment", { description: err.message }),
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
export default function SuperAdminDashboard() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const [activeTab, setActiveTab] = useState<"overview" | "orgs" | "users">("overview");

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

      {/* Tab Navigation */}
      <div className="flex gap-1 border-b border-border">
        {[
          { key: "overview", label: "Overview", icon: Globe },
          { key: "orgs", label: "Organisations", icon: Building2 },
          { key: "users", label: "Users", icon: Users },
        ].map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key as typeof activeTab)}
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
                onClick={() => setActiveTab("orgs")}
              >
                <Building2 className="h-4 w-4 mr-2 text-blue-500" />
                Manage Organisations
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start text-sm h-9"
                onClick={() => setActiveTab("users")}
              >
                <Users className="h-4 w-4 mr-2 text-emerald-500" />
                Manage Users &amp; Roles
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start text-sm h-9"
                onClick={() => setLocation("/admin/users")}
              >
                <Shield className="h-4 w-4 mr-2 text-amber-500" />
                Org-Level Admin Panel
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start text-sm h-9"
                onClick={() => setLocation("/audit")}
              >
                <BarChart3 className="h-4 w-4 mr-2 text-violet-500" />
                View Audit Trail
              </Button>
            </CardContent>
          </Card>
        </div>
      )}

      {activeTab === "orgs" && <OrganisationsTable />}
      {activeTab === "users" && <AllUsersTable />}
    </div>
  );
}
