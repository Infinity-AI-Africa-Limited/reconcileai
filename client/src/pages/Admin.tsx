import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Users, Shield, UserCog } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/_core/hooks/useAuth";

export default function AdminPage() {
  const { user: currentUser } = useAuth();
  const { data: users, isLoading, refetch } = trpc.admin.users.useQuery();
  const updateRoleMutation = trpc.admin.updateRole.useMutation();

  const handleRoleChange = async (userId: number, role: "user" | "admin") => {
    try {
      await updateRoleMutation.mutateAsync({ userId, role });
      toast.success("User role updated");
      refetch();
    } catch (err: any) {
      toast.error(err.message || "Failed to update role");
    }
  };

  if (currentUser?.role !== "admin") {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh]">
        <Shield className="h-16 w-16 text-muted-foreground mb-4" />
        <h2 className="text-xl font-bold">Access Denied</h2>
        <p className="text-muted-foreground mt-2">You need admin privileges to access this page.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-primary">User Management</h1>
        <p className="text-muted-foreground mt-1">Manage users and role-based access control</p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-32"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : users && users.length > 0 ? (
        <Card>
          <CardContent className="pt-6">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-3 px-3 font-medium text-muted-foreground">User</th>
                    <th className="text-left py-3 px-3 font-medium text-muted-foreground">Email</th>
                    <th className="text-left py-3 px-3 font-medium text-muted-foreground">Role</th>
                    <th className="text-left py-3 px-3 font-medium text-muted-foreground">Last Sign In</th>
                    <th className="text-left py-3 px-3 font-medium text-muted-foreground">Joined</th>
                    <th className="text-right py-3 px-3 font-medium text-muted-foreground">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u: any) => (
                    <tr key={u.id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="py-3 px-3">
                        <div className="flex items-center gap-2">
                          <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
                            <span className="text-xs font-bold text-primary">{u.name?.charAt(0)?.toUpperCase() || "U"}</span>
                          </div>
                          <span className="font-medium">{u.name || "Unknown"}</span>
                        </div>
                      </td>
                      <td className="py-3 px-3 text-muted-foreground">{u.email || "-"}</td>
                      <td className="py-3 px-3">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
                          u.role === "admin" ? "bg-primary/10 text-primary" : "bg-gray-100 text-gray-700"
                        }`}>
                          {u.role === "admin" ? "Admin" : "User"}
                        </span>
                      </td>
                      <td className="py-3 px-3 text-xs text-muted-foreground">{new Date(u.lastSignedIn).toLocaleString()}</td>
                      <td className="py-3 px-3 text-xs text-muted-foreground">{new Date(u.createdAt).toLocaleDateString()}</td>
                      <td className="py-3 px-3 text-right">
                        {u.id !== currentUser?.id ? (
                          <Select value={u.role} onValueChange={(v) => handleRoleChange(u.id, v as "user" | "admin")}>
                            <SelectTrigger className="w-24 h-8 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="user">User</SelectItem>
                              <SelectItem value="admin">Admin</SelectItem>
                            </SelectContent>
                          </Select>
                        ) : (
                          <span className="text-xs text-muted-foreground">You</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Users className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="font-semibold text-lg">No Users</h3>
            <p className="text-muted-foreground text-sm mt-1">Users will appear here once they sign in.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
