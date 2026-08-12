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
import { useOrgSegment } from "@/hooks/useOrgSegment";
import { isRetailCommerce, type Segment } from "@/lib/segments";
import { navGroup, isStaff, type NavEntry } from "@/lib/navItems";
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
import { FlaskConical, X, Share2, Check, LayoutGrid, Database, ChevronDown, FileBarChart2, LogIn, LogOut as ExitIcon, Clock, Map } from "lucide-react";
import { usePortalContext, SEGMENT_LABELS, SEGMENT_COLORS, type OrgSegment } from "@/contexts/PortalContext";

type NavItem = NavEntry & { icon: React.ElementType };

// Path -> icon. The entries themselves live in lib/navItems (one list, shared
// by the normal sidebar and the portal sidebar). Icons stay here because they
// are React components and would make that module untestable under the
// node-environment vitest config. navItems.test asserts this map is complete,
// so a new entry cannot ship without one.
const NAV_ICONS: Record<string, React.ElementType> = {
  "/dashboard": LayoutDashboard,
  "/super-agent": Sparkles,
  "/exception-intelligence": Network,
  "/demo-dashboard": LayoutGrid,
  "/distributors": Building2,
  "/settlement-monitor": TrendingUp,
  "/shopline/sync-status": Activity,
  "/shopline/connect": Plug,
  "/upload": Upload,
  "/reconciliation": GitCompare,
  "/reports": FileText,
  "/schedules": Calendar,
  "/monitor": Activity,
  "/documentation": BookOpen,
  "/channels": Layers,
  "/exceptions": AlertTriangle,
  "/age-tracker": Clock,
  "/transactions": Search,
  "/review": ClipboardList,
  "/audit": Shield,
  "/compliance": ShieldCheck,
  "/cbn-compliance": FileBarChart2,
  "/admin/users": Users,
  "/admin/assessments": ClipboardCheck,
  "/modules": Settings2,
  "/email-settings": Mail,
  "/sample-data": Beaker,
  "/integrations": Plug,
  "/woodcore-connector": Plug,
  "/api-ingestion": Code,
  "/sftp-config": Server,
  "/bucket-config": Server,
  "/email-forwarding": Mail,
  "/anomalies": AlertTriangle,
  "/admin/super-admin": Globe,
  "/admin/super-admin/orgs": Network,
  "/admin/super-admin/users": Users,
  "/admin/super-admin/analytics": BarChart3,
  "/admin/poc": FlaskConical,
  "/admin/roadmap-access": Map,
};

/** Attach the icon a NavEntry needs to render. */
function withIcon(entry: NavEntry): NavItem {
  return { ...entry, icon: NAV_ICONS[entry.path] ?? LayoutDashboard };
}

// Role and segment gating live in lib/navItems, applied by navGroup().

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
  const segment = useOrgSegment();

  // The Auditor view is examination-facing: it reports audit-trail volume and a
  // "compliance rate" framed for a regulated institution's examiner, and its
  // sibling procedure feeds the CBN pack. Retail merchants answer to card
  // schemes and gateway agreements, not an examiner (CLAUDE.md §2A). CFO and
  // Operations do carry over — "did the money arrive" and "what is unresolved"
  // are universal.
  //
  // Written as a negation on purpose, unlike the dashboard badges: while the
  // segment is still resolving this stays true, so a loading state never removes
  // navigation from someone entitled to it. Hiding a menu item for a frame is a
  // worse trade than briefly showing one.
  const showAuditorView = !isRetailCommerce(segment);

  const dashboardRoutes = [
    { label: "Main", path: "/dashboard", icon: LayoutDashboard },
    { label: "CFO", path: "/dashboard/cfo", icon: TrendingUp },
    { label: "Operations", path: "/dashboard/operations", icon: ClipboardList },
    ...(showAuditorView
      ? [{ label: "Auditor", path: "/dashboard/auditor", icon: Shield }]
      : []),
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
  const { viewAsOrg, isViewingAs, exitPortal } = usePortalContext();
  // The caller's own vertical, used to filter the DEFAULT nav below. The curated
  // per-segment lists only apply inside a portal, so without this a merchant
  // logging in normally saw entries built for other verticals.
  const segment = useOrgSegment();

  // One source (lib/navItems) drives BOTH sidebars. Previously the portal used
  // curated per-segment arrays while everyone else used a role-filtered default
  // set, and the two drifted — the retail portal list held /settlement-monitor,
  // /shopline/sync-status and /shopline/connect, which appeared in no other
  // list, so a real merchant never saw the screen their vertical is built on.
  //
  // In portal mode role gating is dropped (staff are inspecting the tenant's
  // surface, not exercising their own permissions) but segment gating stays,
  // which is the whole point of entering a portal.
  const navOpts = { portal: isViewingAs && viewAsOrg !== null };
  const visibleMenuItems = navGroup("main", segment, user?.role, navOpts).map(withIcon);
  const visibleAdminItems = navGroup("admin", segment, user?.role, navOpts).map(withIcon);
  const visibleAdvancedItems = navGroup("advanced", segment, user?.role, navOpts).map(withIcon);
  const visibleSuperAdminItems = navGroup("superAdmin", segment, user?.role, navOpts).map(withIcon);
  const allItems = [...visibleMenuItems, ...visibleAdminItems, ...visibleSuperAdminItems];
  // Match the current path segment-aware and prefer the most specific (longest) match,
  // so nested routes like /admin/super-admin/orgs resolve to "All Organisations" rather
  // than the parent "Platform Overview" (/admin/super-admin).
  const matchesPath = (path: string) => location === path || location.startsWith(path + "/");
  const activeMenuItem = allItems
    .filter((item) => matchesPath(item.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  // The single active super-admin route (most specific match wins).
  const activeSuperAdminPath = visibleSuperAdminItems
    .filter((item) => matchesPath(item.path))
    .sort((a, b) => b.path.length - a.path.length)[0]?.path;
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
  // Data-residency posture — surfaces an "On-Premise" badge so the customer's
  // security team can visually confirm external egress is enforced.
  const { data: residency } = trpc.system.residencyStatus.useQuery(undefined, {
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
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
  const [showAdmin, setShowAdmin] = useState(true);
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
                  {isViewingAs && viewAsOrg ? (
                    <div className="flex flex-col min-w-0">
                      <span className="font-bold tracking-tight truncate text-sidebar-foreground text-sm leading-tight">
                        {viewAsOrg.name.replace(" (Demo)", "")}
                      </span>
                      <span className={`text-[10px] font-medium truncate ${SEGMENT_COLORS[viewAsOrg.segment as OrgSegment]?.text ?? "text-sidebar-foreground/60"}`}>
                        {SEGMENT_LABELS[viewAsOrg.segment as OrgSegment] ?? viewAsOrg.segment}
                      </span>
                    </div>
                  ) : (
                    <span className="font-bold tracking-tight truncate text-sidebar-foreground text-lg">
                      ReconcileAI
                    </span>
                  )}
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

            {(visibleAdminItems.length > 0 || visibleAdvancedItems.length > 0) && (
              <>
                <div className="px-4 py-4 mt-2">
                  <div className="h-px bg-sidebar-border" />
                </div>
                {visibleAdminItems.length > 0 && (
                  <>
                    {!isCollapsed ? (
                      <button
                        onClick={() => setShowAdmin((v) => !v)}
                        className="w-full flex items-center justify-between px-4 pb-2 pt-1 group"
                      >
                        <span className="text-xs font-semibold text-sidebar-foreground/60 uppercase tracking-wider group-hover:text-sidebar-foreground/80 transition-colors">
                          Admin
                        </span>
                        <ChevronDown
                          className={`h-3 w-3 text-sidebar-foreground/40 transition-transform group-hover:text-sidebar-foreground/60 ${showAdmin ? "" : "-rotate-90"}`}
                        />
                      </button>
                    ) : <div className="pb-1" />}
                    {(showAdmin || isCollapsed) && (
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
                      </SidebarMenu>
                    )}
                  </>
                )}
                {/* Advanced Tools — shown for normal users when admin items exist, OR always shown in Financial Services portal */}
                {visibleAdvancedItems.length > 0 && (
                  <SidebarMenu className="px-2 py-0">
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
                    {(showAdvanced || isCollapsed) && visibleAdvancedItems.map((item) => {
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
                )}
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
                    const isActive = item.path === activeSuperAdminPath;
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
            {/* Demo Mode Toggle — Infinity AI staff only.
                This rendered for every signed-in user, so a bank administrator
                saw "Demo Mode: OFF" in their sidebar and one click seeded
                fabricated BrightGoods FMCG data into their live tenant. Keyed on
                the super_admin ROLE, matching navItems' `staffOnly` and the
                server's superAdminProcedure, which now guards the mutations. */}
            {isStaff(user?.role) ? (
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
            ) : null}
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
              {residency?.enforced && (
                <span
                  className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
                  title={`On-premise mode — external egress blocked.${residency.egressAllowlist?.length ? ` Allowlist: ${residency.egressAllowlist.join(", ")}` : ""}`}
                >
                  <ShieldCheck className="h-3 w-3" /> On-Premise · Egress Blocked
                </span>
              )}
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
        {/* Portal Context Banner — shown when super_admin is viewing as another org */}
        {isViewingAs && viewAsOrg && (() => {
          const seg = viewAsOrg.segment as OrgSegment;
          const colors = SEGMENT_COLORS[seg];
          return (
            <div className={`sticky top-14 z-30 flex items-center gap-3 ${colors.bg} border-b ${colors.border} px-6 py-2.5`}>
              <LogIn className={`h-4 w-4 shrink-0 ${colors.text}`} />
              <p className={`text-xs flex-1 ${colors.text}`}>
                <span className="font-semibold">Viewing as portal:</span>{" "}
                <span className="font-bold">{viewAsOrg.name.replace(" (Demo)", "")}</span>
                {" "}&middot;{" "}
                <span className="font-medium">{SEGMENT_LABELS[seg]}</span>
                {" "}&middot;{" "}
                <span className="opacity-75">{viewAsOrg.code}</span>
              </p>
              <button
                onClick={() => { exitPortal(); setLocation("/admin/super-admin"); }}
                className={`flex items-center gap-1.5 text-xs font-semibold ${colors.text} hover:opacity-80 transition-opacity whitespace-nowrap`}
              >
                <ExitIcon className="h-3.5 w-3.5" />
                Exit Portal
              </button>
            </div>
          );
        })()}
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
