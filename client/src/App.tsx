import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Redirect, Route, Switch, useLocation } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { useOrgSegmentStatus } from "@/hooks/useOrgSegment";
import { usePortalContext } from "@/contexts/PortalContext";
import { canReachCallback, canReachPath, landingPathFor } from "@/lib/routeAccess";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import DashboardLayout from "./components/DashboardLayout";
import Dashboard from "./pages/Dashboard";
import Upload from "./pages/Upload";
import Reconciliation from "./pages/Reconciliation";
import Exceptions from "./pages/Exceptions";
import Transactions from "./pages/Transactions";
import ReviewQueue from "./pages/ReviewQueue";
import AuditTrail from "./pages/AuditTrail";
import Compliance from "./pages/Compliance";
import MultiChannel from "./pages/MultiChannel";
import Reports from "./pages/Reports";
import Admin from "./pages/Admin";
import SampleData from "./pages/SampleData";
import Integrations from "./pages/Integrations";
import Schedules from "./pages/Schedules";
import Monitor from "./pages/Monitor";
import ExceptionIntelligence from "./pages/ExceptionIntelligence";
import SaladAfricaPOC from "./pages/SaladAfricaPOC";
import AgeTracker from "./pages/AgeTracker";
import PocHub from "./pages/PocHub";
import PocSharedReport from "./pages/PocSharedReport";
import PocAccessGate from "./components/PocAccessGate";
import TechnicalHandover from "./pages/TechnicalHandover";
import EmailSettings from "./pages/EmailSettings";
import ApiIngestion from "./pages/ApiIngestion";
import SftpConfig from "./pages/SftpConfig";
import BucketConfig from "./pages/BucketConfig";
import EmailForwarding from "./pages/EmailForwarding";
import WoodcoreConnector from "./pages/WoodcoreConnector";
import AnomalyDetection from "./pages/AnomalyDetection";
import CfoDashboard from "./pages/CfoDashboard";
import OperationsDashboard from "./pages/OperationsDashboard";
import AuditorDashboard from "./pages/AuditorDashboard";
import ModuleConfiguration from "./pages/ModuleConfiguration";
import SuperAgent from "./pages/SuperAgent";
import DemoDashboard from "./pages/DemoDashboard";
import DistributorRegistry from "./pages/DistributorRegistry";
import CorporateB2BPilotControls from "./pages/CorporateB2BPilotControls";
import CorporateB2BLanding from "./pages/CorporateB2BLanding";
import BanksLanding from "./pages/BanksLanding";
import FinTechsLanding from "./pages/FinTechsLanding";
import PaymentProcessorsLanding from "./pages/PaymentProcessorsLanding";
import Documentation from "./pages/Documentation";
import DocViewer from "./pages/DocViewer";
import WoodcorePOC from "./pages/WoodcorePOC";
import LapoPOC from "./pages/LapoPOC";
import MobileMoneyPOC from "./pages/MobileMoneyPOC";
import DeploymentRunbook from "./pages/DeploymentRunbook";
import SharedReport from "./pages/SharedReport";
import SharedReportPublic from "./pages/SharedReportPublic";
import ComplianceAssessmentLanding from "./pages/ComplianceAssessmentLanding";
import RoiCalculator from "./pages/RoiCalculator";
import ComplianceAssessmentQuiz from "./pages/ComplianceAssessmentQuiz";
import ComplianceAssessmentResult from "./pages/ComplianceAssessmentResult";
import AdminAssessments from "./pages/AdminAssessments";
import RoadmapAccess from "./pages/RoadmapAccess";
import RoadmapViewer from "./pages/RoadmapViewer";
import AdminRoadmapAccess from "./pages/AdminRoadmapAccess";
import AdminUsers from "./pages/AdminUsers";
import ReportDetail from "./pages/ReportDetail";
import ComplianceAssessmentUnsubscribe from "./pages/ComplianceAssessmentUnsubscribe";
import CBNCompliance from "./pages/CBNCompliance";
import MagicLogin from "./pages/MagicLogin";
import Login from "./pages/Login";
import SuperAdminDashboard from "./pages/SuperAdminDashboard";
import { ShoplineWelcome, ShoplineError } from "./pages/ShoplineConnect";
import Privacy from "./pages/Privacy";
import Terms from "./pages/Terms";
import Support from "./pages/Support";
import SettlementMonitor from "./pages/SettlementMonitor";
import ShoplineSyncStatus from "./pages/ShoplineSyncStatus";

/**
 * Send a viewer to the page their vertical actually starts from.
 *
 * Waits for the segment before deciding. Redirecting on the pending value would
 * put every merchant on /dashboard for a frame and then move them, which reads
 * as a glitch — and on a slow connection, as the wrong landing page.
 */
function LandingRedirect() {
  const { segment, isPending } = useOrgSegmentStatus();
  if (isPending) {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground">
        Loading your workspace…
      </div>
    );
  }
  return <Redirect to={landingPathFor(segment)} />;
}

/**
 * Keep a vertical out of routes built for another one.
 *
 * The sidebar already hides them; this stops the URL working anyway. Before it,
 * a merchant typing /distributors got the page shell and then a screenful of
 * permission errors from the server — technically guarded, practically broken.
 *
 * Every hook runs before the redirect, never after: `segment` arrives from a
 * query, so an early return placed between hooks changes how many run between
 * the first and second render — "Rendered fewer hooks than expected", which is
 * exactly how the auditor page once crashed on a cold load.
 *
 * Pending means undecided, not denied. Redirecting while the segment is still
 * in flight would bounce people out of pages they are entitled to.
 *
 * That now covers the ROLE as well as the segment. `canReachPath` refuses a
 * role-scoped path when the role is undefined, and `auth.me` resolves on its own
 * schedule — so waiting only on the segment query would redirect a legitimate
 * admin off their own page for the width of one request, then leave them on the
 * landing page wondering. Both answers have to be in before a decision is made.
 *
 * `portal` is passed for the same reason DashboardLayout passes it to navGroup:
 * inside a tenant portal a super admin is looking at the TENANT's surface, so
 * the tenant's segment rules apply. Without it the sidebar hid Distributor
 * Registry from a retail portal while /distributors still loaded.
 */
function SegmentGuard({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { segment, isPending } = useOrgSegmentStatus();
  const { user, loading: authLoading } = useAuth();
  const { viewAsOrg } = usePortalContext();

  const opts = { portal: viewAsOrg !== null };
  const undecided = isPending || authLoading;
  const blocked = !undecided && !canReachPath(location, segment, user?.role, opts);
  if (blocked) return <Redirect to={landingPathFor(segment)} />;
  return <>{children}</>;
}

function DashboardPage({ component: Component }: { component: React.ComponentType }) {
  return (
    <DashboardLayout>
      <SegmentGuard>
        <Component />
      </SegmentGuard>
    </DashboardLayout>
  );
}

/**
 * A standalone OAuth landing, kept out of the dashboard chrome on purpose.
 *
 * The same ShoplineWelcome component is ALSO mounted at /shopline/connect through
 * DashboardPage, so it was guarded by one path and wide open on the other: a bank
 * could open /shopline/welcome — or wouter's aliases /SHOPLINE/WELCOME/ — and be
 * congratulated on connecting a store it does not have.
 *
 * Not DashboardPage, because SHOPLINE's redirect carries no session and the
 * dashboard requires one. `canReachCallback` refuses only a resolved other
 * vertical, so the signed-out merchant this page exists for still arrives.
 *
 * The segment lookup is gated on being signed in, and that gate is load-bearing
 * rather than an optimisation. `auth.mySegment` is a protectedProcedure, and
 * main.tsx redirects the browser to /login on ANY unauthorized query error — so
 * simply asking for the segment without a session would throw the merchant onto
 * a login page for an account they do not have yet. Guarding the route must not
 * cost more than the thing it guards against.
 *
 * That gate is also why this guard has to wait for `auth.me` explicitly.
 * `isAuthenticated` is false while the session is still loading, which switches
 * the segment query OFF — and a disabled query reports a RESOLVED null, not a
 * pending one (see useOrgSegmentStatus, where that is deliberate). So without
 * the wait the sequence is: auth loading -> signedIn:false -> the signed-out
 * exception applies -> a signed-in bank user is shown the retail "Store
 * Connected" screen -> auth resolves -> they are redirected away. Deciding on
 * `signedIn` before knowing whether they are signed in is the bug.
 */
function CallbackGuard({ component: Component }: { component: React.ComponentType }) {
  const [location] = useLocation();
  const { user, isAuthenticated, loading: authLoading, error: authError } = useAuth();
  const { segment, isPending } = useOrgSegmentStatus({ enabled: isAuthenticated });
  const { viewAsOrg } = usePortalContext();

  // The exception is earned by CONFIRMING there is no session — not by the
  // absence of one being reported.
  //
  // `auth.me` is a publicProcedure returning `ctx.user`, so a signed-out
  // visitor gets a clean `null` and no error. An error therefore never means
  // "signed out"; it means the question was not answered. But `useAuth` folds
  // both into `isAuthenticated: false` with `loading: false`, and taking that
  // at face value hands the retail completion screen to a signed-in bank whose
  // lookup happened to fail — the same "absence is not evidence" mistake the
  // segment half of this function already guards against, one layer up.
  //
  // With `retry: false` that is not a flicker either: one failed request and
  // the answer stays wrong for the life of the page.
  const signedOutConfirmed = !authLoading && !authError && !isAuthenticated;
  const opts = { portal: viewAsOrg !== null, signedIn: !signedOutConfirmed };

  const undecided = authLoading || isPending;
  const blocked = !undecided && !canReachCallback(location, segment, user?.role, opts);
  if (blocked) return <Redirect to={landingPathFor(segment)} />;
  // Render nothing while undecided. The signed-out merchant this page exists
  // for resolves in one tick; showing them the completion screen a frame early
  // is not worth showing it to everyone else too.
  if (undecided) return null;
  return <Component />;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/banks" component={BanksLanding} />
      <Route path="/corporate-b2b" component={CorporateB2BLanding} />
      <Route path="/fintechs" component={FinTechsLanding} />
      <Route path="/payment-processors" component={PaymentProcessorsLanding} />
      <Route path="/docs/:docName" component={DocViewer} />
      <Route path="/documentation">{() => <DashboardPage component={Documentation} />}</Route>
      {/* Post-login target. Resolves to the vertical's own starting page, so the
          server does not need to know about segments to send someone somewhere
          sensible — and /dashboard stays directly reachable for everyone. */}
      <Route path="/home" component={LandingRedirect} />
      <Route path="/dashboard">{() => <DashboardPage component={Dashboard} />}</Route>
      <Route path="/dashboard/cfo">{() => <DashboardPage component={CfoDashboard} />}</Route>
      <Route path="/dashboard/operations">{() => <DashboardPage component={OperationsDashboard} />}</Route>
      <Route path="/dashboard/auditor">{() => <DashboardPage component={AuditorDashboard} />}</Route>
      <Route path="/upload">{() => <DashboardPage component={Upload} />}</Route>
      <Route path="/reconciliation">{() => <DashboardPage component={Reconciliation} />}</Route>
      <Route path="/exceptions">{() => <DashboardPage component={Exceptions} />}</Route>
      <Route path="/transactions">{() => <DashboardPage component={Transactions} />}</Route>
      <Route path="/review">{() => <DashboardPage component={ReviewQueue} />}</Route>
      <Route path="/audit">{() => <DashboardPage component={AuditTrail} />}</Route>
      <Route path="/compliance">{() => <DashboardPage component={Compliance} />}</Route>
      <Route path="/cbn-compliance">{() => <DashboardPage component={CBNCompliance} />}</Route>
      <Route path="/channels">{() => <DashboardPage component={MultiChannel} />}</Route>
      <Route path="/reports">{() => <DashboardPage component={Reports} />}</Route>
      <Route path="/reports/:id">{() => <DashboardPage component={ReportDetail} />}</Route>
      <Route path="/admin">{() => <DashboardPage component={Admin} />}</Route>
      <Route path="/sample-data">{() => <DashboardPage component={SampleData} />}</Route>
      <Route path="/integrations">{() => <DashboardPage component={Integrations} />}</Route>
      <Route path="/schedules">{() => <DashboardPage component={Schedules} />}</Route>
      <Route path="/monitor">{() => <DashboardPage component={Monitor} />}</Route>
      <Route path="/api-ingestion">{() => <DashboardPage component={ApiIngestion} />}</Route>
      <Route path="/sftp-config">{() => <DashboardPage component={SftpConfig} />}</Route>
      <Route path="/bucket-config">{() => <DashboardPage component={BucketConfig} />}</Route>
      <Route path="/email-forwarding">{() => <DashboardPage component={EmailForwarding} />}</Route>
      <Route path="/woodcore-connector">{() => <DashboardPage component={WoodcoreConnector} />}</Route>
      <Route path="/anomalies">{() => <DashboardPage component={AnomalyDetection} />}</Route>
      <Route path="/email-settings">{() => <DashboardPage component={EmailSettings} />}</Route>
      <Route path="/modules">{() => <DashboardPage component={ModuleConfiguration} />}</Route>
      <Route path="/super-agent">{() => <DashboardPage component={SuperAgent} />}</Route>
      <Route path="/exception-intelligence">{() => <DashboardPage component={ExceptionIntelligence} />}</Route>
      <Route path="/age-tracker">{() => <DashboardPage component={AgeTracker} />}</Route>
      <Route path="/distributors">{() => <DashboardPage component={DistributorRegistry} />}</Route>
      <Route path="/corporate-pilot-controls">{() => <DashboardPage component={CorporateB2BPilotControls} />}</Route>
      <Route path="/demo-dashboard">{() => <DashboardPage component={DemoDashboard} />}</Route>
      <Route path="/woodcore-poc">{() => <PocAccessGate pocKey="woodcore"><WoodcorePOC /></PocAccessGate>}</Route>
      <Route path="/salad-africa-poc">{() => <PocAccessGate pocKey="salad_africa"><SaladAfricaPOC /></PocAccessGate>}</Route>
      <Route path="/lapo-poc">{() => <PocAccessGate pocKey="lapo_mfb"><LapoPOC /></PocAccessGate>}</Route>
      <Route path="/mobile-money-poc">{() => <PocAccessGate pocKey="lapo_mfb"><MobileMoneyPOC pocSlug="lapo_mfb" /></PocAccessGate>}</Route>
      <Route path="/technical-handover">{() => <PocAccessGate pocKey="technical_handover" title="Protected document" subtitle="This technical handover is invite-only. Enter the access code from your invitation link to continue."><TechnicalHandover /></PocAccessGate>}</Route>
      <Route path="/deployment-runbook">{() => <PocAccessGate pocKey="deployment_runbook"><DeploymentRunbook /></PocAccessGate>}</Route>
      <Route path="/poc-report/:token" component={PocSharedReport} />
      <Route path="/admin/poc">{() => <DashboardPage component={PocHub} />}</Route>
      <Route path="/shared-report/:token" component={SharedReport} />
      <Route path="/r/:token" component={SharedReportPublic} />
      <Route path="/roi-calculator" component={RoiCalculator} />
      <Route path="/compliance-assessment" component={ComplianceAssessmentLanding} />
      <Route path="/compliance-assessment/quiz" component={ComplianceAssessmentQuiz} />
          <Route path="/compliance-assessment/unsubscribe/:token" component={ComplianceAssessmentUnsubscribe} />
          <Route path="/compliance-assessment/result/:token" component={ComplianceAssessmentResult} />
          <Route path="/admin/assessments" component={AdminAssessments} />
          <Route path="/admin/roadmap-access" component={AdminRoadmapAccess} />
          <Route path="/admin/users" component={AdminUsers} />
          <Route path="/admin/super-admin">{() => <DashboardPage component={SuperAdminDashboard} />}</Route>
          <Route path="/admin/super-admin/orgs">{() => <DashboardPage component={SuperAdminDashboard} />}</Route>
          <Route path="/admin/super-admin/users">{() => <DashboardPage component={SuperAdminDashboard} />}</Route>
          <Route path="/admin/super-admin/analytics">{() => <DashboardPage component={SuperAdminDashboard} />}</Route>
          <Route path="/roadmap-access" component={RoadmapAccess} />
          <Route path="/roadmap" component={RoadmapViewer} />
      <Route path="/settlement-monitor">{() => <DashboardPage component={SettlementMonitor} />}</Route>
      <Route path="/shopline/sync-status">{() => <DashboardPage component={ShoplineSyncStatus} />}</Route>
      <Route path="/shopline/connect">{() => <DashboardPage component={ShoplineWelcome} />}</Route>
      {/* Install callbacks: standalone pages, deliberately NOT wrapped in
          DashboardPage. SHOPLINE redirects here without a session, so the
          dashboard's authentication would lock out the merchant this exists
          for. CallbackGuard turns away a signed-in OTHER vertical instead. */}
      <Route path="/shopline/welcome">{() => <CallbackGuard component={ShoplineWelcome} />}</Route>
      <Route path="/shopline/error">{() => <CallbackGuard component={ShoplineError} />}</Route>
      <Route path="/privacy" component={Privacy} />
      <Route path="/terms" component={Terms} />
      <Route path="/support" component={Support} />
      <Route path="/login" component={Login} />
      <Route path="/magic-login" component={MagicLogin} />
      <Route path="/404" component={NotFound} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
