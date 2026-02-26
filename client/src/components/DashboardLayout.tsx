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
} from "lucide-react";
import { CSSProperties, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { DashboardLayoutSkeleton } from "./DashboardLayoutSkeleton";
import { Button } from "./ui/button";

const menuItems = [
  { icon: LayoutDashboard, label: "Dashboard", path: "/dashboard" },
  { icon: Upload, label: "Upload Data", path: "/upload" },
  { icon: GitCompare, label: "Reconciliation", path: "/reconciliation" },
  { icon: Layers, label: "Multi-Channel", path: "/channels" },
  { icon: AlertTriangle, label: "Exceptions", path: "/exceptions" },
  { icon: Search, label: "Transactions", path: "/transactions" },
  { icon: ClipboardList, label: "Review Queue", path: "/review" },
  { icon: Shield, label: "Audit Trail", path: "/audit" },
  { icon: FileText, label: "Reports", path: "/reports" },
  { icon: Calendar, label: "Schedules", path: "/schedules" },
  { icon: Activity, label: "Monitor", path: "/monitor" },
  { icon: Mail, label: "Email Settings", path: "/email-settings" },
  { icon: Beaker, label: "Sample Data", path: "/sample-data" },
  { icon: Plug, label: "Integrations", path: "/integrations" },
  { icon: Code, label: "API Ingestion", path: "/api-ingestion" },
  { icon: Server, label: "SFTP Config", path: "/sftp-config" },
  { icon: AlertTriangle, label: "Anomaly Detection", path: "/anomalies" },
  { icon: BookOpen, label: "Documentation", path: "/documentation" },
];

const adminMenuItems = [
  { icon: Users, label: "User Management", path: "/admin/users" },
  { icon: Settings2, label: "Module Configuration", path: "/modules" },
];

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
  const allItems = user?.role === "admin" ? [...menuItems, ...adminMenuItems] : menuItems;
  const activeMenuItem = allItems.find((item) => location.startsWith(item.path));
  const isMobile = useIsMobile();

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

          <SidebarContent className="gap-0">
            <SidebarMenu className="px-2 py-1">
              {menuItems.map((item) => {
                const isActive = location.startsWith(item.path);
                return (
                  <SidebarMenuItem key={item.path}>
                    <SidebarMenuButton
                      isActive={isActive}
                      onClick={() => setLocation(item.path)}
                      tooltip={item.label}
                      className="h-10 transition-all font-normal"
                    >
                      <item.icon
                        className={`h-4 w-4 ${isActive ? "text-sidebar-primary" : ""}`}
                      />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>

            {user?.role === "admin" && (
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
                  {adminMenuItems.map((item) => {
                    const isActive = location.startsWith(item.path);
                    return (
                      <SidebarMenuItem key={item.path}>
                        <SidebarMenuButton
                          isActive={isActive}
                          onClick={() => setLocation(item.path)}
                          tooltip={item.label}
                          className="h-10 transition-all font-normal"
                        >
                          <item.icon
                            className={`h-4 w-4 ${isActive ? "text-sidebar-primary" : ""}`}
                          />
                          <span>{item.label}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </>
            )}
          </SidebarContent>

          <SidebarFooter className="p-3">
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
                      {user?.role === "admin" ? "Administrator" : "User"}
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
        <main className="flex-1 p-6">{children}</main>
      </SidebarInset>
    </>
  );
}
