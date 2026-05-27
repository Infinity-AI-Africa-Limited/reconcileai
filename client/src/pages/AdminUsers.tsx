import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { toast } from "sonner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  MoreHorizontal,
  Search,
  Users,
  Shield,
  UserCheck,
  UserX,
  Trash2,
  Building2,
  RefreshCw,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
} from "lucide-react";

type SortField = "name" | "email" | "role" | "isActive" | "createdAt" | "lastSignedIn";
type SortDir = "asc" | "desc";

export default function AdminUsers() {
  const { user: currentUser } = useAuth();
  const utils = trpc.useUtils();

  // ── Data ──────────────────────────────────────────────────────────────
  const { data: allUsers = [], isLoading, refetch } = trpc.admin.users.useQuery();
  const { data: orgList = [] } = trpc.admin.organizations.useQuery();

  // ── Local state ───────────────────────────────────────────────────────
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | "admin" | "user">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");
  const [sortField, setSortField] = useState<SortField>("createdAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Confirm dialogs
  const [confirmDialog, setConfirmDialog] = useState<{
    type: "deactivate" | "activate" | "delete" | "role" | "org";
    userId: number;
    userName: string;
    newRole?: "user" | "admin";
    newOrgId?: number | null;
  } | null>(null);

  // Org assignment dialog
  const [orgDialog, setOrgDialog] = useState<{ userId: number; userName: string; currentOrgId: number | null } | null>(null);
  const [selectedOrgId, setSelectedOrgId] = useState<string>("");

  // ── Mutations ─────────────────────────────────────────────────────────
  const updateRole = trpc.admin.updateRole.useMutation({
    onSuccess: () => {
      toast.success("Role updated — user role has been changed.");
      utils.admin.users.invalidate();
      setConfirmDialog(null);
    },
    onError: (e) => toast.error(e.message),
  });

  const toggleActive = trpc.admin.toggleActive.useMutation({
    onSuccess: (_, vars) => {
      toast.success(vars.isActive ? "User activated" : "User deactivated");
      utils.admin.users.invalidate();
      setConfirmDialog(null);
    },
    onError: (e) => toast.error(e.message),
  });

  const deleteUser = trpc.admin.deleteUser.useMutation({
    onSuccess: () => {
      toast.success("User removed successfully.");
      utils.admin.users.invalidate();
      setConfirmDialog(null);
    },
    onError: (e) => toast.error(e.message),
  });

  const updateOrg = trpc.admin.updateOrganization.useMutation({
    onSuccess: () => {
      toast.success("Organisation updated.");
      utils.admin.users.invalidate();
      setOrgDialog(null);
    },
    onError: (e) => toast.error(e.message),
  });

  // ── Filtering & sorting ───────────────────────────────────────────────
  const filtered = useMemo(() => {
    let list = [...allUsers];

    // Exclude soft-deleted
    list = list.filter((u) => u.name !== "[Deleted User]");

    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (u) =>
          (u.name ?? "").toLowerCase().includes(q) ||
          (u.email ?? "").toLowerCase().includes(q)
      );
    }
    if (roleFilter !== "all") list = list.filter((u) => u.role === roleFilter);
    if (statusFilter === "active") list = list.filter((u) => u.isActive);
    if (statusFilter === "inactive") list = list.filter((u) => !u.isActive);

    list.sort((a, b) => {
      let av: string | number | boolean = "";
      let bv: string | number | boolean = "";
      if (sortField === "name") { av = a.name ?? ""; bv = b.name ?? ""; }
      else if (sortField === "email") { av = a.email ?? ""; bv = b.email ?? ""; }
      else if (sortField === "role") { av = a.role; bv = b.role; }
      else if (sortField === "isActive") { av = a.isActive ? 1 : 0; bv = b.isActive ? 1 : 0; }
      else if (sortField === "createdAt") { av = new Date(a.createdAt).getTime(); bv = new Date(b.createdAt).getTime(); }
      else if (sortField === "lastSignedIn") { av = new Date(a.lastSignedIn).getTime(); bv = new Date(b.lastSignedIn).getTime(); }

      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });

    return list;
  }, [allUsers, search, roleFilter, statusFilter, sortField, sortDir]);

  // ── Stats ─────────────────────────────────────────────────────────────
  const totalActive = allUsers.filter((u) => u.isActive && u.name !== "[Deleted User]").length;
  const totalAdmins = allUsers.filter((u) => u.role === "admin" && u.name !== "[Deleted User]").length;
  const totalInactive = allUsers.filter((u) => !u.isActive && u.name !== "[Deleted User]").length;

  // ── Sort helper ───────────────────────────────────────────────────────
  function handleSort(field: SortField) {
    if (sortField === field) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortField(field); setSortDir("asc"); }
  }

  function SortIcon({ field }: { field: SortField }) {
    if (sortField !== field) return <ChevronsUpDown className="ml-1 h-3 w-3 opacity-40" />;
    return sortDir === "asc"
      ? <ChevronUp className="ml-1 h-3 w-3" />
      : <ChevronDown className="ml-1 h-3 w-3" />;
  }

  // ── Org name lookup ───────────────────────────────────────────────────
  const orgMap = useMemo(() => {
    const m: Record<number, string> = {};
    orgList.forEach((o) => { m[o.id] = o.name; });
    return m;
  }, [orgList]);

  // ── Confirm action ────────────────────────────────────────────────────
  function executeConfirm() {
    if (!confirmDialog) return;
    const { type, userId, newRole, newOrgId } = confirmDialog;
    if (type === "role" && newRole) updateRole.mutate({ userId, role: newRole });
    else if (type === "activate") toggleActive.mutate({ userId, isActive: true });
    else if (type === "deactivate") toggleActive.mutate({ userId, isActive: false });
    else if (type === "delete") deleteUser.mutate({ userId });
    else if (type === "org") updateOrg.mutate({ userId, organizationId: newOrgId ?? null });
  }

  const isPending =
    updateRole.isPending || toggleActive.isPending || deleteUser.isPending || updateOrg.isPending;

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">User Management</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage portal users, roles, and organisation assignments.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-2">
          <RefreshCw className="h-4 w-4" />
          Refresh
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-lg border bg-card p-4 flex items-center gap-3">
          <div className="rounded-full bg-blue-100 dark:bg-blue-900/30 p-2">
            <Users className="h-5 w-5 text-blue-600 dark:text-blue-400" />
          </div>
          <div>
            <p className="text-2xl font-bold">{totalActive}</p>
            <p className="text-xs text-muted-foreground">Active Users</p>
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4 flex items-center gap-3">
          <div className="rounded-full bg-purple-100 dark:bg-purple-900/30 p-2">
            <Shield className="h-5 w-5 text-purple-600 dark:text-purple-400" />
          </div>
          <div>
            <p className="text-2xl font-bold">{totalAdmins}</p>
            <p className="text-xs text-muted-foreground">Administrators</p>
          </div>
        </div>
        <div className="rounded-lg border bg-card p-4 flex items-center gap-3">
          <div className="rounded-full bg-red-100 dark:bg-red-900/30 p-2">
            <UserX className="h-5 w-5 text-red-600 dark:text-red-400" />
          </div>
          <div>
            <p className="text-2xl font-bold">{totalInactive}</p>
            <p className="text-xs text-muted-foreground">Inactive / Suspended</p>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by name or email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={roleFilter} onValueChange={(v) => setRoleFilter(v as any)}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="Role" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Roles</SelectItem>
            <SelectItem value="admin">Admin</SelectItem>
            <SelectItem value="user">User</SelectItem>
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as any)}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-sm text-muted-foreground ml-auto">
          {filtered.length} user{filtered.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Table */}
      <div className="rounded-lg border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead
                className="cursor-pointer select-none"
                onClick={() => handleSort("name")}
              >
                <span className="flex items-center">Name <SortIcon field="name" /></span>
              </TableHead>
              <TableHead
                className="cursor-pointer select-none"
                onClick={() => handleSort("email")}
              >
                <span className="flex items-center">Email <SortIcon field="email" /></span>
              </TableHead>
              <TableHead
                className="cursor-pointer select-none"
                onClick={() => handleSort("role")}
              >
                <span className="flex items-center">Role <SortIcon field="role" /></span>
              </TableHead>
              <TableHead>Organisation</TableHead>
              <TableHead
                className="cursor-pointer select-none"
                onClick={() => handleSort("isActive")}
              >
                <span className="flex items-center">Status <SortIcon field="isActive" /></span>
              </TableHead>
              <TableHead
                className="cursor-pointer select-none"
                onClick={() => handleSort("lastSignedIn")}
              >
                <span className="flex items-center">Last Sign-in <SortIcon field="lastSignedIn" /></span>
              </TableHead>
              <TableHead
                className="cursor-pointer select-none"
                onClick={() => handleSort("createdAt")}
              >
                <span className="flex items-center">Joined <SortIcon field="createdAt" /></span>
              </TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 8 }).map((_, j) => (
                    <TableCell key={j}>
                      <div className="h-4 bg-muted rounded animate-pulse w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-12 text-muted-foreground">
                  No users match your filters.
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((u) => {
                const isCurrentUser = u.id === currentUser?.id;
                return (
                  <TableRow key={u.id} className={!u.isActive ? "opacity-60" : ""}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-sm font-semibold text-primary shrink-0">
                          {(u.name ?? u.email ?? "?")[0].toUpperCase()}
                        </div>
                        <div>
                          <p className="font-medium text-sm leading-tight">
                            {u.name ?? "—"}
                            {isCurrentUser && (
                              <span className="ml-1 text-xs text-muted-foreground">(you)</span>
                            )}
                          </p>
                          {u.isGuest && (
                            <span className="text-xs text-amber-600 dark:text-amber-400">Guest</span>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {u.email ?? "—"}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={u.role === "admin" ? "default" : "secondary"}
                        className={
                          u.role === "admin"
                            ? "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300 border-0"
                            : ""
                        }
                      >
                        {u.role === "admin" ? (
                          <><Shield className="h-3 w-3 mr-1" />Admin</>
                        ) : (
                          "User"
                        )}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">
                      {u.organizationId ? (
                        <span className="flex items-center gap-1 text-muted-foreground">
                          <Building2 className="h-3 w-3" />
                          {orgMap[u.organizationId] ?? `Org #${u.organizationId}`}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/50 text-xs">None</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={u.isActive ? "outline" : "secondary"}
                        className={
                          u.isActive
                            ? "border-green-500 text-green-700 dark:text-green-400"
                            : "text-red-600 dark:text-red-400"
                        }
                      >
                        {u.isActive ? (
                          <><UserCheck className="h-3 w-3 mr-1" />Active</>
                        ) : (
                          <><UserX className="h-3 w-3 mr-1" />Inactive</>
                        )}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(u.lastSignedIn).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(u.createdAt).toLocaleDateString()}
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8" disabled={isCurrentUser}>
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-48">
                          {/* Role toggle */}
                          <DropdownMenuItem
                            onClick={() =>
                              setConfirmDialog({
                                type: "role",
                                userId: u.id,
                                userName: u.name ?? u.email ?? "this user",
                                newRole: u.role === "admin" ? "user" : "admin",
                              })
                            }
                          >
                            <Shield className="h-4 w-4 mr-2" />
                            {u.role === "admin" ? "Demote to User" : "Promote to Admin"}
                          </DropdownMenuItem>

                          {/* Org assignment */}
                          <DropdownMenuItem
                            onClick={() => {
                              setOrgDialog({
                                userId: u.id,
                                userName: u.name ?? u.email ?? "this user",
                                currentOrgId: u.organizationId ?? null,
                              });
                              setSelectedOrgId(u.organizationId ? String(u.organizationId) : "none");
                            }}
                          >
                            <Building2 className="h-4 w-4 mr-2" />
                            Assign Organisation
                          </DropdownMenuItem>

                          <DropdownMenuSeparator />

                          {/* Activate / Deactivate */}
                          {u.isActive ? (
                            <DropdownMenuItem
                              className="text-amber-600 dark:text-amber-400"
                              onClick={() =>
                                setConfirmDialog({
                                  type: "deactivate",
                                  userId: u.id,
                                  userName: u.name ?? u.email ?? "this user",
                                })
                              }
                            >
                              <UserX className="h-4 w-4 mr-2" />
                              Deactivate
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              className="text-green-600 dark:text-green-400"
                              onClick={() =>
                                setConfirmDialog({
                                  type: "activate",
                                  userId: u.id,
                                  userName: u.name ?? u.email ?? "this user",
                                })
                              }
                            >
                              <UserCheck className="h-4 w-4 mr-2" />
                              Activate
                            </DropdownMenuItem>
                          )}

                          <DropdownMenuSeparator />

                          {/* Delete */}
                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={() =>
                              setConfirmDialog({
                                type: "delete",
                                userId: u.id,
                                userName: u.name ?? u.email ?? "this user",
                              })
                            }
                          >
                            <Trash2 className="h-4 w-4 mr-2" />
                            Remove User
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Confirm Dialog */}
      <Dialog open={!!confirmDialog} onOpenChange={() => setConfirmDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmDialog?.type === "role" && `Change role for ${confirmDialog.userName}`}
              {confirmDialog?.type === "activate" && `Activate ${confirmDialog?.userName}`}
              {confirmDialog?.type === "deactivate" && `Deactivate ${confirmDialog?.userName}`}
              {confirmDialog?.type === "delete" && `Remove ${confirmDialog?.userName}`}
            </DialogTitle>
            <DialogDescription>
              {confirmDialog?.type === "role" &&
                `This will change the user's role to ${confirmDialog.newRole === "admin" ? "Administrator" : "User"}. Are you sure?`}
              {confirmDialog?.type === "activate" &&
                "This will restore the user's access to the portal."}
              {confirmDialog?.type === "deactivate" &&
                "This will suspend the user's access to the portal. They will not be able to log in."}
              {confirmDialog?.type === "delete" &&
                "This will permanently remove the user's account and clear their personal data. This action cannot be undone."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDialog(null)}>
              Cancel
            </Button>
            <Button
              variant={confirmDialog?.type === "delete" ? "destructive" : "default"}
              onClick={executeConfirm}
              disabled={isPending}
            >
              {isPending ? "Processing…" : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Org Assignment Dialog */}
      <Dialog open={!!orgDialog} onOpenChange={() => setOrgDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Assign Organisation</DialogTitle>
            <DialogDescription>
              Assign <strong>{orgDialog?.userName}</strong> to an organisation.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Label className="mb-2 block">Organisation</Label>
            <Select value={selectedOrgId} onValueChange={setSelectedOrgId}>
              <SelectTrigger>
                <SelectValue placeholder="Select organisation…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None (unassigned)</SelectItem>
                {orgList.map((o) => (
                  <SelectItem key={o.id} value={String(o.id)}>
                    {o.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOrgDialog(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!orgDialog) return;
                updateOrg.mutate({
                  userId: orgDialog.userId,
                  organizationId: selectedOrgId === "none" ? null : Number(selectedOrgId),
                });
              }}
              disabled={updateOrg.isPending}
            >
              {updateOrg.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
