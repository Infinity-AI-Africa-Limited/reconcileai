import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Server, Plus, Trash2, CheckCircle2, XCircle, RefreshCw } from "lucide-react";

export default function SftpConfig() {
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    host: "",
    port: 22,
    username: "",
    password: "",
    remotePath: "/",
    filePattern: "*.csv",
    channelId: "",
    pollingEnabled: false,
    pollingIntervalMinutes: 60,
  });

  const { data: credentials, refetch } = trpc.sftp.list.useQuery();
  const { data: channels } = trpc.channels.list.useQuery();
  const createMutation = trpc.sftp.create.useMutation();
  const deleteMutation = trpc.sftp.delete.useMutation();

  const handleCreate = async () => {
    if (!formData.name || !formData.host || !formData.username || !formData.password || !formData.channelId) {
      toast.error("Please fill in all required fields");
      return;
    }

    try {
      await createMutation.mutateAsync({
        ...formData,
        channelId: parseInt(formData.channelId),
      });
      toast.success("SFTP credential created");
      setShowForm(false);
      setFormData({
        name: "",
        host: "",
        port: 22,
        username: "",
        password: "",
        remotePath: "/",
        filePattern: "*.csv",
        channelId: "",
        pollingEnabled: false,
        pollingIntervalMinutes: 60,
      });
      refetch();
    } catch (error: any) {
      toast.error(error.message || "Failed to create credential");
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this SFTP credential?")) return;
    
    try {
      await deleteMutation.mutateAsync({ id });
      toast.success("Credential deleted");
      refetch();
    } catch (error: any) {
      toast.error(error.message || "Failed to delete");
    }
  };

  return (
    <div className="container mx-auto py-8 space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">SFTP Configuration</h1>
          <p className="text-muted-foreground mt-2">
            Manage SFTP credentials for automated file ingestion
          </p>
        </div>
        <Button onClick={() => setShowForm(!showForm)}>
          <Plus className="w-4 h-4 mr-2" />
          Add Credential
        </Button>
      </div>

      {showForm && (
        <Card>
          <CardHeader>
            <CardTitle>New SFTP Credential</CardTitle>
            <CardDescription>Configure SFTP server connection</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="name">Name *</Label>
                <Input
                  id="name"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="channel">Channel *</Label>
                <Select value={formData.channelId} onValueChange={(v) => setFormData({ ...formData, channelId: v })}>
                  <SelectTrigger id="channel">
                    <SelectValue placeholder="Select channel" />
                  </SelectTrigger>
                  <SelectContent>
                    {channels?.map((ch: any) => (
                      <SelectItem key={ch.id} value={String(ch.id)}>
                        {ch.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="host">Host *</Label>
                <Input
                  id="host"
                  value={formData.host}
                  onChange={(e) => setFormData({ ...formData, host: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="port">Port</Label>
                <Input
                  id="port"
                  type="number"
                  value={formData.port}
                  onChange={(e) => setFormData({ ...formData, port: parseInt(e.target.value) })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="username">Username *</Label>
                <Input
                  id="username"
                  value={formData.username}
                  onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password *</Label>
                <Input
                  id="password"
                  type="password"
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="remotePath">Remote Path</Label>
                <Input
                  id="remotePath"
                  value={formData.remotePath}
                  onChange={(e) => setFormData({ ...formData, remotePath: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="filePattern">File Pattern</Label>
                <Input
                  id="filePattern"
                  value={formData.filePattern}
                  onChange={(e) => setFormData({ ...formData, filePattern: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pollingInterval">Polling Interval (minutes)</Label>
                <Input
                  id="pollingInterval"
                  type="number"
                  value={formData.pollingIntervalMinutes}
                  onChange={(e) => setFormData({ ...formData, pollingIntervalMinutes: parseInt(e.target.value) })}
                />
              </div>
              <div className="flex items-center space-x-2 pt-8">
                <Switch
                  id="pollingEnabled"
                  checked={formData.pollingEnabled}
                  onCheckedChange={(checked) => setFormData({ ...formData, pollingEnabled: checked })}
                />
                <Label htmlFor="pollingEnabled">Enable Polling</Label>
              </div>
            </div>
            <div className="flex gap-2">
              <Button onClick={handleCreate} disabled={createMutation.isPending}>
                {createMutation.isPending ? "Creating..." : "Create"}
              </Button>
              <Button variant="outline" onClick={() => setShowForm(false)}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4">
        {!credentials || credentials.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              <Server className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>No SFTP credentials configured</p>
            </CardContent>
          </Card>
        ) : (
          credentials.map((cred: any) => (
            <Card key={cred.id}>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle>{cred.name}</CardTitle>
                    <CardDescription>
                      {cred.username}@{cred.host}:{cred.port} → {cred.remotePath}
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-2">
                    {cred.pollingEnabled ? (
                      <Badge variant="default">
                        <RefreshCw className="w-3 h-3 mr-1" />
                        Polling ({cred.pollingIntervalMinutes}m)
                      </Badge>
                    ) : (
                      <Badge variant="secondary">Manual</Badge>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(cred.id)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-3 gap-4 text-sm">
                  <div>
                    <span className="text-muted-foreground">Files Processed:</span>
                    <span className="ml-2 font-medium">{cred.totalFilesProcessed || 0}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Last Success:</span>
                    <span className="ml-2 font-medium">
                      {cred.lastSuccessAt ? new Date(cred.lastSuccessAt).toLocaleString() : "Never"}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Pattern:</span>
                    <span className="ml-2 font-mono text-xs">{cred.filePattern}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
