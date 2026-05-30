import { useAuth } from "@/_core/hooks/useAuth";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { getLoginUrl } from "@/const";
import { useIsMobile } from "@/hooks/useMobile";
import {
  LayoutDashboard,
  LogOut,
  PanelLeft,
  Upload,
  GitCompare,
  AlertTriangle,
  FileText,
  Search,
  ClipboardList,
  Shield,
  Users,
  Layers,
  Beaker,
  Plug,
  Calendar,
  Activity,
  Mail,
  Code,
  Server,
  TrendingUp,
  Settings2,
  BookOpen,
  Sparkles,
  Building2,
  ShieldCheck,
  ClipboardCheck,
  Globe,
  BarChart3,
  Network,
} from "lucide-react";
import { CSSProperties, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { DashboardLayoutSkeleton } from "./DashboardLayoutSkeleton";
import { Button } from "./ui/button";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { FlaskConical, X, Share2, Check, LayoutGrid, Database, ChevronDown, FileBarChart2 } from "lucide-react";

type NavItem = { icon: React.ElementType; label: string; path: string; roles?: string[]; segments?: string[] };

// roles: admin | cfo | operations | compliance | user | super_admin
// segments: financial_services | corporate_b2b | super_admin (org segment gate)
// If roles is omitted, item is visible to ALL roles.
// If segments is omitted, item is visible across ALL segments.
const menuItems: NavItem[] = [
  { icon: LayoutDashboard, label: "Dashboard", path: "/dashboard" },
  { icon: Sparkles, label: "Super Agent", path: "/super-agent" },
  { icon: LayoutGrid, label: "Demo Dashboard", path: "/demo-dashboard" },
  { icon: Database, label: "Woodcore POC", path: "/woodcore-poc" },
  { icon: Building2, label: "Distributor Registry", path: "/distributors" },
  // Upload & Reconciliation: admin + operations only
  { icon: Upload, label: "Upload Data", path: "/upload", roles: ["admin", "operations"] },
  { icon: GitCompare, label: "Reconciliation", path: "/reconciliation", roles: ["admin", "operations"] },
  { icon: FileText, label: "Reports", path: "/reports" },
  { icon: Calendar, label: "Schedules", path: "/schedules", roles: ["admin", "operations"] },
  { icon: Activity, label: "Monitor", path: "/monitor" },
  { icon: BookOpen, label: "Documentation", path: "/documentation" },
];

const adminMenuItems: NavItem[] = [
  { icon: Layers, label: "Multi-Channel", path: "/channels", roles: ["admin", "operations"] },
  { icon: AlertTriangle, label: "Exceptions", path: "/exceptions", roles: ["admin", "operations"] },
  { icon: Search, label: "Transactions", path: "/transactions", roles: ["admin", "operations"] },
  { icon: ClipboardList, label: "Review Queue", path: "/review", roles: ["admin", "operations"] },
  // Audit Trail: admin + compliance + cfo
  { icon: Shield, label: "Audit Trail", path: "/audit", roles: ["admin", "compliance", "cfo"] },
  { icon: ShieldCheck, label: "Data Protection", path: "/compliance", roles: ["admin", "compliance"] },
  { icon: FileBarChart2, label: "CBN Reports", path: "/cbn-compliance", roles: ["admin", "compliance", "cfo"] },
  // User Management: admin only
  { icon: Users, label: "User Management", path: "/admin/users", roles: ["admin"] },
  { icon: ClipboardCheck, label: "Assessments", path: "/admin/assessments", roles: ["admin"] },
  { icon: Settings2, label: "Module Configuration", path: "/modules", roles: ["admin"] },
  { icon: Mail, label: "Email Settings", path: "/email-settings", roles: ["admin"] },
];

const adminAdvancedItems: NavItem[] = [
  { icon: Beaker, label: "Sample Data", path: "/sample-data", roles: ["admin"] },
  { icon: Plug, label: "Integrations", path: "/integrations", roles: ["admin"] },
  { icon: Code, label: "API Ingestion", path: "/api-ingestion", roles: ["admin"] },
  { icon: Server, label: "SFTP Config", path: "/sftp-config", roles: ["admin"] },
  { icon: AlertTriangle, label: "Anomaly Detection", path: "/anomalies", roles: ["admin"] },
];

// Super Admin items — only visible to super_admin role (Infinity AI staff)
const superAdminItems: NavItem[] = [
  { icon: Globe, label: "Platform Overview", path: "/admin/super-admin", roles: ["super_admin"] },
  { icon: Network, label: "All Organisations", path: "/admin/super-admin/orgs", roles: ["super_admin"] },
  { icon: Users, label: "All Users", path: "/admin/super-admin/users", roles: ["super_admin"] },
  { icon: BarChart3, label: "Platform Analytics", path: "/admin/super-admin/analytics", roles: ["super_admin"] },
];

function canAccessNav(item: NavItem, userRole: string | undefined): boolean {
  if (!item.roles) return true;
  if (!userRole) return false;
  // super_admin can see everything (except super_admin-only items are still gated)
  if (userRole === "super_admin" && !item.roles.includes("super_admin")) return true;
  return item.roles.includes(userRole);
}

const SIDEBAR_WIDTH_KEY = "sidebar-width";
const DEFAULT_WIDTH = 260;
const MIN_WIDTH = 200;
const MAX_WIDTH = 400;

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    return saved ? parseInt(saved, 10) : DEFAULT_WIDTH;
  });
  const { loading, user } = useAuth();

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, sidebarWidth.toString());
  }, [sidebarWidth]);

  if (loading) {
    return <DashboardLayoutSkeleton />;
  }

  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="flex flex-col items-center gap-8 p-8 max-w-md w-full">
          <div className="flex flex-col items-center gap-4">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-primary flex items-center justify-center">
                <GitCompare className="h-5 w-5 text-primary-foreground" />
              </div>
              <span className="text-2xl font-bold tracking-tight text-primary">
                ReconcileAI
              </span>
            </div>
            <p className="text-sm text-muted-foreground text-center max-w-sm">
              Intelligent financial reconciliation powered by AI. Sign in to
              access your dashboard.
            </p>
          </div>
          <Button
            onClick={() => {
              window.location.href = getLoginUrl();
            }}
            size="lg"
            className="w-full shadow-lg hover:shadow-xl transition-all"
          >
            Sign in to continue
          </Button>
        </div>
      </div>
    );
  }

  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": `${sidebarWidth}px`,
        } as CSSProperties
      }
    >
      <DashboardLayoutContent setSidebarWidth={setSidebarWidth}>
        {children}
      </DashboardLayoutContent>
    </SidebarProvider>
  );
}

type DashboardLayoutContentProps = {
  children: React.ReactNode;
  setSidebarWidth: (width: number) => void;
};

function RoleSwitcher({ location, setLocation }: { location: string; setLocation: (path: string) => void }) {
  const dashboardRoutes = [
    { label: "Main", path: "/dashboard", icon: LayoutDashboard },
    { label: "CFO", path: "/dashboard/cfo", icon: TrendingUp },
    { label: "Operations", path: "/dashboard/operations", icon: ClipboardList },
    { label: "Auditor", path: "/dashboard/auditor", icon: Shield },
  ];

  const currentRoute = dashboardRoutes.find(r => location === r.path) || dashboardRoutes[0];
  const CurrentIcon = currentRoute.icon;

  // Only show role switcher on dashboard routes
  if (!location.startsWith("/dashboard")) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <CurrentIcon className="h-4 w-4" />
          <span className="hidden sm:inline">{currentRoute.label} View</span>
          <span className="sm:hidden">{currentRoute.label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {dashboardRoutes.map((route) => {
          const Icon = route.icon;
          return (
            <DropdownMenuItem
              key={route.path}
              onClick={() => setLocation(route.path)}
              className="cursor-pointer"
            >
              <Icon className="mr-2 h-4 w-4" />
              <span>{route.label} Dashboard</span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DashboardLayoutContent({
  children,
  setSidebarWidth,
}: DashboardLayoutContentProps) {
  const { user, logout } = useAuth();
  const [location, setLocation] = useLocation();
  const { state, toggleSidebar } = useSidebar();
  const isCollapsed = state === "collapsed";
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const visibleMenuItems = menuItems.filter(item => canAccessNav(item, user?.role));
  const visibleAdminItems = adminMenuItems.filter(item => canAccessNav(item, user?.role));
  const visibleAdvancedItems = adminAdvancedItems.filter(item => canAccessNav(item, user?.role));
  const visibleSuperAdminItems = superAdminItems.filter(item => canAccessNav(item, user?.role));
  const allItems = [...visibleMenuItems, ...visibleAdminItems, ...visibleSuperAdminItems];
  const activeMenuItem = allItems.find((item) => location.startsWith(item.path));
  const isMobile = useIsMobile();

  // Demo Mode
  // For guest users: the shared pre-warmed demo user already has data seeded at deploy time,
  // so demo.status returns active:true immediately — no polling needed.
  // We keep a short poll (3 attempts) as a safety net for the rare cold-start fallback path.
  const isGuest = (user as { isGuest?: boolean } | null)?.isGuest === true;
  const [seedingComplete, setSeedingComplete] = useState(false);
  const [pollCount, setPollCount] = useState(0);
  const MAX_POLL_ATTEMPTS = 3; // safety net for cold-start fallback only
  const { data: demoStatus, refetch: refetchDemoStatus } = trpc.demo.status.useQuery(undefined, {
    enabled: !!user,
    // Poll only if guest, data not yet active, and we haven't exceeded the safety-net limit
    refetchInterval: (isGuest && !seedingComplete && pollCount < MAX_POLL_ATTEMPTS) ? 5000 : false,
  });
  // Stop polling once demo data is confirmed active for guest; increment poll counter
  useEffect(() => {
    if (!isGuest || seedingComplete) return;
    if (demoStatus?.active) {
      setSeedingComplete(true);
    } else {
      setPollCount(c => c + 1);
    }
  }, [isGuest, demoStatus?.active, seedingComplete]);
  const [activatedMatchRate, setActivatedMatchRate] = useState<string | null>(null);
  const [guestLinkCopied, setGuestLinkCopied] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showInfinityAI, setShowInfinityAI] = useState(false);

  // Today's open exception count for sidebar badges — stable Date objects via useState
  const [badgeDateFrom] = useState(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; });
  const [badgeDateTo] = useState(() => { const d = new Date(); d.setHours(23, 59, 59, 999); return d; });
  const { data: todayExceptions } = trpc.exceptions.list.useQuery(
    { status: "open", dateFrom: badgeDateFrom, dateTo: badgeDateTo, limit: 1, offset: 0 },
    { enabled: !!user && user.role === "admin", refetchInterval: 60000 }
  );
  const openExceptionCount = todayExceptions?.total ?? 0;
  const activateDemo = trpc.demo.activate.useMutation({
    onSuccess: (data) => {
      const mr = (data as { matchRate?: string })?.matchRate ?? "90.00";
      setActivatedMatchRate(mr);
      toast.success("Demo Mode activated", { description: `BrightGoods FMCG data loaded — 60 txns, 6 exceptions, 15 distributors, 12 memory records. Match rate: ${mr}%` });
      refetchDemoStatus();
    },
    onError: (err) => toast.error("Demo activation failed", { description: err.message }),
  });
  const deactivateDemo = trpc.demo.deactivate.useMutation({
    onSuccess: () => {
      setActivatedMatchRate(null);
      toast.success("Demo Mode deactivated", { description: "All demo data has been removed." });
      refetchDemoStatus();
    },
    onError: (err) => toast.error("Demo deactivation failed", { description: err.message }),
  });
  const createGuestLink = trpc.demo.createGuestLink.useMutation({
    onSuccess: (data) => {
      const url = (data as { url?: string })?.url ?? "";
      if (url) {
        navigator.clipboard.writeText(url).then(() => {
          setGuestLinkCopied(true);
          setTimeout(() => setGuestLinkCopied(false), 3000);
          toast.success("Demo link copied!", { description: `Valid for 7 days. Share with prospects.` });
        });
      }
    },
    onError: (err) => toast.error("Failed to create demo link", { description: err.message }),
  });
  const isDemoActive = demoStatus?.active ?? false;
  const isTogglingDemo = activateDemo.isPending || deactivateDemo.isPending;

  useEffect(() => {
    if (isCollapsed) {
      setIsResizing(false);
    }
  }, [isCollapsed]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      const sidebarLeft =
        sidebarRef.current?.getBoundingClientRect().left ?? 0;
      const newWidth = e.clientX - sidebarLeft;
      if (newWidth >= MIN_WIDTH && newWidth <= MAX_WIDTH) {
        setSidebarWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    }

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing, setSidebarWidth]);

  return (
    <>
      <div className="relative" ref={sidebarRef}>
        <Sidebar collapsible="icon" className="border-r-0" disableTransition={isResizing}>
          <SidebarHeader className="h-16 justify-center">
            <div className="flex items-center gap-3 px-2 transition-all w-full">
              <button
                onClick={toggleSidebar}
                className="h-8 w-8 flex items-center justify-center hover:bg-sidebar-accent rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring shrink-0"
                aria-label="Toggle navigation"
              >
                <PanelLeft className="h-4 w-4 text-sidebar-foreground/70" />
              </button>
              {!isCollapsed ? (
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-bold tracking-tight truncate text-sidebar-foreground text-lg">
                    ReconcileAI
                  </span>
                </div>
              ) : null}
            </div>
          </SidebarHeader>

          <SidebarContent className="gap-0 flex-1 min-h-0 overflow-y-auto">
            <SidebarMenu className="px-2 py-1">
              {visibleMenuItems.map((item) => {
                const isActive = location.startsWith(item.path);
                return (
                  <SidebarMenuItem key={item.path}>
                    <SidebarMenuButton
                      isActive={isActive}
                      onClick={() => setLocation(item.path)}
                      tooltip={item.label}
                      className="h-8 transition-all font-normal"
                    >
                      <span className="flex items-center justify-center w-4 h-4 shrink-0">
                        <item.icon className={`h-4 w-4 ${isActive ? "text-sidebar-primary" : ""}`} />
                      </span>
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>

            {visibleAdminItems.length > 0 && (
              <>
                <div className="px-4 py-4 mt-2">
                  <div className="h-px bg-sidebar-border" />
                </div>
                <div className="px-4 pb-2 pt-1">
                  {!isCollapsed && (
                    <span className="text-xs font-semibold text-sidebar-foreground/60 uppercase tracking-wider">
                      Admin
                    </span>
                  )}
                </div>
                <SidebarMenu className="px-2 py-0">
                  {visibleAdminItems.map((item) => {
                    const isActive = location.startsWith(item.path);
                    const showBadge = openExceptionCount > 0 && (item.path === "/exceptions" || item.path === "/review");
                    return (
                      <SidebarMenuItem key={item.path}>
                        <SidebarMenuButton
                          isActive={isActive}
                          onClick={() => setLocation(item.path)}
                          tooltip={item.label}
                          className="h-8 transition-all font-normal"
                        >
                          <span className="flex items-center justify-center w-4 h-4 shrink-0">
                            <item.icon className={`h-4 w-4 ${isActive ? "text-sidebar-primary" : ""}`} />
                          </span>
                          <span className="flex-1">{item.label}</span>
                          {showBadge && !isCollapsed && (
                            <span className="ml-auto min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center leading-none">
                              {openExceptionCount > 99 ? "99+" : openExceptionCount}
                            </span>
                          )}
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                  {/* Advanced toggle */}
                  {!isCollapsed && (
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        onClick={() => setShowAdvanced((v) => !v)}
                        className="h-8 transition-all font-normal text-sidebar-foreground/50 hover:text-sidebar-foreground/80"
                      >
                        <ChevronDown
                          className={`h-3.5 w-3.5 transition-transform ${showAdvanced ? "rotate-180" : ""}`}
                        />
                        <span className="text-xs">{showAdvanced ? "Hide advanced" : "Advanced tools"}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )}
                  {showAdvanced && visibleAdvancedItems.map((item) => {
                    const isActive = location.startsWith(item.path);
                    return (
                      <SidebarMenuItem key={item.path}>
                        <SidebarMenuButton
                          isActive={isActive}
                          onClick={() => setLocation(item.path)}
                          tooltip={item.label}
                          className="h-8 transition-all font-normal pl-6"
                        >
                          <span className="flex items-center justify-center w-4 h-4 shrink-0">
                            <item.icon className={`h-3.5 w-3.5 ${isActive ? "text-sidebar-primary" : "text-sidebar-foreground/60"}`} />
                          </span>
                          <span className="text-sidebar-foreground/70">{item.label}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </>
            )}
            {visibleSuperAdminItems.length > 0 && (
              <>
                <div className="px-4 py-4 mt-2">
                  <div className="h-px bg-sidebar-border" />
                </div>
                <SidebarMenu className="px-2 py-0">
                  {/* Infinity AI toggle — mirrors the Advanced tools pattern */}
                  {!isCollapsed && (
                    <SidebarMenuItem>
                      <SidebarMenuButton
                        onClick={() => setShowInfinityAI((v) => !v)}
                        className="h-8 transition-all font-normal text-violet-500/70 hover:text-violet-500"
                      >
                        <ChevronDown
                          className={`h-3.5 w-3.5 transition-transform ${showInfinityAI ? "rotate-180" : ""}`}
                        />
                        <span className="text-xs font-semibold uppercase tracking-wider">{showInfinityAI ? "Hide Infinity AI" : "Infinity AI"}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )}
                  {showInfinityAI && visibleSuperAdminItems.map((item) => {
                    const isActive = location.startsWith(item.path);
                    return (
                      <SidebarMenuItem key={item.path}>
                        <SidebarMenuButton
                          isActive={isActive}
                          onClick={() => setLocation(item.path)}
                          tooltip={item.label}
                          className="h-8 transition-all font-normal pl-6"
                        >
                          <span className="flex items-center justify-center w-4 h-4 shrink-0">
                            <item.icon className={`h-3.5 w-3.5 ${isActive ? "text-violet-500" : "text-violet-400/70"}`} />
                          </span>
                          <span className="text-violet-700 dark:text-violet-300">{item.label}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </>
            )}
          </SidebarContent>

          <SidebarFooter className="p-3 shrink-0 border-t border-sidebar-border">
            {/* Demo Mode Toggle */}
            <div className="mb-2 group-data-[collapsible=icon]:hidden">
              <button
                onClick={() => isDemoActive ? deactivateDemo.mutate() : activateDemo.mutate({ segment: "fmcg" })}
                disabled={isTogglingDemo}
                className={`w-full flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-all ${
                  isDemoActive
                    ? "bg-amber-500/15 text-amber-600 border border-amber-500/30 hover:bg-amber-500/25"
                    : "bg-sidebar-accent/40 text-sidebar-foreground/60 border border-sidebar-border hover:bg-sidebar-accent/70"
                } disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                <FlaskConical className="h-3.5 w-3.5 shrink-0" />
                <span className="flex-1 text-left">
                  {isTogglingDemo ? (isDemoActive ? "Removing..." : "Loading demo...") : (isDemoActive ? "Demo Mode: ON" : "Demo Mode: OFF")}
                </span>
                {isDemoActive && !isTogglingDemo && (
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                )}
              </button>
              {isDemoActive && demoStatus && (
                <div className="mt-1 px-3 py-1.5 rounded-md bg-amber-500/10 border border-amber-500/20 space-y-1.5">
                  <p className="text-[10px] text-amber-600/80 leading-relaxed">
                    {demoStatus.transactionCount} txns · {demoStatus.exceptionCount} exceptions · {demoStatus.distributorCount} distributors
                  </p>
                  {activatedMatchRate && (
                    <p className="text-[10px] font-semibold text-amber-700">Auto-match rate: {activatedMatchRate}%</p>
                  )}
                  {/* Switch Segment */}
                  <div className="flex gap-1 pt-0.5">
                    <button
                      onClick={() => { if (demoStatus.segment !== "fmcg") activateDemo.mutate({ segment: "fmcg" }); }}
                      disabled={isTogglingDemo}
                      className={`flex-1 text-[10px] font-medium rounded px-1.5 py-1 transition-all disabled:opacity-50 ${
                        demoStatus.segment === "fmcg" || !demoStatus.segment
                          ? "bg-amber-500 text-white"
                          : "bg-amber-500/10 text-amber-700 hover:bg-amber-500/20"
                      }`}
                    >
                      FMCG
                    </button>
                    <button
                      onClick={() => { if (demoStatus.segment !== "finserv") activateDemo.mutate({ segment: "finserv" }); }}
                      disabled={isTogglingDemo}
                      className={`flex-1 text-[10px] font-medium rounded px-1.5 py-1 transition-all disabled:opacity-50 ${
                        demoStatus.segment === "finserv"
                          ? "bg-amber-500 text-white"
                          : "bg-amber-500/10 text-amber-700 hover:bg-amber-500/20"
                      }`}
                    >
                      FinServ
                    </button>
                  </div>
                  <button
                    onClick={() => createGuestLink.mutate({ label: demoStatus.segment === "finserv" ? "FinServ Demo" : "BrightGoods Demo" })}
                    disabled={createGuestLink.isPending}
                    className="w-full flex items-center gap-1.5 text-[10px] text-amber-700 hover:text-amber-900 font-medium transition-colors disabled:opacity-50"
                  >
                    {guestLinkCopied ? <Check className="h-3 w-3" /> : <Share2 className="h-3 w-3" />}
                    {guestLinkCopied ? "Link copied to clipboard!" : createGuestLink.isPending ? "Generating link..." : "Share demo link"}
                  </button>
                </div>
              )}
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-3 rounded-lg px-1 py-1 hover:bg-sidebar-accent/50 transition-colors w-full text-left group-data-[collapsible=icon]:justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <Avatar className="h-9 w-9 border border-sidebar-border shrink-0">
                    <AvatarFallback className="text-xs font-medium bg-sidebar-primary text-sidebar-primary-foreground">
                      {user?.name?.charAt(0).toUpperCase() || "U"}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0 group-data-[collapsible=icon]:hidden">
                    <p className="text-sm font-medium truncate leading-none text-sidebar-foreground">
                      {user?.name || "-"}
                    </p>
                    <p className="text-xs text-sidebar-foreground/60 truncate mt-1.5">
                      {{ super_admin: "Infinity AI Staff", admin: "Administrator", cfo: "CFO", operations: "Operations User", compliance: "Compliance / Audit", user: "User" }[user?.role ?? "user"] ?? "User"}
                    </p>
                  </div>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem className="cursor-pointer text-muted-foreground">
                  <span className="text-xs">{user?.email || "-"}</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={logout}
                  className="cursor-pointer text-destructive focus:text-destructive"
                >
                  <LogOut className="mr-2 h-4 w-4" />
                  <span>Sign out</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarFooter>
        </Sidebar>
        <div
          className={`absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-sidebar-primary/20 transition-colors ${isCollapsed ? "hidden" : ""}`}
          onMouseDown={() => {
            if (isCollapsed) return;
            setIsResizing(true);
          }}
          style={{ zIndex: 50 }}
        />
      </div>

      <SidebarInset>
        {isMobile && (
          <div className="flex border-b h-14 items-center justify-between bg-background/95 px-2 backdrop-blur supports-[backdrop-filter]:backdrop-blur sticky top-0 z-40">
            <div className="flex items-center gap-2">
              <SidebarTrigger className="h-9 w-9 rounded-lg bg-background" />
              <div className="flex items-center gap-3">
                <div className="flex flex-col gap-1">
                  <span className="tracking-tight text-foreground font-medium">
                    {activeMenuItem?.label ?? "ReconcileAI"}
                  </span>
                </div>
              </div>
            </div>
            <RoleSwitcher location={location} setLocation={setLocation} />
          </div>
        )}
        {!isMobile && (
          <div className="flex border-b h-14 items-center justify-between bg-background/95 px-6 backdrop-blur supports-[backdrop-filter]:backdrop-blur sticky top-0 z-40">
            <div className="flex items-center gap-2">
              <span className="tracking-tight text-foreground font-medium text-lg">
                {activeMenuItem?.label ?? "ReconcileAI"}
              </span>
            </div>
            <RoleSwitcher location={location} setLocation={setLocation} />
          </div>
        )}
        {isGuest && !isDemoActive && !seedingComplete && (
          <div className="sticky top-14 z-30 flex items-center gap-3 bg-blue-50 dark:bg-blue-950/30 border-b border-blue-200 dark:border-blue-800 px-6 py-2.5">
            <div className="h-4 w-4 rounded-full border-2 border-blue-500 border-t-transparent animate-spin shrink-0" />
            <p className="text-xs text-blue-700 dark:text-blue-400 flex-1">
              <span className="font-semibold">Loading demo data…</span> Setting up BrightGoods FMCG + all 8 banking channels in the background. This takes about 30–60 seconds. The page will update automatically.
            </p>
          </div>
        )}
        {isDemoActive && (
          <div className="sticky top-14 z-30 flex items-center gap-3 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-800 px-6 py-2.5">
            <FlaskConical className="h-4 w-4 text-amber-600 shrink-0" />
            <p className="text-xs text-amber-700 dark:text-amber-400 flex-1">
              <span className="font-semibold">Demo Mode active.</span> Viewing {demoStatus?.segment === "both" ? "BrightGoods FMCG + Financial Services (8 banking channels)" : demoStatus?.segment === "finserv" ? "Financial Services (LapoMFB + Renmoney — 8 banking channels)" : "BrightGoods FMCG"} demo data — {demoStatus?.transactionCount ?? 0} transactions, {demoStatus?.exceptionCount ?? 0} exceptions. This is not real data.
            </p>
            <button
              onClick={() => setLocation("/demo-dashboard")}
              className="text-xs font-semibold text-amber-700 hover:text-amber-900 underline underline-offset-2 transition-colors whitespace-nowrap"
            >
              View Demo Dashboard →
            </button>
            <button
              onClick={() => deactivateDemo.mutate()}
              disabled={isTogglingDemo}
              className="text-amber-600 hover:text-amber-800 transition-colors disabled:opacity-50 ml-1"
              title="Deactivate Demo Mode"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        <main className="flex-1 p-6">{children}</main>
      </SidebarInset>
    </>
  );
}
