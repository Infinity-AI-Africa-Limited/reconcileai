import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { toast } from "sonner";
import DashboardLayout from "@/components/DashboardLayout";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  MoreHorizontal, Search, Users, Shield, UserCheck, UserX,
  Trash2, Building2, RefreshCw, ChevronUp, ChevronDown,
  ChevronsUpDown, UserPlus, CheckSquare,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────
type PortalRole = "admin" | "cfo" | "operations" | "compliance" | "user";
type SortField = "name" | "email" | "role" | "isActive" | "createdAt" | "lastSignedIn";
type SortDir = "asc" | "desc";

const ROLE_META: Record<PortalRole, { label: string; color: string; description: string }> = {
  admin:      { label: "Admin",             color: "bg-red-100 text-red-800 border-red-200",       description: "Full portal access, user management" },
  cfo:        { label: "CFO",               color: "bg-purple-100 text-purple-800 border-purple-200", description: "CFO dashboard, financial reports" },
  operations: { label: "Operations",        color: "bg-blue-100 text-blue-800 border-blue-200",    description: "Reconciliation, schedules, channels" },
  compliance: { label: "Compliance/Audit",  color: "bg-amber-100 text-amber-800 border-amber-200", description: "CBN reports, audit trail, compliance" },
  user:       { label: "Standard User",     color: "bg-gray-100 text-gray-700 border-gray-200",    description: "Basic portal access" },
};

function RoleBadge({ role }: { role: PortalRole }) {
  const meta = ROLE_META[role] ?? ROLE_META.user;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${meta.color}`}>
      {meta.label}
    </span>
  );
}

function SortIcon({ field, current, dir }: { field: SortField; current: SortField; dir: SortDir }) {
  if (field !== current) return <ChevronsUpDown className="h-3 w-3 ml-1 text-muted-foreground" />;
  return dir === "asc"
    ? <ChevronUp className="h-3 w-3 ml-1 text-primary" />
    : <ChevronDown className="h-3 w-3 ml-1 text-primary" />;
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function AdminUsers() {
  const { user: currentUser } = useAuth();
  const utils = trpc.useUtils();

  // ── Data ──────────────────────────────────────────────────────────────
  const { data: allUsers = [], isLoading, refetch } = trpc.admin.users.useQuery();
  const { data: orgList = [] } = trpc.admin.organizations.useQuery();

  // ── Local state ───────────────────────────────────────────────────────
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | PortalRole>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");
  const [sortField, setSortField] = useState<SortField>("createdAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkAction, setBulkAction] = useState<"" | "activate" | "deactivate" | "role" | "org">("");
  const [bulkRole, setBulkRole] = useState<PortalRole>("user");
  const [bulkOrgId, setBulkOrgId] = useState<string>("");

  // Single-user dialogs
  const [confirmDialog, setConfirmDialog] = useState<{
    type: "deactivate" | "activate" | "delete" | "role";
    userId: number;
    userName: string;
    newRole?: PortalRole;
  } | null>(null);
  const [orgDialog, setOrgDialog] = useState<{
    userId: number; userName: string; currentOrgId: number | null;
  } | null>(null);
  const [selectedOrgId, setSelectedOrgId] = useState<string>("");

  // Add User dialog
  const [addUserOpen, setAddUserOpen] = useState(false);
  const [newUser, setNewUser] = useState({ name: "", email: "", role: "user" as PortalRole, organizationId: "" });

  // ── Mutations ─────────────────────────────────────────────────────────
  const updateRole = trpc.admin.updateRole.useMutation({
    onSuccess: () => { toast.success("Role updated."); utils.admin.users.invalidate(); setConfirmDialog(null); },
    onError: (e) => toast.error(e.message),
  });
  const toggleActive = trpc.admin.toggleActive.useMutation({
    onSuccess: (_, vars) => { toast.success(vars.isActive ? "User activated." : "User deactivated."); utils.admin.users.invalidate(); setConfirmDialog(null); },
    onError: (e) => toast.error(e.message),
  });
  const deleteUser = trpc.admin.deleteUser.useMutation({
    onSuccess: () => { toast.success("User removed."); utils.admin.users.invalidate(); setConfirmDialog(null); },
    onError: (e) => toast.error(e.message),
  });
  const updateOrg = trpc.admin.updateOrganization.useMutation({
    onSuccess: () => { toast.success("Organisation updated."); utils.admin.users.invalidate(); setOrgDialog(null); },
    onError: (e) => toast.error(e.message),
  });
  const addUser = trpc.admin.addUser.useMutation({
    onSuccess: () => { toast.success("User added successfully."); utils.admin.users.invalidate(); setAddUserOpen(false); setNewUser({ name: "", email: "", role: "user", organizationId: "" }); },
    onError: (e) => toast.error(e.message),
  });
  const bulkUpdateRole = trpc.admin.bulkUpdateRole.useMutation({
    onSuccess: (r) => { toast.success(`Role updated for ${r.count} user(s).`); utils.admin.users.invalidate(); setSelectedIds(new Set()); setBulkAction(""); },
    onError: (e) => toast.error(e.message),
  });
  const bulkToggleActive = trpc.admin.bulkToggleActive.useMutation({
    onSuccess: (r) => { toast.success(`${r.count} user(s) updated.`); utils.admin.users.invalidate(); setSelectedIds(new Set()); setBulkAction(""); },
    onError: (e) => toast.error(e.message),
  });
  const bulkUpdateOrg = trpc.admin.bulkUpdateOrganization.useMutation({
    onSuccess: (r) => { toast.success(`Organisation updated for ${r.count} user(s).`); utils.admin.users.invalidate(); setSelectedIds(new Set()); setBulkAction(""); },
    onError: (e) => toast.error(e.message),
  });

  // ── Filtering & sorting ───────────────────────────────────────────────
  const filtered = useMemo(() => {
    let list = [...allUsers];
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(u =>
        (u.name ?? "").toLowerCase().includes(q) ||
        (u.email ?? "").toLowerCase().includes(q)
      );
    }
    if (roleFilter !== "all") list = list.filter(u => u.role === roleFilter);
    if (statusFilter === "active") list = list.filter(u => u.isActive);
    if (statusFilter === "inactive") list = list.filter(u => !u.isActive);
    list.sort((a, b) => {
      let av: string | number | boolean | Date | null = a[sortField] ?? "";
      let bv: string | number | boolean | Date | null = b[sortField] ?? "";
      if (av instanceof Date) av = av.getTime();
      if (bv instanceof Date) bv = bv.getTime();
      if (typeof av === "boolean") av = av ? 1 : 0;
      if (typeof bv === "boolean") bv = bv ? 1 : 0;
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDir === "asc" ? cmp : -cmp;
    });
    return list;
  }, [allUsers, search, roleFilter, statusFilter, sortField, sortDir]);

  const toggleSort = (f: SortField) => {
    if (sortField === f) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortField(f); setSortDir("asc"); }
  };

  // ── Selection helpers ─────────────────────────────────────────────────
  const allSelected = filtered.length > 0 && filtered.every(u => selectedIds.has(u.id));
  const someSelected = filtered.some(u => selectedIds.has(u.id));
  const toggleAll = () => {
    if (allSelected) setSelectedIds(new Set());
    else setSelectedIds(new Set(filtered.map(u => u.id)));
  };
  const toggleOne = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  // ── Stats ─────────────────────────────────────────────────────────────
  const stats = useMemo(() => ({
    total: allUsers.length,
    active: allUsers.filter(u => u.isActive).length,
    admins: allUsers.filter(u => u.role === "admin").length,
    cfos: allUsers.filter(u => u.role === "cfo").length,
    ops: allUsers.filter(u => u.role === "operations").length,
    compliance: allUsers.filter(u => u.role === "compliance").length,
  }), [allUsers]);

  const orgMap = useMemo(() => Object.fromEntries(orgList.map(o => [o.id, o.name])), [orgList]);

  const handleBulkApply = () => {
    const ids = Array.from(selectedIds);
    if (!ids.length) return;
    if (bulkAction === "activate") bulkToggleActive.mutate({ userIds: ids, isActive: true });
    else if (bulkAction === "deactivate") bulkToggleActive.mutate({ userIds: ids, isActive: false });
    else if (bulkAction === "role") bulkUpdateRole.mutate({ userIds: ids, role: bulkRole });
    else if (bulkAction === "org") bulkUpdateOrg.mutate({ userIds: ids, organizationId: bulkOrgId ? parseInt(bulkOrgId) : null });
  };

  const handleConfirm = () => {
    if (!confirmDialog) return;
    const { type, userId, newRole } = confirmDialog;
    if (type === "activate") toggleActive.mutate({ userId, isActive: true });
    else if (type === "deactivate") toggleActive.mutate({ userId, isActive: false });
    else if (type === "delete") deleteUser.mutate({ userId });
    else if (type === "role" && newRole) updateRole.mutate({ userId, role: newRole });
  };

  const isMutating =
    updateRole.isPending || toggleActive.isPending || deleteUser.isPending ||
    updateOrg.isPending || addUser.isPending ||
    bulkUpdateRole.isPending || bulkToggleActive.isPending || bulkUpdateOrg.isPending;

  return (
    <DashboardLayout>
      <div className="p-6 space-y-6">
        {/* ── Header ── */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">User Management</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Manage portal users, roles, and access permissions
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isLoading}>
              <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            {/* Add User — admin only */}
            {currentUser?.role === "admin" && (
              <Button size="sm" onClick={() => setAddUserOpen(true)}>
                <UserPlus className="h-4 w-4 mr-2" />
                Add User
              </Button>
            )}
          </div>
        </div>

        {/* ── Stats ── */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {[
            { label: "Total Users",  value: stats.total,      icon: Users,      color: "text-foreground" },
            { label: "Active",       value: stats.active,     icon: UserCheck,  color: "text-green-600" },
            { label: "Admins",       value: stats.admins,     icon: Shield,     color: "text-red-600" },
            { label: "CFO",          value: stats.cfos,       icon: Users,      color: "text-purple-600" },
            { label: "Operations",   value: stats.ops,        icon: Users,      color: "text-blue-600" },
            { label: "Compliance",   value: stats.compliance, icon: Users,      color: "text-amber-600" },
          ].map(s => (
            <div key={s.label} className="rounded-lg border bg-card p-3">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                <s.icon className="h-3.5 w-3.5" />
                {s.label}
              </div>
              <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
            </div>
          ))}
        </div>

        {/* ── Filters ── */}
        <div className="flex flex-wrap gap-2 items-center">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by name or email…"
              className="pl-8"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <Select value={roleFilter} onValueChange={v => setRoleFilter(v as typeof roleFilter)}>
            <SelectTrigger className="w-44">
              <SelectValue placeholder="All roles" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All roles</SelectItem>
              {(Object.keys(ROLE_META) as PortalRole[]).map(r => (
                <SelectItem key={r} value={r}>{ROLE_META[r].label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={v => setStatusFilter(v as typeof statusFilter)}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-sm text-muted-foreground ml-1">
            {filtered.length} user{filtered.length !== 1 ? "s" : ""}
          </span>
        </div>

        {/* ── Bulk Actions Bar ── */}
        {selectedIds.size > 0 && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 px-4 py-2.5">
            <CheckSquare className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium text-primary">{selectedIds.size} selected</span>
            <div className="flex gap-2 flex-wrap ml-auto">
              <Select value={bulkAction} onValueChange={v => setBulkAction(v as typeof bulkAction)}>
                <SelectTrigger className="w-44 h-8 text-sm">
                  <SelectValue placeholder="Bulk action…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="activate">Activate</SelectItem>
                  <SelectItem value="deactivate">Deactivate</SelectItem>
                  <SelectItem value="role">Change role</SelectItem>
                  <SelectItem value="org">Assign organisation</SelectItem>
                </SelectContent>
              </Select>
              {bulkAction === "role" && (
                <Select value={bulkRole} onValueChange={v => setBulkRole(v as PortalRole)}>
                  <SelectTrigger className="w-40 h-8 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(ROLE_META) as PortalRole[]).map(r => (
                      <SelectItem key={r} value={r}>{ROLE_META[r].label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {bulkAction === "org" && (
                <Select value={bulkOrgId} onValueChange={setBulkOrgId}>
                  <SelectTrigger className="w-44 h-8 text-sm">
                    <SelectValue placeholder="Select org…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">No organisation</SelectItem>
                    {orgList.map(o => <SelectItem key={o.id} value={String(o.id)}>{o.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}
              <Button size="sm" className="h-8" onClick={handleBulkApply} disabled={!bulkAction || isMutating}>
                Apply
              </Button>
              <Button size="sm" variant="ghost" className="h-8" onClick={() => { setSelectedIds(new Set()); setBulkAction(""); }}>
                Clear
              </Button>
            </div>
          </div>
        )}

        {/* ── Table ── */}
        <div className="rounded-lg border bg-card overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40">
                <TableHead className="w-10">
                  <Checkbox
                    checked={allSelected}
                    onCheckedChange={toggleAll}
                    aria-label="Select all"
                    className={someSelected && !allSelected ? "opacity-50" : ""}
                  />
                </TableHead>
                {(["name", "email", "role", "isActive", "createdAt", "lastSignedIn"] as SortField[]).map(f => (
                  <TableHead
                    key={f}
                    className="cursor-pointer select-none"
                    onClick={() => toggleSort(f)}
                  >
                    <span className="inline-flex items-center">
                      {{ name: "Name", email: "Email", role: "Role", isActive: "Status", createdAt: "Joined", lastSignedIn: "Last Sign-in" }[f]}
                      <SortIcon field={f} current={sortField} dir={sortDir} />
                    </span>
                  </TableHead>
                ))}
                <TableHead>Organisation</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-12 text-muted-foreground">
                    Loading users…
                  </TableCell>
                </TableRow>
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-12 text-muted-foreground">
                    No users match the current filters.
                  </TableCell>
                </TableRow>
              ) : filtered.map(u => (
                <TableRow key={u.id} className={selectedIds.has(u.id) ? "bg-primary/5" : ""}>
                  <TableCell>
                    <Checkbox
                      checked={selectedIds.has(u.id)}
                      onCheckedChange={() => toggleOne(u.id)}
                      disabled={u.id === currentUser?.id}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="font-medium text-sm">{u.name ?? "—"}</div>
                    {u.id === currentUser?.id && (
                      <span className="text-xs text-muted-foreground">(you)</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{u.email ?? "—"}</TableCell>
                  <TableCell><RoleBadge role={u.role as PortalRole} /></TableCell>
                  <TableCell>
                    <Badge variant={u.isActive ? "default" : "secondary"} className={u.isActive ? "bg-green-100 text-green-800 border-green-200 hover:bg-green-100" : ""}>
                      {u.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {u.createdAt ? new Date(u.createdAt).toLocaleDateString() : "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {u.lastSignedIn ? new Date(u.lastSignedIn).toLocaleDateString() : "Never"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {u.organizationId ? (orgMap[u.organizationId] ?? `Org #${u.organizationId}`) : "—"}
                  </TableCell>
                  <TableCell>
                    {/* Actions — only admin can add/remove/change roles */}
                    {currentUser?.role === "admin" && u.id !== currentUser.id && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-7 w-7">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-52">
                          <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                            Change Role
                          </div>
                          {(Object.keys(ROLE_META) as PortalRole[]).filter(r => r !== u.role).map(r => (
                            <DropdownMenuItem
                              key={r}
                              onClick={() => setConfirmDialog({ type: "role", userId: u.id, userName: u.name ?? u.email ?? "User", newRole: r })}
                            >
                              <Shield className="h-3.5 w-3.5 mr-2" />
                              Set as {ROLE_META[r].label}
                            </DropdownMenuItem>
                          ))}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => { setOrgDialog({ userId: u.id, userName: u.name ?? u.email ?? "User", currentOrgId: u.organizationId ?? null }); setSelectedOrgId(u.organizationId ? String(u.organizationId) : ""); }}>
                            <Building2 className="h-3.5 w-3.5 mr-2" />
                            Assign Organisation
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          {u.isActive ? (
                            <DropdownMenuItem onClick={() => setConfirmDialog({ type: "deactivate", userId: u.id, userName: u.name ?? u.email ?? "User" })}>
                              <UserX className="h-3.5 w-3.5 mr-2 text-amber-600" />
                              <span className="text-amber-600">Deactivate</span>
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem onClick={() => setConfirmDialog({ type: "activate", userId: u.id, userName: u.name ?? u.email ?? "User" })}>
                              <UserCheck className="h-3.5 w-3.5 mr-2 text-green-600" />
                              <span className="text-green-600">Activate</span>
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            onClick={() => setConfirmDialog({ type: "delete", userId: u.id, userName: u.name ?? u.email ?? "User" })}
                            className="text-destructive focus:text-destructive"
                          >
                            <Trash2 className="h-3.5 w-3.5 mr-2" />
                            Remove User
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* ── Add User Dialog (admin-only) ── */}
      <Dialog open={addUserOpen} onOpenChange={setAddUserOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add New User</DialogTitle>
            <DialogDescription>
              Create a portal user account. They will be able to log in using the email address provided.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Full Name</Label>
              <Input
                placeholder="e.g. Amaka Okonkwo"
                value={newUser.name}
                onChange={e => setNewUser(p => ({ ...p, name: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Email Address</Label>
              <Input
                type="email"
                placeholder="e.g. amaka@bank.com"
                value={newUser.email}
                onChange={e => setNewUser(p => ({ ...p, email: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Portal Role</Label>
              <Select value={newUser.role} onValueChange={v => setNewUser(p => ({ ...p, role: v as PortalRole }))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(ROLE_META) as PortalRole[]).map(r => (
                    <SelectItem key={r} value={r}>
                      <div>
                        <div className="font-medium">{ROLE_META[r].label}</div>
                        <div className="text-xs text-muted-foreground">{ROLE_META[r].description}</div>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Organisation <span className="text-muted-foreground">(optional)</span></Label>
              <Select value={newUser.organizationId} onValueChange={v => setNewUser(p => ({ ...p, organizationId: v }))}>
                <SelectTrigger>
                  <SelectValue placeholder="No organisation" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">No organisation</SelectItem>
                  {orgList.map(o => <SelectItem key={o.id} value={String(o.id)}>{o.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddUserOpen(false)}>Cancel</Button>
            <Button
              onClick={() => addUser.mutate({
                name: newUser.name,
                email: newUser.email,
                role: newUser.role,
                organizationId: newUser.organizationId ? parseInt(newUser.organizationId) : null,
              })}
              disabled={!newUser.name.trim() || !newUser.email.trim() || addUser.isPending}
            >
              {addUser.isPending ? "Adding…" : "Add User"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Confirm Dialog ── */}
      <Dialog open={!!confirmDialog} onOpenChange={() => setConfirmDialog(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {confirmDialog?.type === "delete" ? "Remove User" :
               confirmDialog?.type === "deactivate" ? "Deactivate User" :
               confirmDialog?.type === "activate" ? "Activate User" :
               "Change Role"}
            </DialogTitle>
            <DialogDescription>
              {confirmDialog?.type === "delete"
                ? `This will permanently remove ${confirmDialog.userName} from the portal. This action cannot be undone.`
                : confirmDialog?.type === "deactivate"
                ? `${confirmDialog.userName} will lose access to the portal immediately.`
                : confirmDialog?.type === "activate"
                ? `${confirmDialog.userName} will regain access to the portal.`
                : `Change ${confirmDialog?.userName}'s role to ${ROLE_META[confirmDialog?.newRole ?? "user"]?.label}.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDialog(null)}>Cancel</Button>
            <Button
              variant={confirmDialog?.type === "delete" ? "destructive" : "default"}
              onClick={handleConfirm}
              disabled={isMutating}
            >
              {isMutating ? "Processing…" : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Org Assignment Dialog ── */}
      <Dialog open={!!orgDialog} onOpenChange={() => setOrgDialog(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Assign Organisation</DialogTitle>
            <DialogDescription>
              Assign {orgDialog?.userName} to an organisation.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Select value={selectedOrgId} onValueChange={setSelectedOrgId}>
              <SelectTrigger>
                <SelectValue placeholder="No organisation" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">No organisation</SelectItem>
                {orgList.map(o => <SelectItem key={o.id} value={String(o.id)}>{o.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOrgDialog(null)}>Cancel</Button>
            <Button
              onClick={() => orgDialog && updateOrg.mutate({ userId: orgDialog.userId, organizationId: selectedOrgId ? parseInt(selectedOrgId) : null })}
              disabled={isMutating}
            >
              {isMutating ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}
