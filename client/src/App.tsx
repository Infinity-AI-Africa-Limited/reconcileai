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
import MultiChannel from "./pages/MultiChannel";
import Reports from "./pages/Reports";
import Admin from "./pages/Admin";
import SampleData from "./pages/SampleData";
import Integrations from "./pages/Integrations";
import Schedules from "./pages/Schedules";
import Monitor from "./pages/Monitor";
import EmailSettings from "./pages/EmailSettings";
import ApiIngestion from "./pages/ApiIngestion";
import SftpConfig from "./pages/SftpConfig";
import AnomalyDetection from "./pages/AnomalyDetection";

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
      <Route path="/dashboard">{() => <DashboardPage component={Dashboard} />}</Route>
      <Route path="/upload">{() => <DashboardPage component={Upload} />}</Route>
      <Route path="/reconciliation">{() => <DashboardPage component={Reconciliation} />}</Route>
      <Route path="/exceptions">{() => <DashboardPage component={Exceptions} />}</Route>
      <Route path="/transactions">{() => <DashboardPage component={Transactions} />}</Route>
      <Route path="/review">{() => <DashboardPage component={ReviewQueue} />}</Route>
      <Route path="/audit">{() => <DashboardPage component={AuditTrail} />}</Route>
      <Route path="/channels">{() => <DashboardPage component={MultiChannel} />}</Route>
      <Route path="/reports">{() => <DashboardPage component={Reports} />}</Route>
      <Route path="/admin">{() => <DashboardPage component={Admin} />}</Route>
      <Route path="/sample-data">{() => <DashboardPage component={SampleData} />}</Route>
      <Route path="/integrations">{() => <DashboardPage component={Integrations} />}</Route>
      <Route path="/schedules">{() => <DashboardPage component={Schedules} />}</Route>
      <Route path="/monitor">{() => <DashboardPage component={Monitor} />}</Route>
      <Route path="/api-ingestion">{() => <DashboardPage component={ApiIngestion} />}</Route>
      <Route path="/sftp-config">{() => <DashboardPage component={SftpConfig} />}</Route>
      <Route path="/anomalies">{() => <DashboardPage component={AnomalyDetection} />}</Route>
      <Route path="/email-settings">{() => <DashboardPage component={EmailSettings} />}</Route>
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
