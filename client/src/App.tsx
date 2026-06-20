import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
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
import EmailSettings from "./pages/EmailSettings";
import ApiIngestion from "./pages/ApiIngestion";
import SftpConfig from "./pages/SftpConfig";
import AnomalyDetection from "./pages/AnomalyDetection";
import CfoDashboard from "./pages/CfoDashboard";
import OperationsDashboard from "./pages/OperationsDashboard";
import AuditorDashboard from "./pages/AuditorDashboard";
import ModuleConfiguration from "./pages/ModuleConfiguration";
import SuperAgent from "./pages/SuperAgent";
import DemoDashboard from "./pages/DemoDashboard";
import DistributorRegistry from "./pages/DistributorRegistry";
import CorporateB2BLanding from "./pages/CorporateB2BLanding";
import BanksLanding from "./pages/BanksLanding";
import FinTechsLanding from "./pages/FinTechsLanding";
import PaymentProcessorsLanding from "./pages/PaymentProcessorsLanding";
import Documentation from "./pages/Documentation";
import DocViewer from "./pages/DocViewer";
import WoodcorePOC from "./pages/WoodcorePOC";
import LapoPOC from "./pages/LapoPOC";
import SharedReport from "./pages/SharedReport";
import SharedReportPublic from "./pages/SharedReportPublic";
import ComplianceAssessmentLanding from "./pages/ComplianceAssessmentLanding";
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

function DashboardPage({ component: Component }: { component: React.ComponentType }) {
  return (
    <DashboardLayout>
      <Component />
    </DashboardLayout>
  );
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
      <Route path="/anomalies">{() => <DashboardPage component={AnomalyDetection} />}</Route>
      <Route path="/email-settings">{() => <DashboardPage component={EmailSettings} />}</Route>
      <Route path="/modules">{() => <DashboardPage component={ModuleConfiguration} />}</Route>
      <Route path="/super-agent">{() => <DashboardPage component={SuperAgent} />}</Route>
      <Route path="/exception-intelligence">{() => <DashboardPage component={ExceptionIntelligence} />}</Route>
      <Route path="/age-tracker">{() => <DashboardPage component={AgeTracker} />}</Route>
      <Route path="/distributors">{() => <DashboardPage component={DistributorRegistry} />}</Route>
      <Route path="/demo-dashboard">{() => <DashboardPage component={DemoDashboard} />}</Route>
      <Route path="/woodcore-poc">{() => <PocAccessGate pocKey="woodcore"><WoodcorePOC /></PocAccessGate>}</Route>
      <Route path="/salad-africa-poc">{() => <PocAccessGate pocKey="salad_africa"><SaladAfricaPOC /></PocAccessGate>}</Route>
      <Route path="/lapo-poc">{() => <PocAccessGate pocKey="lapo_mfb"><LapoPOC /></PocAccessGate>}</Route>
      <Route path="/poc-report/:token" component={PocSharedReport} />
      <Route path="/admin/poc">{() => <DashboardPage component={PocHub} />}</Route>
      <Route path="/shared-report/:token" component={SharedReport} />
      <Route path="/r/:token" component={SharedReportPublic} />
      <Route path="/compliance-assessment" component={ComplianceAssessmentLanding} />
      <Route path="/compliance-assessment/quiz" component={ComplianceAssessmentQuiz} />
          <Route path="/compliance-assessment/unsubscribe/:token" component={ComplianceAssessmentUnsubscribe} />
          <Route path="/compliance-assessment/result/:token" component={ComplianceAssessmentResult} />
          <Route path="/admin/assessments" component={AdminAssessments} />
          <Route path="/admin/roadmap-access" component={AdminRoadmapAccess} />
          <Route path="/admin/users" component={AdminUsers} />
          <Route path="/admin/super-admin">{() => <DashboardPage component={SuperAdminDashboard} />}</Route>
          <Route path="/roadmap-access" component={RoadmapAccess} />
          <Route path="/roadmap" component={RoadmapViewer} />
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
